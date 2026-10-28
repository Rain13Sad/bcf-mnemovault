/**
 * 存储层（对应 §8.3 / §8.4 / §8.5 / §14.11）
 *
 * 两个驱动，同一接口：
 *   SqliteStore —— 默认。node:sqlite（Node ≥ 22.5，零原生依赖）+ WAL + BEGIN IMMEDIATE。
 *   MemoryStore —— 测试与浏览器预览用。语义一致，不落盘。
 *
 * 一条设计选择：cell 同时存**二进制 blob（MC02）**与**可查询列**。
 *   - blob 是布局的唯一事实，字段按偏移寻址（§6.1）；
 *   - 列只为索引与 WHERE 服务，永远是 blob 的派生投影。
 * 这样"改了布局"只有一个地方要改，且校验（magic/version/crc）在读取时必然发生。
 *
 * 与文档的一处偏差：`cell_id` 在 SQL 里存 TEXT（16 位 hex）。
 * JS 的 number 装不下 u64，node:sqlite 的 BigInt 绑定在 rc 间不稳定；
 * 用 hex 文本做 PK 既精确又免去精度事故，排序改按 t_from。
 */

import { decodeCell, encodeCell, type CellRow, type MemCell, type Edge } from './cell.js'
import { compress, decompress } from './codec.js'
import { bytesToHex, toHex } from './hash.js'
import type { SdrSpace } from './sdr.js'

export interface CellFilter {
  kind?: number
  kinds?: number[]
  lens?: string
  tier?: number
  since?: number
  until?: number
  limit?: number
  order?: 'recent' | 'oldest'
}

export interface EdgeRecord {
  src: bigint
  dst: bigint
  rel: number
  weight: number
}

export interface EvictRecord {
  cellId: string
  mode: 'soft' | 'hard'
  reason: string
  actor: 'user' | 'admin' | 'policy'
  at: number
}

export interface LogEntry {
  session: string
  seq: number
  turn: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  at: number
}

export interface SnapshotRecord {
  snapId: string
  rendered: string
  tokens: number
  created: number
}

export interface Store {
  readonly kind: 'sqlite' | 'memory'
  open(): void
  close(): void

  putCell(cell: MemCell): void
  getCell(id: bigint): MemCell | null
  deleteCell(id: bigint): void
  listCells(filter?: CellFilter): MemCell[]
  countCells(): number
  /** 全量遍历（召回候选池用；索引只负责把候选缩小，最终仍要精确算分）。 */
  forEachCell(fn: (c: MemCell) => void): void

  putEdge(e: EdgeRecord): void
  edgesFrom(id: bigint): EdgeRecord[]
  edgesTo(id: bigint): EdgeRecord[]
  allEdges(): EdgeRecord[]
  setEdgeWeight(src: bigint, dst: bigint, rel: number, weight: number): void
  deleteEdge(src: bigint, dst: bigint, rel: number): void

  putResidual(sha: Uint8Array, raw: Uint8Array): number
  getResidual(off: number): Uint8Array | null
  residualRefs(sha: Uint8Array): number
  addResidualRef(sha: Uint8Array): void

  putSource(cellId: bigint, session: string, seq: number): void
  sourcesOf(cellId: bigint): Array<{ session: string; seq: number }>
  cellsOfSession(session: string): bigint[]

  putSnapshot(rendered: string, tokens: number): string
  getSnapshot(snapId: string): SnapshotRecord | null

  shadowSeqs(session: string, seqs: number[]): void
  isShadowed(session: string, seq: number): boolean

  appendEvict(rec: EvictRecord): void
  recentEvicts(n: number): EvictRecord[]

  meta(key: string): string | null
  setMeta(key: string, value: string): void

  /** 会话日志影子副本（重建晶格的依据，§14.11） */
  appendLog(entry: LogEntry): void
  listLog(session?: string): LogEntry[]
  /**
   * 清空晶格但保留 session_log 与 residuals —— rebuild 的前置动作。
   * `preserveKinds` 默认保留人格锚/关系/图式（kind 3/4/5）：
   * 它们不是从对话日志派生的，抹掉等于让"这个人是谁"归零。
   */
  clearLattice(preserveKinds?: number[]): void

  /** BEGIN IMMEDIATE 语义的单写事务。读侧不进事务（WAL 快照）。 */
  write<T>(fn: () => T): T
  stats(): { cells: number; edges: number; residuals: number; bytes: number; rawBytes?: number }
}

const idKey = (id: bigint) => toHex(id, 16)

/** node:sqlite 是内置模块，但 ESM 里没有 require。getBuiltinModule 是同步且不污染全局的取法。 */
function builtin<T>(name: string): T {
  const g = (process as unknown as { getBuiltinModule?: (n: string) => unknown }).getBuiltinModule
  if (typeof g === 'function') return g(name) as T
  throw new Error(`当前 Node 不支持 process.getBuiltinModule，无法加载 ${name}（需要 Node ≥ 22.3）`)
}

function rowFromCell(c: MemCell): CellRow {
  const blob = encodeCell(c)
  return {
    cell_id: idKey(c.cellId),
    kind: c.kind,
    tier: c.tier,
    flags: c.flags,
    t_from: Number(c.tFrom),
    t_to: Number(c.tTo),
    t_ingest: Number(c.tIngest),
    t_access: Number(c.tAccess),
    access_cnt: c.accessCount,
    stability: c.stability,
    importance: c.importance,
    valence: c.valence,
    arousal: c.arousal,
    dominance: c.dominance,
    salience: c.salience,
    provenance: c.provenance,
    trust: c.trust,
    sdr: new Uint8Array(0), // blob 是权威，列不重复存 SDR
    emb: c.emb ? new Uint8Array(c.emb.buffer, c.emb.byteOffset, c.emb.length).slice() : null,
    slots: new Uint8Array(0),
    residual_sha: c.residual ? c.residual.sha : null,
    residual_off: c.residual ? Number(c.residual.off) : 0,
    residual_len: c.residual ? c.residual.rawLen : 0,
    confidence: c.confidence,
    support: c.support,
    topic: c.topic,
    digest: c.digest ?? '',
    t_invalid: Number(c.tInvalid ?? 0),
    scope: c.scope ?? 'user:local',
    session: c.session ?? '',
    lens: c.lens ?? 'fact',
    // 额外字段：blob
    ...({ blob } as object),
  } as CellRow & { blob: Uint8Array }
}

// ─────────────────────────────────────────────────────────────────────
// MemoryStore
// ─────────────────────────────────────────────────────────────────────

export class MemoryStore implements Store {
  readonly kind = 'memory' as const
  private cells = new Map<string, MemCell>()
  private edgeList: EdgeRecord[] = []
  private residuals: Array<{ codec: string; bytes: Uint8Array; rawLen: number }> = []
  private refs = new Map<string, number>()
  private sources = new Map<string, Array<{ session: string; seq: number }>>()
  private snaps = new Map<string, SnapshotRecord>()
  private shadow = new Set<string>()
  private evicts: EvictRecord[] = []
  private kv = new Map<string, string>()

  constructor(private readonly space: SdrSpace) {}

  open(): void {}
  close(): void {}

  putCell(cell: MemCell): void {
    this.cells.set(idKey(cell.cellId), cloneCell(cell))
  }
  getCell(id: bigint): MemCell | null {
    const c = this.cells.get(idKey(id))
    return c ? cloneCell(c) : null
  }
  deleteCell(id: bigint): void {
    this.cells.delete(idKey(id))
    this.edgeList = this.edgeList.filter((e) => idKey(e.src) !== idKey(id) && idKey(e.dst) !== idKey(id))
  }
  listCells(filter: CellFilter = {}): MemCell[] {
    let out = [...this.cells.values()]
    if (filter.kind !== undefined) out = out.filter((c) => c.kind === filter.kind)
    if (filter.kinds) out = out.filter((c) => filter.kinds!.includes(c.kind))
    if (filter.tier !== undefined) out = out.filter((c) => c.tier === filter.tier)
    if (filter.since !== undefined) out = out.filter((c) => Number(c.tFrom) >= filter.since!)
    if (filter.until !== undefined) out = out.filter((c) => Number(c.tFrom) <= filter.until!)
    out.sort((a, b) => (filter.order === 'oldest' ? Number(a.tFrom - b.tFrom) : Number(b.tFrom - a.tFrom)))
    if (filter.limit) out = out.slice(0, filter.limit)
    return out.map(cloneCell)
  }
  countCells(): number {
    return this.cells.size
  }
  forEachCell(fn: (c: MemCell) => void): void {
    for (const c of this.cells.values()) fn(c)
  }

  putEdge(e: EdgeRecord): void {
    const i = this.edgeList.findIndex((x) => x.src === e.src && x.dst === e.dst && x.rel === e.rel)
    if (i >= 0) this.edgeList[i] = { ...e }
    else this.edgeList.push({ ...e })
  }
  edgesFrom(id: bigint): EdgeRecord[] {
    return this.edgeList.filter((e) => e.src === id)
  }
  edgesTo(id: bigint): EdgeRecord[] {
    return this.edgeList.filter((e) => e.dst === id)
  }
  allEdges(): EdgeRecord[] {
    return this.edgeList.map((e) => ({ ...e }))
  }
  setEdgeWeight(src: bigint, dst: bigint, rel: number, weight: number): void {
    const e = this.edgeList.find((x) => x.src === src && x.dst === dst && x.rel === rel)
    if (e) e.weight = weight
  }
  deleteEdge(src: bigint, dst: bigint, rel: number): void {
    this.edgeList = this.edgeList.filter((x) => !(x.src === src && x.dst === dst && x.rel === rel))
  }

  putResidual(sha: Uint8Array, raw: Uint8Array): number {
    const k = bytesToHex(sha)
    const known = this.refs.get(k)
    if (known !== undefined) return known
    const off = this.residuals.length
    this.residuals.push(compress(raw))
    this.refs.set(k, off)
    return off
  }
  getResidual(off: number): Uint8Array | null {
    const c = this.residuals[off]
    return c ? decompress(c.codec, c.bytes, c.rawLen) : null
  }
  residualRefs(sha: Uint8Array): number {
    return 1
  }
  addResidualRef(): void {}

  putSource(cellId: bigint, session: string, seq: number): void {
    const k = idKey(cellId)
    const arr = this.sources.get(k) ?? []
    if (!arr.some((s) => s.session === session && s.seq === seq)) arr.push({ session, seq })
    this.sources.set(k, arr)
  }
  sourcesOf(cellId: bigint): Array<{ session: string; seq: number }> {
    return this.sources.get(idKey(cellId)) ?? []
  }
  cellsOfSession(session: string): bigint[] {
    const out: bigint[] = []
    for (const [k, arr] of this.sources) if (arr.some((s) => s.session === session)) out.push(BigInt('0x' + k))
    return out
  }

  putSnapshot(rendered: string, tokens: number): string {
    const id = toHex(BigInt('0x' + bytesToHex(sha32(rendered))), 16)
    this.snaps.set(id, { snapId: id, rendered, tokens, created: Date.now() })
    return id
  }
  getSnapshot(snapId: string): SnapshotRecord | null {
    return this.snaps.get(snapId) ?? null
  }

  shadowSeqs(session: string, seqs: number[]): void {
    for (const s of seqs) this.shadow.add(`${session}#${s}`)
  }
  isShadowed(session: string, seq: number): boolean {
    return this.shadow.has(`${session}#${seq}`)
  }

  appendEvict(rec: EvictRecord): void {
    this.evicts.push(rec)
  }
  recentEvicts(n: number): EvictRecord[] {
    return this.evicts.slice(-n).reverse()
  }

  meta(key: string): string | null {
    return this.kv.get(key) ?? null
  }
  setMeta(key: string, value: string): void {
    this.kv.set(key, value)
  }

  private logs: LogEntry[] = []
  appendLog(e: LogEntry): void {
    if (this.logs.some((x) => x.session === e.session && x.seq === e.seq)) return
    this.logs.push({ ...e })
  }
  listLog(session?: string): LogEntry[] {
    const rows = session ? this.logs.filter((x) => x.session === session) : [...this.logs]
    return rows.sort((a, b) => (a.session === b.session ? a.seq - b.seq : a.session.localeCompare(b.session)))
  }
  clearLattice(preserveKinds: number[] = []): void {
    const keep = new Set(preserveKinds)
    for (const [k, c] of [...this.cells]) if (!keep.has(c.kind)) this.cells.delete(k)
    this.edgeList = []
    this.sources.clear()
  }

  write<T>(fn: () => T): T {
    return fn()
  }
  stats() {
    const blobBytes = [...this.cells.values()].reduce((n, c) => n + encodeCell(c).length, 0)
    const residualBytes = this.residuals.reduce((n, r) => n + r.bytes.length, 0)
    const rawBytes = this.residuals.reduce((n, r) => n + r.rawLen, 0)
    return {
      cells: this.cells.size,
      edges: this.edgeList.length,
      residuals: this.residuals.length,
      bytes: blobBytes + residualBytes,
      rawBytes,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// SqliteStore（node:sqlite）
// ─────────────────────────────────────────────────────────────────────

interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): {
    run(...args: unknown[]): unknown
    get(...args: unknown[]): Record<string, unknown> | undefined
    all(...args: unknown[]): Array<Record<string, unknown>>
  }
  close(): void
}

const DDL = `
CREATE TABLE IF NOT EXISTS cells (
  cell_id     TEXT PRIMARY KEY,
  kind        INTEGER NOT NULL,
  tier        INTEGER NOT NULL,
  flags       INTEGER NOT NULL,
  t_from      INTEGER NOT NULL, t_to INTEGER NOT NULL,
  t_ingest    INTEGER NOT NULL, t_access INTEGER NOT NULL,
  access_cnt  INTEGER NOT NULL DEFAULT 0,
  stability   REAL    NOT NULL DEFAULT 7.0,
  importance  REAL    NOT NULL DEFAULT 0.5,
  valence     INTEGER NOT NULL DEFAULT 0,
  arousal     INTEGER NOT NULL DEFAULT 0,
  dominance   INTEGER NOT NULL DEFAULT 0,
  salience    INTEGER NOT NULL DEFAULT 0,
  provenance  INTEGER NOT NULL, trust INTEGER NOT NULL,
  confidence  REAL    NOT NULL DEFAULT 0.5,
  support     INTEGER NOT NULL DEFAULT 1,
  topic       TEXT    NOT NULL DEFAULT '',
  digest      TEXT    NOT NULL DEFAULT '',
  residual_sha BLOB, residual_off INTEGER, residual_len INTEGER,
  t_invalid   INTEGER NOT NULL DEFAULT 0,
  scope       TEXT    NOT NULL DEFAULT 'user:local',
  session     TEXT    NOT NULL DEFAULT '',
  lens        TEXT    NOT NULL DEFAULT 'fact',
  blob        BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scope ON cells(scope, kind);
CREATE INDEX IF NOT EXISTS idx_time  ON cells(t_from, t_to);
CREATE INDEX IF NOT EXISTS idx_tier  ON cells(tier);
CREATE INDEX IF NOT EXISTS idx_kind  ON cells(kind);

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL, dst TEXT NOT NULL,
  rel INTEGER NOT NULL, weight INTEGER NOT NULL,
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

CREATE TABLE IF NOT EXISTS residuals (
  sha BLOB PRIMARY KEY, offset INTEGER NOT NULL,
  raw_len INTEGER NOT NULL, comp_len INTEGER NOT NULL,
  ref_cnt INTEGER NOT NULL DEFAULT 0, codec TEXT NOT NULL DEFAULT 'raw',
  data BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS cell_sources (
  cell_id TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (cell_id, session, seq)
);
CREATE INDEX IF NOT EXISTS idx_src_session ON cell_sources(session);

CREATE TABLE IF NOT EXISTS recall_snapshots (
  snap_id   TEXT PRIMARY KEY,
  rendered  TEXT NOT NULL,
  tokens    INTEGER NOT NULL,
  created   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS shadow_map (
  session TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (session, seq)
);

CREATE TABLE IF NOT EXISTS evict_log (
  cell_id TEXT NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL,
  actor TEXT NOT NULL, at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- 会话日志的影子副本：只存"重建晶格所需的最小信息"（§14.11 晶格可重建）。
-- 它不替代 DSH 的 Session Log，只是让 /mnemo rebuild 不必依赖宿主回放接口。
CREATE TABLE IF NOT EXISTS session_log (
  session TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (session, seq)
);
`

export class SqliteStore implements Store {
  readonly kind = 'sqlite' as const
  private db: SqliteDb | null = null
  private depth = 0

  constructor(
    private readonly space: SdrSpace,
    private readonly path: string,
  ) {}

  open(): void {
    if (this.db) return // 幂等启动（§14.7）
    const mod = builtin<{ DatabaseSync: new (p: string) => SqliteDb }>('node:sqlite')
    const db = new mod.DatabaseSync(this.path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(DDL)
    this.db = db
  }

  close(): void {
    if (!this.db) return
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.db.close()
    this.db = null
  }

  private get conn(): SqliteDb {
    if (!this.db) throw new Error('store 未打开（open() 未调用或被 close()）')
    return this.db
  }

  putCell(cell: MemCell): void {
    const r = rowFromCell(cell) as CellRow & { blob: Uint8Array }
    this.conn
      .prepare(
        `INSERT INTO cells (cell_id,kind,tier,flags,t_from,t_to,t_ingest,t_access,access_cnt,
           stability,importance,valence,arousal,dominance,salience,provenance,trust,
           confidence,support,topic,digest,residual_sha,residual_off,residual_len,t_invalid,scope,session,lens,blob)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(cell_id) DO UPDATE SET
           kind=excluded.kind, tier=excluded.tier, flags=excluded.flags,
           t_from=excluded.t_from, t_to=excluded.t_to, t_ingest=excluded.t_ingest,
           t_access=excluded.t_access, access_cnt=excluded.access_cnt,
           stability=excluded.stability, importance=excluded.importance,
           valence=excluded.valence, arousal=excluded.arousal, dominance=excluded.dominance,
           salience=excluded.salience, provenance=excluded.provenance, trust=excluded.trust,
           confidence=excluded.confidence, support=excluded.support, topic=excluded.topic,
           digest=excluded.digest, residual_sha=excluded.residual_sha,
           residual_off=excluded.residual_off, residual_len=excluded.residual_len,
           t_invalid=excluded.t_invalid, scope=excluded.scope, session=excluded.session,
           lens=excluded.lens, blob=excluded.blob`,
      )
      .run(
        r.cell_id, r.kind, r.tier, r.flags, r.t_from, r.t_to, r.t_ingest, r.t_access, r.access_cnt,
        r.stability, r.importance, Math.round(r.valence * 1000), Math.round(r.arousal * 1000),
        Math.round(r.dominance * 1000), Math.round(r.salience * 1000),
        r.provenance, r.trust, r.confidence, r.support, r.topic, r.digest,
        r.residual_sha, r.residual_off, r.residual_len, Number(r.t_invalid ?? 0),
        r.scope ?? 'user:local', r.session ?? '', r.lens ?? 'fact', r.blob,
      )
  }

  getCell(id: bigint): MemCell | null {
    const row = this.conn.prepare('SELECT blob FROM cells WHERE cell_id = ?').get(idKey(id))
    if (!row) return null
    return this.hydrate(row.blob as Uint8Array, id)
  }

  private hydrate(blob: Uint8Array, id: bigint): MemCell {
    const cell = decodeCell(new Uint8Array(blob), this.space)
    const extra = this.conn
      .prepare('SELECT confidence, support, topic, digest, t_invalid, scope, session, lens FROM cells WHERE cell_id = ?')
      .get(idKey(id)) as Record<string, unknown> | undefined
    if (extra) {
      cell.confidence = Number(extra.confidence ?? 0.5)
      cell.support = Number(extra.support ?? 1)
      cell.topic = String(extra.topic ?? cell.topic)
      cell.digest = String(extra.digest ?? '')
      // 双时态的"事务时间"一侧：这一行什么时候不再为真（0 = 仍然有效）
      cell.tInvalid = BigInt(Number(extra.t_invalid ?? 0))
      cell.scope = String(extra.scope ?? 'user:local')
      cell.session = String(extra.session ?? '')
      cell.lens = String(extra.lens ?? 'fact') as MemCell['lens']
    }
    return cell
  }

  deleteCell(id: bigint): void {
    const k = idKey(id)
    this.conn.prepare('DELETE FROM cells WHERE cell_id = ?').run(k)
    this.conn.prepare('DELETE FROM edges WHERE src = ? OR dst = ?').run(k, k)
    this.conn.prepare('DELETE FROM cell_sources WHERE cell_id = ?').run(k)
  }

  listCells(filter: CellFilter = {}): MemCell[] {
    const where: string[] = []
    const args: unknown[] = []
    if (filter.kind !== undefined) {
      where.push('kind = ?')
      args.push(filter.kind)
    }
    if (filter.lens !== undefined) {
      where.push('lens = ?')
      args.push(filter.lens)
    }
    if (filter.kinds?.length) {
      where.push(`kind IN (${filter.kinds.map(() => '?').join(',')})`)
      args.push(...filter.kinds)
    }
    if (filter.tier !== undefined) {
      where.push('tier = ?')
      args.push(filter.tier)
    }
    if (filter.since !== undefined) {
      where.push('t_from >= ?')
      args.push(filter.since)
    }
    if (filter.until !== undefined) {
      where.push('t_from <= ?')
      args.push(filter.until)
    }
    const order = filter.order === 'oldest' ? 'ASC' : 'DESC'
    const sql = `SELECT cell_id, blob FROM cells ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t_from ${order} ${
      filter.limit ? 'LIMIT ' + Math.max(1, Math.floor(filter.limit)) : ''
    }`
    return this.conn
      .prepare(sql)
      .all(...args)
      .map((r) => this.hydrate(new Uint8Array(r.blob as Uint8Array), BigInt('0x' + String(r.cell_id))))
  }

  countCells(): number {
    const r = this.conn.prepare('SELECT COUNT(*) AS n FROM cells').get()
    return Number(r?.n ?? 0)
  }

  forEachCell(fn: (c: MemCell) => void): void {
    for (const r of this.conn.prepare('SELECT cell_id, blob FROM cells').all()) {
      fn(this.hydrate(new Uint8Array(r.blob as Uint8Array), BigInt('0x' + String(r.cell_id))))
    }
  }

  putEdge(e: EdgeRecord): void {
    this.conn
      .prepare('INSERT INTO edges (src,dst,rel,weight) VALUES (?,?,?,?) ON CONFLICT(src,dst,rel) DO UPDATE SET weight=excluded.weight')
      .run(idKey(e.src), idKey(e.dst), e.rel, e.weight)
  }
  edgesFrom(id: bigint): EdgeRecord[] {
    return this.conn
      .prepare('SELECT src,dst,rel,weight FROM edges WHERE src = ?')
      .all(idKey(id))
      .map((r) => ({ src: BigInt('0x' + String(r.src)), dst: BigInt('0x' + String(r.dst)), rel: Number(r.rel), weight: Number(r.weight) }))
  }
  edgesTo(id: bigint): EdgeRecord[] {
    return this.conn
      .prepare('SELECT src,dst,rel,weight FROM edges WHERE dst = ?')
      .all(idKey(id))
      .map((r) => ({ src: BigInt('0x' + String(r.src)), dst: BigInt('0x' + String(r.dst)), rel: Number(r.rel), weight: Number(r.weight) }))
  }
  allEdges(): EdgeRecord[] {
    return this.conn
      .prepare('SELECT src,dst,rel,weight FROM edges')
      .all()
      .map((r) => ({ src: BigInt('0x' + String(r.src)), dst: BigInt('0x' + String(r.dst)), rel: Number(r.rel), weight: Number(r.weight) }))
  }
  setEdgeWeight(src: bigint, dst: bigint, rel: number, weight: number): void {
    this.conn.prepare('UPDATE edges SET weight = ? WHERE src = ? AND dst = ? AND rel = ?').run(weight, idKey(src), idKey(dst), rel)
  }
  deleteEdge(src: bigint, dst: bigint, rel: number): void {
    this.conn.prepare('DELETE FROM edges WHERE src = ? AND dst = ? AND rel = ?').run(idKey(src), idKey(dst), rel)
  }

  putResidual(sha: Uint8Array, raw: Uint8Array): number {
    const known = this.conn.prepare('SELECT offset FROM residuals WHERE sha = ?').get(sha)
    if (known) return Number(known.offset)
    const max = this.conn.prepare('SELECT COALESCE(MAX(offset), -1) AS m FROM residuals').get()
    const off = Number(max?.m ?? -1) + 1
    const c = compress(raw)
    this.conn
      .prepare('INSERT INTO residuals (sha,offset,raw_len,comp_len,ref_cnt,codec,data) VALUES (?,?,?,?,1,?,?)')
      .run(sha, off, c.rawLen, c.bytes.length, c.codec, c.bytes)
    return off
  }
  /** 残差正文与索引同库（冷层可外迁到对象存储，接口不变）。 */
  getResidual(off: number): Uint8Array | null {
    const r = this.conn.prepare('SELECT data,codec,raw_len FROM residuals WHERE offset = ?').get(off)
    if (!r) return null
    return decompress(String(r.codec), new Uint8Array(r.data as Uint8Array), Number(r.raw_len))
  }
  residualRefs(sha: Uint8Array): number {
    const r = this.conn.prepare('SELECT ref_cnt FROM residuals WHERE sha = ?').get(sha)
    return Number(r?.ref_cnt ?? 0)
  }
  addResidualRef(sha: Uint8Array): void {
    this.conn.prepare('UPDATE residuals SET ref_cnt = ref_cnt + 1 WHERE sha = ?').run(sha)
  }

  putSource(cellId: bigint, session: string, seq: number): void {
    this.conn
      .prepare('INSERT INTO cell_sources (cell_id,session,seq) VALUES (?,?,?) ON CONFLICT DO NOTHING')
      .run(idKey(cellId), session, seq)
  }
  sourcesOf(cellId: bigint): Array<{ session: string; seq: number }> {
    return this.conn
      .prepare('SELECT session,seq FROM cell_sources WHERE cell_id = ? ORDER BY seq')
      .all(idKey(cellId))
      .map((r) => ({ session: String(r.session), seq: Number(r.seq) }))
  }
  cellsOfSession(session: string): bigint[] {
    return this.conn
      .prepare('SELECT DISTINCT cell_id FROM cell_sources WHERE session = ?')
      .all(session)
      .map((r) => BigInt('0x' + String(r.cell_id)))
  }

  putSnapshot(rendered: string, tokens: number): string {
    const id = toHex(BigInt('0x' + bytesToHex(sha32(rendered))), 16)
    this.conn
      .prepare('INSERT INTO recall_snapshots (snap_id,rendered,tokens,created) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
      .run(id, rendered, tokens, Date.now())
    return id
  }
  getSnapshot(snapId: string): SnapshotRecord | null {
    const r = this.conn.prepare('SELECT * FROM recall_snapshots WHERE snap_id = ?').get(snapId)
    if (!r) return null
    return { snapId: String(r.snap_id), rendered: String(r.rendered), tokens: Number(r.tokens), created: Number(r.created) }
  }

  shadowSeqs(session: string, seqs: number[]): void {
    const st = this.conn.prepare('INSERT INTO shadow_map (session,seq) VALUES (?,?) ON CONFLICT DO NOTHING')
    for (const s of seqs) st.run(session, s)
  }
  isShadowed(session: string, seq: number): boolean {
    return !!this.conn.prepare('SELECT 1 FROM shadow_map WHERE session = ? AND seq = ?').get(session, seq)
  }

  appendEvict(rec: EvictRecord): void {
    this.conn
      .prepare('INSERT INTO evict_log (cell_id,mode,reason,actor,at) VALUES (?,?,?,?,?)')
      .run(rec.cellId, rec.mode, rec.reason, rec.actor, rec.at)
  }
  recentEvicts(n: number): EvictRecord[] {
    return this.conn
      .prepare('SELECT * FROM evict_log ORDER BY at DESC LIMIT ?')
      .all(Math.max(1, n))
      .map((r) => ({
        cellId: String(r.cell_id),
        mode: String(r.mode) as 'soft' | 'hard',
        reason: String(r.reason),
        actor: String(r.actor) as 'user' | 'admin' | 'policy',
        at: Number(r.at),
      }))
  }

  meta(key: string): string | null {
    const r = this.conn.prepare('SELECT v FROM meta WHERE k = ?').get(key)
    return r ? String(r.v) : null
  }
  setMeta(key: string, value: string): void {
    this.conn.prepare('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(key, value)
  }

  appendLog(e: LogEntry): void {
    this.conn
      .prepare('INSERT INTO session_log (session,seq,turn,role,text,at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(e.session, e.seq, e.turn, e.role, e.text, e.at)
  }
  listLog(session?: string): LogEntry[] {
    const rows = session
      ? this.conn.prepare('SELECT * FROM session_log WHERE session = ? ORDER BY seq').all(session)
      : this.conn.prepare('SELECT * FROM session_log ORDER BY session, seq').all()
    return rows.map((r) => ({
      session: String(r.session),
      seq: Number(r.seq),
      turn: Number(r.turn),
      role: String(r.role) as LogEntry['role'],
      text: String(r.text),
      at: Number(r.at),
    }))
  }
  clearLattice(preserveKinds: number[] = []): void {
    if (preserveKinds.length === 0) {
      this.conn.exec('DELETE FROM cells; DELETE FROM edges; DELETE FROM cell_sources;')
      return
    }
    const list = preserveKinds.map((k) => Math.floor(k)).join(',')
    this.conn.exec(`DELETE FROM cells WHERE kind NOT IN (${list}); DELETE FROM edges; DELETE FROM cell_sources;`)
  }

  /** 单写事务（§8.5）。嵌套调用退化为最外层事务，避免巩固 pass 里再包一层。 */
  write<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try {
        return fn()
      } finally {
        this.depth--
      }
    }
    this.conn.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const out = fn()
      this.conn.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.conn.exec('ROLLBACK')
      } catch {
        /* 回滚失败时保留原始错误 */
      }
      throw err
    } finally {
      this.depth = 0
    }
  }

  stats() {
    const c = this.conn.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(blob)),0) AS b FROM cells').get()
    const e = this.conn.prepare('SELECT COUNT(*) AS n FROM edges').get()
    const r = this.conn
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(comp_len),0) AS b, COALESCE(SUM(raw_len),0) AS raw FROM residuals')
      .get()
    return {
      cells: Number(c?.n ?? 0),
      edges: Number(e?.n ?? 0),
      residuals: Number(r?.n ?? 0),
      bytes: Number(c?.b ?? 0) + Number(r?.b ?? 0),
      rawBytes: Number(r?.raw ?? 0),
    }
  }
}

// ─────────────────────────────────────────────────────────────────────

function cloneCell(c: MemCell): MemCell {
  return {
    ...c,
    sdr: new Uint32Array(c.sdr),
    emb: c.emb ? c.emb.slice() : null,
    slots: c.slots.map((s) => ({ ...s })),
    edges: c.edges.map((e) => ({ ...e })),
    residual: c.residual ? { ...c.residual, sha: c.residual.sha.slice() } : null,
  }
}

function sha32(text: string): Uint8Array {
  // 与 hash.digest32 同口径；此处避免循环依赖内联
  const enc = new TextEncoder().encode(text)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < enc.length; i++) {
    h1 = Math.imul(h1 ^ enc[i], 0x01000193) >>> 0
    h2 = Math.imul(h2 + enc[i], 0x85ebca6b) >>> 0
  }
  const out = new Uint8Array(32)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, h1, true)
  dv.setUint32(4, h2, true)
  dv.setUint32(8, enc.length, true)
  dv.setUint32(12, h1 ^ h2, true)
  for (let i = 16; i < 32; i++) out[i] = (h1 >>> (i % 4)) ^ (h2 >>> (i % 3))
  return out
}

export function createStore(opts: { kind?: 'sqlite' | 'memory'; path?: string; space: SdrSpace }): Store {
  if (opts.kind === 'memory') return new MemoryStore(opts.space)
  if (!opts.path) throw new Error('SqliteStore 需要 path')
  return new SqliteStore(opts.space, opts.path)
}
