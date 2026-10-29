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
import { bytesToHex, hexToBytes, toHex } from './hash.js'
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
  /**
   * 释放一条残差引用。**没有任何 cell 再引用它时物理删除**。
   *
   * 为什么不用 ref_cnt 做判据：残差是**按轮共享**的（一轮 4 条命题共用一个残差），
   * 而 ref_cnt 在 putResidual 里只置 1、addResidualRef 从未被调用，
   * 于是"删掉一条 cell 就把还有 3 个引用者的残差删掉"。
   * 现在的判据是「扫一遍还有没有 cell 引用这个 sha」——O(n) 但永远正确，
   * 而删除是低频的用户操作，付得起这个代价。
   */
  releaseResidualRef(sha: Uint8Array): void
  /** 孤儿残差（没有任何 cell 引用的残差行），doctor 用来体检与清理。 */
  orphanResiduals(): Array<{ sha: string; bytes: number; rawLen: number }>
  /** 物理删除一条孤儿残差（只删真的没人引用的）。 */
  purgeOrphanResidual(sha: string): boolean

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
  stats(): { cells: number; edges: number; residuals: number; bytes: number; rawBytes?: number; residualBytes?: number }
}

const idKey = (id: bigint) => toHex(id, 16)

/** getCell / forEachCell 共用同一份列清单：blob 与列承载字段一次取回。 */
const SELECT_COLS = 'blob, confidence, support, topic, digest, t_invalid, scope, session, lens'
const SELECT_CELL = `SELECT ${SELECT_COLS} FROM cells`
const SELECT_ALL = SELECT_CELL

/** node:sqlite 是内置模块，但 ESM 里没有 require。getBuiltinModule 是同步且不污染全局的取法。 */
function builtin<T>(name: string): T {
  const g = (process as unknown as { getBuiltinModule?: (n: string) => unknown }).getBuiltinModule
  if (typeof g !== 'function') {
    throw new Error(
      `当前 Node ${process.version} 不支持 process.getBuiltinModule，无法加载 ${name}。` +
        `本项目需要 Node ≥ 22.13（node:sqlite 在 22.5–22.12 需要 --experimental-sqlite 标志，` +
        `按 README 装 22.5 会直接跑不起来）。`,
    )
  }
  try {
    return g(name) as T
  } catch (err) {
    throw new Error(
      `无法加载 ${name}（Node ${process.version}）：${String((err as Error)?.message ?? err)}。` +
        `请升级到 Node ≥ 22.13，或用 --experimental-sqlite 启动。`,
    )
  }
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
    const victim = this.cells.get(idKey(id))
    this.cells.delete(idKey(id))
    this.edgeList = this.edgeList.filter((e) => idKey(e.src) !== idKey(id) && idKey(e.dst) !== idKey(id))
    if (victim?.residual) this.releaseResidualRef(victim.residual.sha)
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
    let n = 0
    for (const c of this.cells.values()) if (c.residual && bytesToHex(c.residual.sha) === bytesToHex(sha)) n++
    return n
  }
  addResidualRef(): void {
    /* 引用数由 residualRefs 现算，不再维护计数器（见接口注释） */
  }
  releaseResidualRef(sha: Uint8Array): void {
    if (this.residualRefs(sha) > 0) return
    const k = bytesToHex(sha)
    const idx = this.residuals.findIndex((r, i) => this.refs.get(k) === i)
    if (idx >= 0) {
      // 下标即 offset：删掉会移动后续下标，因此只把内容清空、保留槽位（读取返回空）
      this.residuals[idx] = { codec: 'raw', bytes: new Uint8Array(0), rawLen: 0 }
    }
    this.refs.delete(k)
  }
  orphanResiduals(): Array<{ sha: string; bytes: number; rawLen: number }> {
    const used = new Set<string>()
    for (const c of this.cells.values()) if (c.residual) used.add(bytesToHex(c.residual.sha))
    const out: Array<{ sha: string; bytes: number; rawLen: number }> = []
    for (const [sha, off] of this.refs) {
      if (used.has(sha)) continue
      const r = this.residuals[off]
      out.push({ sha, bytes: r?.bytes.length ?? 0, rawLen: r?.rawLen ?? 0 })
    }
    return out
  }
  purgeOrphanResidual(sha: string): boolean {
    const off = this.refs.get(sha)
    if (off === undefined) return false
    const r = this.residuals[off]
    if (r) this.residuals[off] = { codec: 'raw', bytes: new Uint8Array(0), rawLen: 0 }
    this.refs.delete(sha)
    return true
  }

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
    const id = snapshotIdOf(rendered)
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
      residualBytes,
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
    // WAL 下多会话并发写会直接抛 SQLITE_BUSY 而不是排队等待。
    // 没有这一行，两个进程同时写就是随机失败——而这在"宿主 + 面板 + 巩固"三处并发时很常见。
    db.exec('PRAGMA busy_timeout = 5000')
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

  /**
   * prepared statement 缓存。
   *
   * node:sqlite 每次 `prepare()` 都会重新编译 SQL。v0.3 之前有 38 处 `prepare()`
   * 全部无缓存，而 `forEachCell` 里的 `hydrate` 更是**每行**再 prepare 一次——
   * 2000 cell 的一次召回实测 317 ms / 6003 条 SQL，其中绝大部分是重复编译。
   * 语句本身是无状态的（参数化），缓存键就是 SQL 文本。
   */
  private readonly stmts = new Map<string, ReturnType<SqliteDb['prepare']>>()

  private prep(sql: string): ReturnType<SqliteDb['prepare']> {
    const hit = this.stmts.get(sql)
    if (hit) return hit
    const stmt = this.conn.prepare(sql)
    this.stmts.set(sql, stmt)
    return stmt
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

  /** 读一条 cell：**一次** SQL 同时取 blob 与列承载字段（v0.3 是两趟）。 */
  getCell(id: bigint): MemCell | null {
    const row = this.prep(`${SELECT_CELL} WHERE cell_id = ?`).get(idKey(id)) as Record<string, unknown> | undefined
    if (!row) return null
    return this.hydrate(row)
  }

  /**
   * blob 是布局的唯一事实，列是它的派生投影。
   * 一次查询把两者一起取回来，避免"N 次遍历 = N 次额外点查"。
   */
  private hydrate(row: Record<string, unknown>): MemCell {
    const cell = decodeCell(new Uint8Array(row.blob as Uint8Array), this.space)
    cell.confidence = Number(row.confidence ?? 0.5)
    cell.support = Number(row.support ?? 1)
    cell.topic = String(row.topic ?? cell.topic)
    cell.digest = String(row.digest ?? '')
    // 双时态的"事务时间"一侧：这一行什么时候不再为真（0 = 仍然有效）
    cell.tInvalid = BigInt(Number(row.t_invalid ?? 0))
    cell.scope = String(row.scope ?? 'user:local')
    cell.session = String(row.session ?? '')
    cell.lens = String(row.lens ?? 'fact') as MemCell['lens']
    return cell
  }

  deleteCell(id: bigint): void {
    const k = idKey(id)
    const row = this.prep('SELECT residual_sha FROM cells WHERE cell_id = ?').get(k)
    this.prep('DELETE FROM cells WHERE cell_id = ?').run(k)
    this.prep('DELETE FROM edges WHERE src = ? OR dst = ?').run(k, k)
    this.prep('DELETE FROM cell_sources WHERE cell_id = ?').run(k)
    // 硬删必须真的删掉原文：否则"已物理删除"是句假话，GDPR 的删除权在这条路径上失效
    const sha = row?.residual_sha
    if (sha) this.releaseResidualRef(new Uint8Array(sha as Uint8Array))
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
    const sql = `${SELECT_CELL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t_from ${order} ${
      filter.limit ? 'LIMIT ' + Math.max(1, Math.floor(filter.limit)) : ''
    }`
    return this.prep(sql)
      .all(...args)
      .map((r) => this.hydrate(r))
  }

  countCells(): number {
    const r = this.prep('SELECT COUNT(*) AS n FROM cells').get()
    return Number(r?.n ?? 0)
  }

  /**
   * 全量遍历：一次查询取全列，优先走 `.iterate()` 流式。
   *
   * v0.3 之前是 `SELECT cell_id, blob` + 每行一次 `hydrate` 点查，
   * 即一次遍历 N+1 条 SQL；2000 cell 实测 111 ms。现在是一条 SQL，
   * 且 `.iterate()` 可用时不会先把 N 行物化成数组。
   */
  forEachCell(fn: (c: MemCell) => void): void {
    const stmt = this.prep(SELECT_ALL) as unknown as { iterate?: () => Iterable<Record<string, unknown>>; all(): Array<Record<string, unknown>> }
    const rows = typeof stmt.iterate === 'function' ? stmt.iterate() : stmt.all()
    for (const r of rows) fn(this.hydrate(r))
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
    this.prep('UPDATE edges SET weight = ? WHERE src = ? AND dst = ? AND rel = ?').run(weight, idKey(src), idKey(dst), rel)
  }
  deleteEdge(src: bigint, dst: bigint, rel: number): void {
    this.prep('DELETE FROM edges WHERE src = ? AND dst = ? AND rel = ?').run(idKey(src), idKey(dst), rel)
  }

  putResidual(sha: Uint8Array, raw: Uint8Array): number {
    const known = this.prep('SELECT offset FROM residuals WHERE sha = ?').get(sha)
    if (known) return Number(known.offset)
    const max = this.prep('SELECT COALESCE(MAX(offset), -1) AS m FROM residuals').get()
    const off = Number(max?.m ?? -1) + 1
    const c = compress(raw)
    this.conn
      .prepare('INSERT INTO residuals (sha,offset,raw_len,comp_len,ref_cnt,codec,data) VALUES (?,?,?,?,1,?,?)')
      .run(sha, off, c.rawLen, c.bytes.length, c.codec, c.bytes)
    return off
  }
  /** 残差正文与索引同库（冷层可外迁到对象存储，接口不变）。 */
  getResidual(off: number): Uint8Array | null {
    const r = this.prep('SELECT data,codec,raw_len FROM residuals WHERE offset = ?').get(off)
    if (!r) return null
    return decompress(String(r.codec), new Uint8Array(r.data as Uint8Array), Number(r.raw_len))
  }
  residualRefs(sha: Uint8Array): number {
    const r = this.prep('SELECT ref_cnt FROM residuals WHERE sha = ?').get(sha)
    return Number(r?.ref_cnt ?? 0)
  }
  addResidualRef(sha: Uint8Array): void {
    this.prep('UPDATE residuals SET ref_cnt = ref_cnt + 1 WHERE sha = ?').run(sha)
  }

  releaseResidualRef(sha: Uint8Array): void {
    // 判据是"还有没有 cell 引用"，不是 ref_cnt（见接口注释）
    const used = this.prep('SELECT COUNT(*) AS n FROM cells WHERE residual_sha = ?').get(sha)
    if (Number(used?.n ?? 0) > 0) return
    this.prep('DELETE FROM residuals WHERE sha = ?').run(sha)
  }

  orphanResiduals(): Array<{ sha: string; bytes: number; rawLen: number }> {
    const rows = this.conn
      .prepare(
        `SELECT r.sha AS sha, r.comp_len AS b, r.raw_len AS raw FROM residuals r
         WHERE NOT EXISTS (SELECT 1 FROM cells c WHERE c.residual_sha = r.sha)`,
      )
      .all()
    return rows.map((r) => ({ sha: bytesToHex(new Uint8Array(r.sha as Uint8Array)), bytes: Number(r.b ?? 0), rawLen: Number(r.raw ?? 0) }))
  }

  purgeOrphanResidual(sha: string): boolean {
    const bytes = hexToBytes(sha)
    const used = this.prep('SELECT COUNT(*) AS n FROM cells WHERE residual_sha = ?').get(bytes)
    if (Number(used?.n ?? 0) > 0) return false
    this.prep('DELETE FROM residuals WHERE sha = ?').run(bytes)
    return true
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
    const id = snapshotIdOf(rendered)
    this.conn
      .prepare('INSERT INTO recall_snapshots (snap_id,rendered,tokens,created) VALUES (?,?,?,?) ON CONFLICT DO NOTHING')
      .run(id, rendered, tokens, Date.now())
    return id
  }
  getSnapshot(snapId: string): SnapshotRecord | null {
    const r = this.prep('SELECT * FROM recall_snapshots WHERE snap_id = ?').get(snapId)
    if (!r) return null
    return { snapId: String(r.snap_id), rendered: String(r.rendered), tokens: Number(r.tokens), created: Number(r.created) }
  }

  shadowSeqs(session: string, seqs: number[]): void {
    const st = this.prep('INSERT INTO shadow_map (session,seq) VALUES (?,?) ON CONFLICT DO NOTHING')
    for (const s of seqs) st.run(session, s)
  }
  isShadowed(session: string, seq: number): boolean {
    return !!this.prep('SELECT 1 FROM shadow_map WHERE session = ? AND seq = ?').get(session, seq)
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
    const r = this.prep('SELECT v FROM meta WHERE k = ?').get(key)
    return r ? String(r.v) : null
  }
  setMeta(key: string, value: string): void {
    this.prep('INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(key, value)
  }

  appendLog(e: LogEntry): void {
    this.conn
      .prepare('INSERT INTO session_log (session,seq,turn,role,text,at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING')
      .run(e.session, e.seq, e.turn, e.role, e.text, e.at)
  }
  listLog(session?: string): LogEntry[] {
    const rows = session
      ? this.prep('SELECT * FROM session_log WHERE session = ? ORDER BY seq').all(session)
      : this.prep('SELECT * FROM session_log ORDER BY session, seq').all()
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
    const c = this.prep('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(blob)),0) AS b FROM cells').get()
    const e = this.prep('SELECT COUNT(*) AS n FROM edges').get()
    const r = this.conn
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(comp_len),0) AS b, COALESCE(SUM(raw_len),0) AS raw FROM residuals')
      .get()
    return {
      cells: Number(c?.n ?? 0),
      edges: Number(e?.n ?? 0),
      residuals: Number(r?.n ?? 0),
      bytes: Number(c?.b ?? 0) + Number(r?.b ?? 0),
      rawBytes: Number(r?.raw ?? 0),
      residualBytes: Number(r?.b ?? 0),
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

/**
 * 快照 id：**内容寻址**（渲染文本的哈希），不是自增也不是随机。
 *
 * 导出它的理由：`runRecall` 之前返回 `snapshotId: ''`（硬编码空串），
 * 只有经 `service.recall()` 才会被填上——于是直接调 `runRecall` 的人拿不到可重放的 id，
 * 而 README 承诺"任何一次召回都能按 snapshot 逐字节重放"。
 * 现在两侧用同一个函数算，谁调都一致。
 */
export function snapshotIdOf(rendered: string): string {
  return toHex(BigInt('0x' + bytesToHex(sha32(rendered))), 16)
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
