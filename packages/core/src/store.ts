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

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
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

/** v0.7.2（E10）：谁在什么时候读过原始记忆。合规审计用，默认关闭。 */
export interface AccessRecord {
  at: number
  actor: string
  action: string
  target: string
  chars: number
  reason?: string
}

export interface Store {
  readonly kind: 'sqlite' | 'memory'
  open(): void
  close(): void

  putCell(cell: MemCell): void
  getCell(id: bigint): MemCell | null
  /**
   * `t_from` 落在 [from, to] 的 cell id（Q4 时间路）。
   *
   * v0.5.1 之前 Q4 也是 `forEachCell` 全表扫——而 `idx_time(t_from,t_to)` 一直就建着，
   * 只是没人用。这是全项目收益/成本比最高的一处：不新增数据结构，只把"扫全表"换成"走索引"。
   *
   * 口径：只按 `t_from` 过滤，**不看 `t_to`**。这不是漏了——原来的 Q4 也只比 `tFrom`，
   * 这里必须保持行为等价，否则"改成走索引"会顺手改掉检索结果。
   */
  cellsInTimeRange(from: number, to: number): bigint[]
  /** 保留度缓存（v0.5.2）：只存 score/band/at，不存七因子分解（见 setRetention 注释）。 */
  setRetention(cellId: bigint, score: number, band: number, at: number): void
  retentionOf(cellId: bigint): { score: number; band: number; at: number } | null
  /**
   * 缓存已判定"该降档"的 cell（单调性剪枝的快路径）。
   *
   * 依据：无访问 → ACT-R 激活单调减；无结构变更 → 其余六因子不变；`stale` 单调减；
   * 周年加成已被 v0.5.1 封顶在本档上沿。所以 t₀ 时判定的"该降"在 t>t₀ 仍成立。
   * 反向不成立，所以未命中的仍要重算——剪枝是保守方向。
   */
  demotableByCache(limit: number): bigint[]
  /** 最久未被评估的 cell（增量扫描：一次 pass 只算一批，不让 tick 变成 CPU 热点）。 */
  stalestForRetention(limit: number, before: number): bigint[]
  invalidateRetention(cellId: bigint): void
  clearRetention(): void
  /**
   * 按 32 位前缀找一条 cell（边表只存 6 字节前缀，读旧库时需要回解）。
   *
   * v0.4 之前是 `forEachCell` 全表扫描——2000 cell / 4 条边实测 425 ms，
   * 因为它对**每条边**都解一遍全部 blob。现在 SqliteStore 走
   * `substr(cell_id, 9)` 表达式索引（低 32 位 = 末 8 位 hex），O(log n)。
   */
  findByPrefix(prefix: number): bigint | null
  /**
   * 按 id **后缀**找 cell（v0.5.2）。
   *
   * 短 id 是 16 位 hex 的末 4~8 位，于是"4 位短 id"天然可能撞车。
   * v0.5.1 的两个实现都在撞车时**静默取第一个**——对 `forget --hard` 这种
   * 不可撤销操作，这意味着"我以为删的是 A，删的是 B"。
   * 现在返回**全部**匹配，由调用方决定是否报歧义。
   *
   * 走 SQL `LIKE`：仍然是扫一遍 id 列，但不解 blob——
   * 对比 `forEachCell` 的"解 10 万个 blob"，差一到两个数量级。
   */
  findBySuffix(suffix: string, limit?: number): bigint[]

  deleteCell(id: bigint): void
  listCells(filter?: CellFilter): MemCell[]
  countCells(): number
  /** 全量遍历（召回候选池用；索引只负责把候选缩小，最终仍要精确算分）。 */
  forEachCell(fn: (c: MemCell) => void): void

  putEdge(e: EdgeRecord): void
  edgesFrom(id: bigint): EdgeRecord[]
  edgesTo(id: bigint): EdgeRecord[]
  /** 边表。给了 `limit` 就只取前 N 条——面板不需要把 50 万条边读进内存再切片。 */
  allEdges(limit?: number): EdgeRecord[]
  /**
   * 聚合计数（v0.5.2）。面板每 3 秒刷新一次，而 `stats()` 原来是 `forEachCell`
   * ——为了数几个数把全库 blob 解一遍。10 万 cell 下这是 500 ms 级的工作，
   * 而 SQL 的 `GROUP BY` 是毫秒级。
   */
  counts(): {
    byKind: Record<string, number>
    byTier: Record<string, number>
    supportOne: number
    disputed: number
    invalidated: number
    contradictions: number
  }
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
  /** v0.7.2（E2 / E6）：列出召回快照。删除彻底性校验与数据导出都要能穷举它。 */
  listSnapshots(limit?: number): SnapshotRecord[]
  /** v0.7.2（E10）：原始记忆访问留痕（默认不记录，由宿主显式开启）。 */
  appendAccess(rec: AccessRecord): void
  listAccess(limit?: number): AccessRecord[]

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

  /**
   * 语料词频（v0.6.2 · IDF）。
   *
   * 只记"出现过该 token 的 cell 数"（document frequency），不记每条的词频——
   * 查询侧只需要 df 来判断"这个词有没有区分力"。
   *
   * **只在新建 cell 时累加**：更新（降档、改效价）不重复计数，
   * 否则 df 会随巩固次数膨胀，"高频"变成"被访问过"的同义词。
   */
  bumpTokenDf(tokens: Iterable<string>): void
  /** 批量取 df + 总文档数。一次召回只查一遍，不做逐 token 往返。 */
  tokenDf(tokens: readonly string[]): { df: Map<string, number>; docs: number }
  /** 清空词频表（rebuild / 换库时用）。 */
  clearTokenDf(): void

  /**
   * 清理派生表（v0.7.0 · 红线 2「无法真正删除」）。
   *
   * 审计实测：`forget --hard` 删掉 cell 之后，`session_log` 里仍留着**脱敏原文**，
   * `recall_snapshots` 里仍留着**渲染过的记忆文本**，`evict_log` 留着 id 与原因。
   * 也就是说"已物理删除"这句话只在 cell 表上成立。
   *
   * 这里把派生表一并清掉，返回每张表的删除行数作为回执——
   * 用户有权知道"到底删干净了没有"，而不是拿到一句"已删除"。
   */
  purgeAux(target: { kind: 'session'; id: string } | { kind: 'all' } | { kind: 'cell'; id: string }): {
    log: number
    snapshots: number
    evicts: number
    shadow: number
    sources: number
  }

  /**
   * v0.7.2（D7 / D8）：跨进程原子锁（CAS + TTL + owner）。
   *
   * 旧巩固锁只是 meta 表里的一个字符串，`SELECT` 与 `UPSERT` 是两条独立语句，
   * 无事务、无 owner、无过期时间：两个进程同时读到空就都会开跑，
   * 进程崩溃后锁永远不释放（只能靠 doctor --unlock 人工清）。
   * 服务端部署只要多开一个进程就会踩到，是评判报告列的 P0。
   */
  tryAcquireLock(key: string, owner: string, ttlMs: number): boolean
  /** 只释放自己持有的锁；别人的锁不会被误清。 */
  releaseLock(key: string, owner: string): boolean
  lockInfo(key: string): { owner: string; expiresAt: number } | null

  /** BEGIN IMMEDIATE 语义的单写事务。读侧不进事务（WAL 快照）。 */
  write<T>(fn: () => T): T
  stats(): { cells: number; edges: number; residuals: number; bytes: number; rawBytes?: number; residualBytes?: number }
}

const idKey = (id: bigint) => toHex(id, 16)

/** 锁值 = JSON [owner, expiresAt]。解析失败视为"旧格式/已损坏"，可被抢占。 */
function parseLock(v: string | null | undefined): { owner: string; expiresAt: number } | null {
  if (!v) return null
  try {
    const arr = JSON.parse(v) as unknown
    if (Array.isArray(arr) && typeof arr[0] === 'string' && Number.isFinite(arr[1])) {
      return { owner: arr[0], expiresAt: Number(arr[1]) }
    }
  } catch {
    /* 旧格式或手工写坏的锁：按可抢占处理 */
  }
  return null
}

const lockTtl = (ttlMs: number) => (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 600_000)

/** tags 列 ↔ string[]。空串 = 无标记（绝大多数 cell）。 */
export function parseTags(raw: unknown): string[] {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return []
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** getCell / forEachCell 共用同一份列清单：blob 与列承载字段一次取回。 */
const SELECT_COLS = 'blob, confidence, support, topic, digest, t_invalid, scope, session, lens, tags'
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
    tags: (c.tags ?? []).join(','),
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
  private accessLog: AccessRecord[] = []
  private retention = new Map<string, { score: number; band: number; at: number }>()
  /** v0.6.2：token → document frequency，与 docs 一起构成 IDF 的原料。 */
  private tokenDfMap = new Map<string, number>()
  private tokenDocs = 0

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
  findByPrefix(prefix: number): bigint | null {
    const want = prefix >>> 0
    for (const c of this.cells.values()) {
      if (Number(c.cellId & 0xffffffffn) === want) return c.cellId
    }
    return null
  }
  findBySuffix(suffix: string, limit = 8): bigint[] {
    const clean = suffix.toLowerCase()
    const out: bigint[] = []
    for (const [k, c] of this.cells) {
      if (k.endsWith(clean)) out.push(c.cellId)
      if (out.length >= limit) break
    }
    return out
  }
  cellsInTimeRange(from: number, to: number): bigint[] {
    const out: bigint[] = []
    for (const c of this.cells.values()) {
      const tf = Number(c.tFrom)
      if (tf >= from && tf <= to) out.push(c.cellId)
    }
    return out
  }
  setRetention(cellId: bigint, score: number, band: number, at: number): void {
    this.retention.set(idKey(cellId), { score, band, at })
  }
  retentionOf(cellId: bigint): { score: number; band: number; at: number } | null {
    return this.retention.get(idKey(cellId)) ?? null
  }
  demotableByCache(limit: number): bigint[] {
    const out: Array<{ id: bigint; at: number }> = []
    for (const [k, r] of this.retention) {
      const c = this.cells.get(k)
      if (!c) continue
      if (c.tier >= 4) continue
      if (5 - r.band > c.tier) out.push({ id: c.cellId, at: r.at })
    }
    out.sort((a, b) => a.at - b.at)
    return out.slice(0, limit).map((x) => x.id)
  }
  stalestForRetention(limit: number, before: number): bigint[] {
    const out: Array<{ id: bigint; at: number }> = []
    for (const [k, c] of this.cells) {
      if (c.flags & 2) continue // FLAG.noDecay：永不评估
      if (c.tier >= 4) continue
      const at = this.retention.get(k)?.at ?? 0
      if (at >= before) continue
      out.push({ id: c.cellId, at })
    }
    out.sort((a, b) => a.at - b.at)
    return out.slice(0, limit).map((x) => x.id)
  }
  invalidateRetention(cellId: bigint): void {
    this.retention.delete(idKey(cellId))
  }
  clearRetention(): void {
    this.retention.clear()
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
  allEdges(limit?: number): EdgeRecord[] {
    const list = limit ? this.edgeList.slice(0, limit) : this.edgeList
    return list.map((e) => ({ ...e }))
  }
  counts(): ReturnType<Store['counts']> {
    const byKind: Record<string, number> = {}
    const byTier: Record<string, number> = {}
    let supportOne = 0
    let disputed = 0
    let invalidated = 0
    for (const c of this.cells.values()) {
      byKind[String(c.kind)] = (byKind[String(c.kind)] ?? 0) + 1
      byTier[String(c.tier)] = (byTier[String(c.tier)] ?? 0) + 1
      if (c.support <= 1) supportOne++
      if (c.flags & 4) disputed++
      if (Number(c.tInvalid ?? 0) !== 0) invalidated++
    }
    return {
      byKind,
      byTier,
      supportOne,
      disputed,
      invalidated,
      contradictions: this.edgeList.filter((e) => e.rel === 8).length,
    }
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
    if (!c) return null
    try {
      return decompress(c.codec, c.bytes, c.rawLen)
    } catch {
      // v0.7.2 F8：损坏的残差不返回压缩字节冒充原文，交给上层退回摘要。
      return null
    }
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
  listSnapshots(limit = 1000): SnapshotRecord[] {
    return [...this.snaps.values()].slice(-Math.max(1, limit))
  }
  appendAccess(rec: AccessRecord): void {
    this.accessLog.push({ ...rec })
    if (this.accessLog.length > 10_000) this.accessLog.splice(0, this.accessLog.length - 10_000)
  }
  listAccess(limit = 1000): AccessRecord[] {
    return this.accessLog.slice(-Math.max(1, limit))
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
    for (const k of [...this.retention.keys()]) if (!this.cells.has(k)) this.retention.delete(k)
    // 全量清空时词频表一起清（与 SqliteStore 同口径）
    if (preserveKinds.length === 0) this.clearTokenDf()
  }

  bumpTokenDf(tokens: Iterable<string>): void {
    let n = 0
    for (const t of tokens) {
      if (!t) continue
      this.tokenDfMap.set(t, (this.tokenDfMap.get(t) ?? 0) + 1)
      n++
    }
    if (n > 0) this.tokenDocs++
  }

  tokenDf(tokens: readonly string[]): { df: Map<string, number>; docs: number } {
    const df = new Map<string, number>()
    for (const t of tokens) {
      const v = this.tokenDfMap.get(t)
      if (v !== undefined) df.set(t, v)
    }
    return { df, docs: this.tokenDocs }
  }

  clearTokenDf(): void {
    this.tokenDfMap.clear()
    this.tokenDocs = 0
  }

  purgeAux(target: { kind: 'session'; id: string } | { kind: 'all' } | { kind: 'cell'; id: string }): {
    log: number
    snapshots: number
    evicts: number
    shadow: number
    sources: number
  } {
    const all = target.kind === 'all'
    const sid = target.kind === 'session' ? target.id : ''
    const out = { log: 0, snapshots: 0, evicts: 0, shadow: 0, sources: 0 }
    /**
     * v0.7.2 F1：单 cell 只清自己的派生行，绝不动整轮日志与其它 cell。
     * 内存驱动与 SQLite 驱动必须给出等价的回执，否则测试里"删干净"是假象。
     */
    if (target.kind === 'cell') {
      const cid = target.id
      const short = cid.slice(-4)
      const beforeEv = this.evicts.length
      this.evicts = this.evicts.filter((e) => !String(e.cellId).endsWith(short))
      out.evicts = beforeEv - this.evicts.length
      const src = this.sources.get(cid)
      if (src) {
        out.sources = src.length
        this.sources.delete(cid)
      }
      for (const [k, v] of [...this.snaps]) {
        if (v.rendered.includes(short)) {
          this.snaps.delete(k)
          out.snapshots++
        }
      }
      return out
    }
    const before = this.logs.length
    if (all) this.logs = []
    else this.logs = this.logs.filter((e) => e.session !== sid)
    out.log = before - this.logs.length
    /** 该会话 cell 的短 id 集合：快照与驱逐记录都按它关联（删 cell 之前算）。 */
    const shorts = all ? null : new Set<string>()
    if (shorts) {
      for (const [cid, srcs] of this.sources) if (srcs.some((s) => s.session === sid)) shorts.add(String(cid).slice(-4))
    }
    if (all) {
      out.snapshots = this.snaps.size
      this.snaps.clear()
      out.evicts = this.evicts.length
      this.evicts = []
      this.accessLog = []
    } else {
      const keys = [...(shorts ?? [])]
      // 旧实现在这里"报数不删"（out.snapshots = size 但只有 all 分支才 clear），
      // 会话级删除其实把渲染过的记忆文本全留在内存里。两种驱动现在都真删。
      for (const [k, v] of [...this.snaps]) {
        if (keys.some((sh) => v.rendered.includes(sh))) {
          this.snaps.delete(k)
          out.snapshots++
        }
      }
      const beforeEv = this.evicts.length
      this.evicts = this.evicts.filter((e) => !keys.some((sh) => String(e.cellId).endsWith(sh)))
      out.evicts = beforeEv - this.evicts.length
    }
    for (const k of [...this.shadow]) {
      if (all || k.startsWith(sid + '#')) {
        this.shadow.delete(k)
        out.shadow++
      }
    }
    for (const [k, v] of [...this.sources]) {
      const keep = all ? [] : v.filter((s) => s.session !== sid)
      out.sources += v.length - keep.length
      if (keep.length === 0) this.sources.delete(k)
      else this.sources.set(k, keep)
    }
    return out
  }

  tryAcquireLock(key: string, owner: string, ttlMs: number): boolean {
    const k = 'lock:' + key
    const now = Date.now()
    const cur = parseLock(this.kv.get(k))
    if (cur && cur.owner !== owner && cur.expiresAt > now) return false
    this.kv.set(k, JSON.stringify([owner, now + lockTtl(ttlMs)]))
    return true
  }
  releaseLock(key: string, owner: string): boolean {
    const k = 'lock:' + key
    const cur = parseLock(this.kv.get(k))
    if (!cur || cur.owner !== owner) return false
    this.kv.delete(k)
    return true
  }
  lockInfo(key: string): { owner: string; expiresAt: number } | null {
    return parseLock(this.kv.get('lock:' + key))
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
  -- v0.7.0：策略标记（crisis/minor/instruction/sensitive）。列承载而不是进 blob，
  -- 因为 MC03 的 flags 只有 1 字节且已占满——扩它要 rebuild，加列不用。
  tags        TEXT    NOT NULL DEFAULT '',
  blob        BLOB    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scope ON cells(scope, kind);
CREATE INDEX IF NOT EXISTS idx_time  ON cells(t_from, t_to);
CREATE INDEX IF NOT EXISTS idx_tier  ON cells(tier);
CREATE INDEX IF NOT EXISTS idx_kind  ON cells(kind);
-- 低 32 位前缀索引：cell_id 是 16 位 hex，末 8 位就是 Edge.targetPrefix。
-- 没有它，resolveByPrefix 只能全表扫描（每条边一次），见 v0.4 方案 §1.4。
CREATE INDEX IF NOT EXISTS idx_cells_prefix ON cells(substr(cell_id, 9));

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

-- v0.7.2（E10）：原始记忆访问审计。独立表，不进 MC03 blob，旧库免 rebuild。
CREATE TABLE IF NOT EXISTS access_log (
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  chars  INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_access_at ON access_log(at);

CREATE TABLE IF NOT EXISTS shadow_map (
  session TEXT NOT NULL, seq INTEGER NOT NULL,
  PRIMARY KEY (session, seq)
);

CREATE TABLE IF NOT EXISTS evict_log (
  cell_id TEXT NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL,
  actor TEXT NOT NULL, at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- 保留度缓存（v0.5.2）。**不进 MC03 blob、不改 cells 表**，所以旧库不需要 rebuild。
-- 只存 score/band/at：七因子分解是面板逐条展示的内容，缓存成 JSON 会让存储涨约 20%，
-- 而面板只算最近 120 条（实测 2 ms），不值得为它付这个代价。
CREATE TABLE IF NOT EXISTS retention (
  cell_id TEXT PRIMARY KEY,
  score   REAL    NOT NULL,
  band    INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retention_at ON retention(at);

-- 会话日志的影子副本：只存"重建晶格所需的最小信息"（§14.11 晶格可重建）。
-- 它不替代 DSH 的 Session Log，只是让 /mnemo rebuild 不必依赖宿主回放接口。
CREATE TABLE IF NOT EXISTS session_log (
  session TEXT NOT NULL, seq INTEGER NOT NULL, turn INTEGER NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (session, seq)
);

-- 语料词频（v0.6.2 · IDF）。df = 出现过该 token 的 cell 数。
-- 独立表而不是塞进 cells：它只服务**查询侧剪枝**，与 cell 的生命周期无关，
-- 所以不需要跟着 rebuild 走，也不能进 MC03 布局（那要动 HEADER_SIZE）。
CREATE TABLE IF NOT EXISTS token_df (
  token TEXT PRIMARY KEY,
  df    INTEGER NOT NULL
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
    /**
     * 父目录归插件管（v0.6 · 修 D1）。
     *
     * `node:sqlite` 对不存在的目录只抛一句 `unable to open database file`，
     * 而默认库路径是 `~/.dsh/mnemo/vault.db`——全新机器上这个目录不存在。
     * 少了这一行，core 必然激活失败，而症状会甩给下游 6 层（全部 pending），
     * 用户看到的是"面板在、一条记忆都没有"。现场报告见
     * `docs/releases/v0.5.3-desktop-install-report.md` 的 D1。
     */
    if (this.path !== ':memory:' && !this.path.startsWith('file::memory:')) {
      mkdirSync(dirname(this.path), { recursive: true })
    }
    const mod = builtin<{ DatabaseSync: new (p: string) => SqliteDb }>('node:sqlite')
    const db = new mod.DatabaseSync(this.path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA foreign_keys = ON')
    // WAL 下多会话并发写会直接抛 SQLITE_BUSY 而不是排队等待。
    // 没有这一行，两个进程同时写就是随机失败——而这在"宿主 + 面板 + 巩固"三处并发时很常见。
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(DDL)
    /**
     * 增量列迁移（v0.7.0）。
     *
     * `CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做——所以给老库加列
     * 必须显式 `ALTER TABLE ADD COLUMN`。SQLite 的 ADD COLUMN 带默认值时是
     * 纯元数据操作（不重写行），因此这是安全且即时的，不需要 rebuild。
     *
     * 约定：**只加列，不改列、不删列**。改列语义（类型/精度）就得走 rebuild，
     * 那是另一条路径（`/mnemo rebuild --from-log`），不能混在这里悄悄发生。
     */
    this.migrateColumns(db)
    this.db = db
  }

  /** 幂等加列。每条都是 `ALTER TABLE cells ADD COLUMN <name> <ddl>`。 */
  private migrateColumns(db: SqliteDb): void {
    const want: Array<[string, string]> = [['tags', "TEXT NOT NULL DEFAULT ''"]]
    let have: Set<string>
    try {
      const rows = db.prepare('PRAGMA table_info(cells)').all() as Array<{ name?: string }>
      have = new Set(rows.map((r) => String(r.name ?? '')))
    } catch {
      return
    }
    for (const [name, ddl] of want) {
      if (have.has(name)) continue
      try {
        db.exec(`ALTER TABLE cells ADD COLUMN ${name} ${ddl}`)
      } catch (err) {
        /**
         * v0.7.2 F9：只忽略"另一进程已加过列"这一种并发情形。
         * 旧实现吞掉任意 ALTER 失败（磁盘满 / 只读库 / DDL 写错），
         * 结果 tags 列根本不存在，写入一路报错而 doctor 查不出根因。
         */
        if (!/duplicate column|already exists/i.test(String(err))) throw err
      }
    }
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
    this.prep(
        `INSERT INTO cells (cell_id,kind,tier,flags,t_from,t_to,t_ingest,t_access,access_cnt,
           stability,importance,valence,arousal,dominance,salience,provenance,trust,
           confidence,support,topic,digest,residual_sha,residual_off,residual_len,t_invalid,scope,session,lens,tags,blob)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
           lens=excluded.lens, tags=excluded.tags, blob=excluded.blob`,
      )
      .run(
        r.cell_id, r.kind, r.tier, r.flags, r.t_from, r.t_to, r.t_ingest, r.t_access, r.access_cnt,
        r.stability, r.importance, Math.round(r.valence * 1000), Math.round(r.arousal * 1000),
        Math.round(r.dominance * 1000), Math.round(r.salience * 1000),
        r.provenance, r.trust, r.confidence, r.support, r.topic, r.digest,
        r.residual_sha, r.residual_off, r.residual_len, Number(r.t_invalid ?? 0),
        r.scope ?? 'user:local', r.session ?? '', r.lens ?? 'fact', r.tags ?? '', r.blob,
      )
  }

  /** 读一条 cell：**一次** SQL 同时取 blob 与列承载字段（v0.3 是两趟）。 */
  getCell(id: bigint): MemCell | null {
    const row = this.prep(`${SELECT_CELL} WHERE cell_id = ?`).get(idKey(id)) as Record<string, unknown> | undefined
    if (!row) return null
    return this.hydrate(row)
  }

  /**
   * 32 位前缀查询：只取 id，不解 blob。
   *
   * 前缀是 cellId 的低 32 位，也就是 16 位 hex 的**末 8 位**，所以
   * `substr(cell_id, 9)` 正好命中 `idx_cells_prefix`（SQLite 的表达式索引）。
   * 之前这里用 forEachCell 全表扫描 + 每条解 blob，是 v0.3 最贵的一条路径。
   */
  findByPrefix(prefix: number): bigint | null {
    const hex = (prefix >>> 0).toString(16).padStart(8, '0')
    const row = this.prep('SELECT cell_id FROM cells WHERE substr(cell_id, 9) = ? LIMIT 1').get(hex) as
      | Record<string, unknown>
      | undefined
    return row ? BigInt('0x' + String(row.cell_id)) : null
  }

  findBySuffix(suffix: string, limit = 8): bigint[] {
    return this.prep('SELECT cell_id FROM cells WHERE cell_id LIKE ? LIMIT ?')
      .all(`%${suffix.toLowerCase()}`, Math.max(1, limit))
      .map((r) => BigInt('0x' + String(r.cell_id)))
  }

  /**
   * 时间区间查询（Q4 时间路）。
   *
   * `idx_time(t_from,t_to)` 从 v0.2 就建着，但 Q4 一直 `forEachCell` 全表扫。
   * 换成这条 SQL 之后，10 万 cell 下 Q4 从"解 10 万个 blob"变成"取几十个 id"。
   */
  cellsInTimeRange(from: number, to: number): bigint[] {
    return this.prep('SELECT cell_id FROM cells WHERE t_from >= ? AND t_from <= ?')
      .all(from, to)
      .map((r) => BigInt('0x' + String(r.cell_id)))
  }

  setRetention(cellId: bigint, score: number, band: number, at: number): void {
    this.prep(
      'INSERT INTO retention (cell_id,score,band,at) VALUES (?,?,?,?) ON CONFLICT(cell_id) DO UPDATE SET score=excluded.score, band=excluded.band, at=excluded.at',
    ).run(idKey(cellId), score, band, at)
  }

  retentionOf(cellId: bigint): { score: number; band: number; at: number } | null {
    const r = this.prep('SELECT score,band,at FROM retention WHERE cell_id = ?').get(idKey(cellId))
    return r ? { score: Number(r.score), band: Number(r.band), at: Number(r.at) } : null
  }

  /**
   * 单调性剪枝的快路径：缓存里已经判定"该降"的，直接降，不再算七因子。
   *
   * `(5 - band) > tier` 把"档位编号"翻成"tier 编号"（P5→0 … P1→4）再比。
   * `tier < 4` 排除墓碑：墓碑不参与任何自动流转（复活只能由用户发起）。
   */
  demotableByCache(limit: number): bigint[] {
    return this.prep(
      `SELECT c.cell_id AS id FROM retention r JOIN cells c ON c.cell_id = r.cell_id
        WHERE (5 - r.band) > c.tier AND c.tier < 4 AND (c.flags & 2) = 0
        ORDER BY r.at ASC LIMIT ?`,
    )
      .all(Math.max(1, limit))
      .map((r) => BigInt('0x' + String(r.id)))
  }

  stalestForRetention(limit: number, before: number): bigint[] {
    return this.prep(
      `SELECT c.cell_id AS id FROM cells c LEFT JOIN retention r ON r.cell_id = c.cell_id
        WHERE c.tier < 4 AND (c.flags & 2) = 0 AND COALESCE(r.at, 0) < ?
        ORDER BY COALESCE(r.at, 0) ASC LIMIT ?`,
    )
      .all(before, Math.max(1, limit))
      .map((r) => BigInt('0x' + String(r.id)))
  }

  invalidateRetention(cellId: bigint): void {
    this.prep('DELETE FROM retention WHERE cell_id = ?').run(idKey(cellId))
  }

  clearRetention(): void {
    this.conn.exec('DELETE FROM retention')
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
    cell.tags = parseTags(row.tags)
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
    /**
     * v0.7.2 F10：`filter.limit` 可能来自宿主手写配置（NaN / Infinity / 字符串）。
     * 旧写法 `Math.floor(NaN)` 会拼出 `LIMIT NaN`，让整条查询抛语法错误。
     */
    const lim = Number.isFinite(filter.limit) ? Math.max(1, Math.floor(filter.limit as number)) : 0
    const sql = `${SELECT_CELL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t_from ${order} ${
      lim > 0 ? 'LIMIT ' + lim : ''
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
    this.prep(
      'INSERT INTO edges (src,dst,rel,weight) VALUES (?,?,?,?) ON CONFLICT(src,dst,rel) DO UPDATE SET weight=excluded.weight',
    ).run(idKey(e.src), idKey(e.dst), e.rel, e.weight)
  }
  edgesFrom(id: bigint): EdgeRecord[] {
    return this.prep('SELECT src,dst,rel,weight FROM edges WHERE src = ?')
      .all(idKey(id))
      .map((r) => ({ src: BigInt('0x' + String(r.src)), dst: BigInt('0x' + String(r.dst)), rel: Number(r.rel), weight: Number(r.weight) }))
  }
  edgesTo(id: bigint): EdgeRecord[] {
    return this.prep('SELECT src,dst,rel,weight FROM edges WHERE dst = ?')
      .all(idKey(id))
      .map((r) => ({ src: BigInt('0x' + String(r.src)), dst: BigInt('0x' + String(r.dst)), rel: Number(r.rel), weight: Number(r.weight) }))
  }
  allEdges(limit?: number): EdgeRecord[] {
    const sql = limit ? 'SELECT src,dst,rel,weight FROM edges LIMIT ?' : 'SELECT src,dst,rel,weight FROM edges'
    return this.prep(sql)
      .all(...(limit ? [Math.max(1, limit)] : []))
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
    this.prep('INSERT INTO residuals (sha,offset,raw_len,comp_len,ref_cnt,codec,data) VALUES (?,?,?,?,1,?,?)').run(
      sha,
      off,
      c.rawLen,
      c.bytes.length,
      c.codec,
      c.bytes,
    )
    return off
  }
  /** 残差正文与索引同库（冷层可外迁到对象存储，接口不变）。 */
  getResidual(off: number): Uint8Array | null {
    const r = this.prep('SELECT data,codec,raw_len FROM residuals WHERE offset = ?').get(off)
    if (!r) return null
    try {
      return decompress(String(r.codec), new Uint8Array(r.data as Uint8Array), Number(r.raw_len))
    } catch {
      // v0.7.2 F8：残差损坏 → 返回 null，expand 退回结构化摘要而不是渲染乱码。
      return null
    }
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
    const rows = this.prep(
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
    this.prep('INSERT INTO cell_sources (cell_id,session,seq) VALUES (?,?,?) ON CONFLICT DO NOTHING').run(
      idKey(cellId),
      session,
      seq,
    )
  }
  sourcesOf(cellId: bigint): Array<{ session: string; seq: number }> {
    return this.prep('SELECT session,seq FROM cell_sources WHERE cell_id = ? ORDER BY seq')
      .all(idKey(cellId))
      .map((r) => ({ session: String(r.session), seq: Number(r.seq) }))
  }
  cellsOfSession(session: string): bigint[] {
    return this.prep('SELECT DISTINCT cell_id FROM cell_sources WHERE session = ?')
      .all(session)
      .map((r) => BigInt('0x' + String(r.cell_id)))
  }

  putSnapshot(rendered: string, tokens: number): string {
    const id = snapshotIdOf(rendered)
    this.prep('INSERT INTO recall_snapshots (snap_id,rendered,tokens,created) VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(
      id,
      rendered,
      tokens,
      Date.now(),
    )
    return id
  }
  listSnapshots(limit = 1000): SnapshotRecord[] {
    return this.prep('SELECT * FROM recall_snapshots ORDER BY created DESC LIMIT ?')
      .all(Math.max(1, limit))
      .map((r) => ({
        snapId: String(r.snap_id),
        rendered: String(r.rendered),
        tokens: Number(r.tokens),
        created: Number(r.created),
      }))
  }
  appendAccess(rec: AccessRecord): void {
    this.prep('INSERT INTO access_log (at,actor,action,target,chars,reason) VALUES (?,?,?,?,?,?)').run(
      rec.at,
      rec.actor,
      rec.action,
      rec.target,
      Number.isFinite(rec.chars) ? rec.chars : 0,
      rec.reason ?? '',
    )
  }
  listAccess(limit = 1000): AccessRecord[] {
    return this.prep('SELECT * FROM access_log ORDER BY at DESC LIMIT ?')
      .all(Math.max(1, limit))
      .map((r) => ({
        at: Number(r.at),
        actor: String(r.actor),
        action: String(r.action),
        target: String(r.target),
        chars: Number(r.chars),
        reason: String(r.reason ?? ''),
      }))
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
    this.prep('INSERT INTO evict_log (cell_id,mode,reason,actor,at) VALUES (?,?,?,?,?)').run(
      rec.cellId,
      rec.mode,
      rec.reason,
      rec.actor,
      rec.at,
    )
  }
  recentEvicts(n: number): EvictRecord[] {
    return this.prep('SELECT * FROM evict_log ORDER BY at DESC LIMIT ?')
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
    this.prep('INSERT INTO session_log (session,seq,turn,role,text,at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING').run(
      e.session,
      e.seq,
      e.turn,
      e.role,
      e.text,
      e.at,
    )
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
      // 全量清空时词频表一起清：文档没了，df 就是脏数据。
      this.conn.exec('DELETE FROM cells; DELETE FROM edges; DELETE FROM cell_sources; DELETE FROM retention; DELETE FROM token_df;')
      this.setMeta('token_df.docs', '0')
      return
    }
    const list = preserveKinds.map((k) => Math.floor(k)).join(',')
    this.conn.exec(
      `DELETE FROM cells WHERE kind NOT IN (${list}); DELETE FROM edges; DELETE FROM cell_sources;
       DELETE FROM retention WHERE cell_id NOT IN (SELECT cell_id FROM cells);`,
    )
  }

  /**
   * 累加词频（v0.6.2 · IDF）。
   *
   * 走 upsert：`ON CONFLICT DO UPDATE SET df = df + 1`。
   * 用一条 prepared statement 在循环里跑，而不是拼一条多值 INSERT——
   * 查询侧只有 24 个 token，往返开销可以忽略，而多值 SQL 要处理参数上限。
   */
  bumpTokenDf(tokens: Iterable<string>): void {
    const stmt = this.prep('INSERT INTO token_df(token, df) VALUES(?, 1) ON CONFLICT(token) DO UPDATE SET df = df + 1')
    let n = 0
    for (const t of tokens) {
      if (!t) continue
      stmt.run(t)
      n++
    }
    if (n > 0) this.setMeta('token_df.docs', String(this.tokenDocs() + 1))
  }

  tokenDf(tokens: readonly string[]): { df: Map<string, number>; docs: number } {
    const stmt = this.prep('SELECT df FROM token_df WHERE token = ?')
    const df = new Map<string, number>()
    for (const t of tokens) {
      const row = stmt.get(t) as { df?: number } | undefined
      if (row && row.df !== undefined) df.set(t, Number(row.df))
    }
    return { df, docs: this.tokenDocs() }
  }

  clearTokenDf(): void {
    this.conn.exec('DELETE FROM token_df;')
    this.setMeta('token_df.docs', '0')
  }

  /**
   * 派生表级联清理（v0.7.0）。
   *
   * 会话级：只删该会话的行（`session_log` / `shadow_map` / `cell_sources` / `evict_log`）。
   * 全库级：连 `recall_snapshots` 一起清——快照是**渲染过的记忆文本**，
   * 只要有一份留在盘上，"已删除"就不成立。
   *
   * 返回每张表的删除行数：用户有权知道删干净没有。
   */
  purgeAux(target: { kind: 'session'; id: string } | { kind: 'all' } | { kind: 'cell'; id: string }): {
    log: number
    snapshots: number
    evicts: number
    shadow: number
    sources: number
  } {
    const count = (sql: string, ...args: unknown[]): number => {
      const row = this.prep(sql).get(...(args as never[])) as { n?: number } | undefined
      return Number(row?.n ?? 0)
    }
    const run = (sql: string, ...args: unknown[]): void => {
      this.prep(sql).run(...(args as never[]))
    }
    if (target.kind === 'all') {
      const log = count('SELECT COUNT(*) AS n FROM session_log')
      const snapshots = count('SELECT COUNT(*) AS n FROM recall_snapshots')
      const evicts = count('SELECT COUNT(*) AS n FROM evict_log')
      const shadow = count('SELECT COUNT(*) AS n FROM shadow_map')
      const sources = count('SELECT COUNT(*) AS n FROM cell_sources')
      this.conn.exec('DELETE FROM session_log; DELETE FROM recall_snapshots; DELETE FROM evict_log; DELETE FROM shadow_map; DELETE FROM cell_sources; DELETE FROM access_log;')
      return { log, snapshots, evicts, shadow, sources }
    }
    /**
     * v0.7.2 F1：单 cell 分支。只删**这条 cell 自己**的派生行——
     * `cell_sources` / `evict_log`，以及渲染文本里出现该 cell 短 id 的快照。
     * 会话日志与影子表是**按轮共享**的，一条 cell 无权删掉整轮的原文。
     * （`evict_log.cell_id` 历史上既存过短 id 也存过完整 hex，用后 4 位统一匹配。）
     */
    if (target.kind === 'cell') {
      const cid = target.id
      const short = cid.slice(-4)
      const evicts = count('SELECT COUNT(*) AS n FROM evict_log WHERE substr(cell_id, -4) = ?', short)
      const sources = count('SELECT COUNT(*) AS n FROM cell_sources WHERE cell_id = ?', cid)
      const snapshots = count('SELECT COUNT(*) AS n FROM recall_snapshots WHERE instr(rendered, ?) > 0', short)
      run('DELETE FROM evict_log WHERE substr(cell_id, -4) = ?', short)
      run('DELETE FROM cell_sources WHERE cell_id = ?', cid)
      run('DELETE FROM recall_snapshots WHERE instr(rendered, ?) > 0', short)
      return { log: 0, snapshots, evicts, shadow: 0, sources }
    }
    const sid = target.id
    /**
     * ⚠ 调用约定：会话级清理必须在**删 cell 之前**调用。
     * `cell_sources` 与 `evict_log` 都没有 session 列，只能经 `cells.session` 关联；
     * cell 一旦删掉，关联就断了，计数与删除都会静默变成 0。
     */
    const log = count('SELECT COUNT(*) AS n FROM session_log WHERE session = ?', sid)
    const shadow = count('SELECT COUNT(*) AS n FROM shadow_map WHERE session = ?', sid)
    const evicts = count(
      'SELECT COUNT(*) AS n FROM evict_log WHERE cell_id IN (SELECT cell_id FROM cells WHERE session = ?)',
      sid,
    )
    const sources = count(
      'SELECT COUNT(*) AS n FROM cell_sources WHERE cell_id IN (SELECT cell_id FROM cells WHERE session = ?)',
      sid,
    )
    run('DELETE FROM session_log WHERE session = ?', sid)
    run('DELETE FROM shadow_map WHERE session = ?', sid)
    run('DELETE FROM evict_log WHERE cell_id IN (SELECT cell_id FROM cells WHERE session = ?)', sid)
    run('DELETE FROM cell_sources WHERE cell_id IN (SELECT cell_id FROM cells WHERE session = ?)', sid)
    /**
     * v0.7.2 F1：旧实现会话级恒返回 `snapshots: 0` 且**一行也不删**。
     * 回执上"快照 0 行"看起来像"本来就没有"，实际渲染过的记忆文本还留在盘上，
     * 红线 2「无法真正删除」在会话路径上并未闭合。
     * 用关联子查询按该会话 cell 的 4 位短 id 定位快照（必须在删 cell **之前**跑）。
     */
    const snapWhere = 'EXISTS (SELECT 1 FROM cells c WHERE c.session = ? AND instr(s.rendered, substr(c.cell_id, 13)) > 0)'
    const snapshots = count(`SELECT COUNT(*) AS n FROM recall_snapshots s WHERE ${snapWhere}`, sid)
    run(
      `DELETE FROM recall_snapshots WHERE snap_id IN (SELECT s.snap_id FROM recall_snapshots s WHERE ${snapWhere})`,
      sid,
    )
    return { log, snapshots, evicts, shadow, sources }
  }

  private tokenDocs(): number {
    return Number(this.meta('token_df.docs') ?? 0) || 0
  }

  tryAcquireLock(key: string, owner: string, ttlMs: number): boolean {
    const k = 'lock:' + key
    const now = Date.now()
    /**
     * `write()` 是 BEGIN IMMEDIATE：SQLite 会序列化跨进程的写事务，
     * 于是"读锁 → 判过期 → 写锁"整体原子，check-then-set 不再是竞态。
     * 这是多进程场景与旧实现最本质的区别（旧实现两条独立语句无事务）。
     */
    return this.write(() => {
      const row = this.prep('SELECT v FROM meta WHERE k = ?').get(k) as { v?: string } | undefined
      const cur = parseLock(row?.v)
      if (cur && cur.owner !== owner && cur.expiresAt > now) return false
      this.prep('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(
        k,
        JSON.stringify([owner, now + lockTtl(ttlMs)]),
      )
      return true
    })
  }
  releaseLock(key: string, owner: string): boolean {
    const k = 'lock:' + key
    return this.write(() => {
      const row = this.prep('SELECT v FROM meta WHERE k = ?').get(k) as { v?: string } | undefined
      const cur = parseLock(row?.v)
      if (!cur || cur.owner !== owner) return false
      this.prep('DELETE FROM meta WHERE k = ?').run(k)
      return true
    })
  }
  lockInfo(key: string): { owner: string; expiresAt: number } | null {
    const row = this.prep('SELECT v FROM meta WHERE k = ?').get('lock:' + key) as { v?: string } | undefined
    return parseLock(row?.v)
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

  counts(): ReturnType<Store['counts']> {
    const byKind: Record<string, number> = {}
    const byTier: Record<string, number> = {}
    for (const r of this.prep('SELECT kind, COUNT(*) AS n FROM cells GROUP BY kind').all()) {
      byKind[String(r.kind)] = Number(r.n)
    }
    for (const r of this.prep('SELECT tier, COUNT(*) AS n FROM cells GROUP BY tier').all()) {
      byTier[String(r.tier)] = Number(r.n)
    }
    const agg = this.prep(
      `SELECT
         COALESCE(SUM(CASE WHEN support <= 1 THEN 1 ELSE 0 END), 0) AS support_one,
         COALESCE(SUM(CASE WHEN (flags & 4) != 0 THEN 1 ELSE 0 END), 0) AS disputed,
         COALESCE(SUM(CASE WHEN t_invalid != 0 THEN 1 ELSE 0 END), 0) AS invalidated
       FROM cells`,
    ).get()
    const contra = this.prep('SELECT COUNT(*) AS n FROM edges WHERE rel = 8').get()
    return {
      byKind,
      byTier,
      supportOne: Number(agg?.support_one ?? 0),
      disputed: Number(agg?.disputed ?? 0),
      invalidated: Number(agg?.invalidated ?? 0),
      contradictions: Number(contra?.n ?? 0),
    }
  }

  stats() {
    const c = this.prep('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(blob)),0) AS b FROM cells').get()
    const e = this.prep('SELECT COUNT(*) AS n FROM edges').get()
    const r = this.prep('SELECT COUNT(*) AS n, COALESCE(SUM(comp_len),0) AS b, COALESCE(SUM(raw_len),0) AS raw FROM residuals').get()
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
