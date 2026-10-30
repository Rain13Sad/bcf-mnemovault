/**
 * MemoryService —— 晶格读写 / 四路召回 / 巩固调度（§14.3 / §15.4 / §15.7）
 *
 * 热重载契约（§14.7）在这个类里落地的具体形态：
 *   · 所有副作用（DB 连接、定时器、文件句柄）由 apply() 的 ctx.effect 持有，类本身不建定时器
 *   · 没有模块级可变状态，状态全挂实例
 *   · open() 幂等，可重复调用
 *   · 热层缓存从 DB 重建，不假设常驻
 *   · 布局版本门控：magic/version/dim 不匹配就拒绝启动并提示 rebuild
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  FLAG,
  KIND,
  KIND_NAME,
  REL,
  REL_NAME,
  SLOT_ROLE,
  SLOT_ROLE_NAME,
  deriveCellId,
  encodeCell,
  foldEmb,
  pq4,
  topicOf,
  type CellKind,
  type MemCell,
  type Slot,
} from './cell.js'
import { BruteIndex, HnswIndex, type VectorIndex } from './ann.js'
import { RuntimeStatus } from './runtime.js'
import { RETENTION_WEIGHTS, DISPOSITION_FLOOR, INVALID_GRACE_MS, evaluateRetention, retentionWhy, type Disposition } from './retention.js'
import { BitInvertedIndex, minOverlapForJaccard, type SdrCandidate } from './inverted.js'
import { EmbIndex } from './emb.js'
import { applyReconsolidation, onRetrieved } from './reconsolidation.js'
import { graphHopsFor, modeOf, neuromodulate, retrievalTemperature } from './neuromod.js'
import { nextTier } from './lifecycle.js'
import type { PresetName } from './preset.js'
import { estimateTokens, fmt2, mmdd, assignShortIds, kvPairs } from './render.js'
import { formatBreakdown, runRecall, SIM_FLOOR } from './recall.js'
import { SdrSpace } from './sdr.js'
import { createStore, type EvictRecord, type Store } from './store.js'
import { SensoryRing, WorkingSet } from './working.js'
import { applyPreset } from './preset.js'
import { hash64, toHex } from './hash.js'
import { redact, isRedactionPlaceholder } from './text.js'
import type {
  DoctorReport,
  ExpandResult,
  MnemoConfig,
  PanelAction,
  PanelCellView,
  PanelEdgeView,
  PanelRetentionEntry,
  PanelSnapshot,
  RecallQuery,
  RecallResult,
  StatsSnapshot,
} from './types.js'

export interface IngestResult {
  cell: MemCell
  action: 'created' | 'merged' | 'linked' | 'conflict'
  conflictWith?: string
  mergedInto?: string
}

export interface MemoryServiceOptions {
  config: MnemoConfig
  /** 作用域键：单机 'user:local'；多用户部署传 'user:<id>'（§14.10） */
  scopeKey?: string
  store?: Store
  now?: () => number
  /** 面板快照落盘路径；undefined 则不落盘（测试/浏览器） */
  panelPath?: string
  /** 运行时状态登记处（L1 / 命令面 / remote 面），由 core 注入 */
  runtime?: RuntimeStatus
}

export class MemoryService extends Service {
  readonly space: SdrSpace
  readonly store: Store
  /** 感觉记忆：原始输入环形缓冲，TTL 2 轮，不落盘（§8.1） */
  readonly sensory = new SensoryRing()
  /** 工作记忆：本轮摸过的 cell 引用集，硬上限 16（§8.2） */
  readonly working = new WorkingSet(16)
  /** 作用域键（§14.10）：所有新写入的 cell 默认落在这个作用域里 */
  readonly scopeKey: string
  config: MnemoConfig
  private now: () => number
  private readonly panelPath?: string
  private readonly runtime: RuntimeStatus
  private opened = false
  /** 向量索引（懒建；小库不建，见 annMode） */
  private ann: VectorIndex | null = null
  private annBuilds = 0
  private annBuildMs = 0
  private lastConsolidation: PanelSnapshot['consolidation'] = null
  private panelTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  private tokenSeries: Array<{ turn: number; tokens: number }> = []
  private recalls = 0
  private hitRecalls = 0
  private latencies: number[] = []
  private evictions = 0
  private turns = 0
  private lastRecall: PanelSnapshot['lastRecall'] = null
  private affectState: PanelSnapshot['affect'] = null
  /**
   * 再巩固日志（v0.4）。只留最近 40 条：它不是审计日志，是"最近哪条记忆被改写过"的证据，
   * 面板的保留度页直接读它。全量历史在 evict_log / session_log 里，不在这里重复存。
   */
  private reconsolidationLog: Array<{ at: number; cellId: string; dStability: number; dConfidence: number; dValence: number; plastic: boolean }> = []
  /**
   * 本轮是否发生了"用户纠正"。由 ingest 的冲突检测置位、被下一次 recall 消费。
   *
   * 这是预测误差的**可用代理**：真正的预测误差需要宿主回传用户下一句的语义反馈，
   * 而那需要改宿主接口（v0.5 的 seam）。在此之前，"这一轮检测到矛盾"是唯一
   * 确定"新信息与旧记忆不符"的时刻——用它标记可塑窗口，比拿查询距离当代理准确得多。
   */
  private pendingPredictionError = 0
  private listeners = new Set<(s: PanelSnapshot) => void>()
  private pendingActions: PanelAction[] = []
  /** 单会话内每个 cell 的展开次数（§14.9：上限 2 次） */
  private expandCounts = new Map<string, number>()

  /**
   * SDR 倒排索引（v0.5.2）。懒构建：第一次 ingest/recall 时才建，避免"库很小却先花 200 ms"。
   *
   * `sdrIndexedCount` 是"索引认为自己有多少条"。它和 `store.countCells()` 不一致时说明
   * 有**绕过本服务**的写入（巩固 pass 会直接 `store.putCell`），此时整体重建一次。
   * 这个自愈判据让索引不必知道巩固器的存在，也不会静默错。
   */
  private sdrIndex: BitInvertedIndex | null = null
  private sdrIndexedCount = -1
  private sdrBuildMs = 0

  /**
   * 冲突检测索引：`agent|谓词家族` → cellId[]（v0.5.2）。
   *
   * `findConflict` 原来全表扫，而它只需要看"同 agent、同谓词家族"的那几条——
   * 通常 1~3 条。10 万 cell 下一次 ingest 因此从"解 10 万个 blob"变成"读 2 条"。
   */
  private conflictIndex = new Map<string, bigint[]>()
  private conflictIndexedCount = -1

  /**
   * 向量矩阵（v0.5.2）。与 SDR 倒排同生命周期：懒构建、增量维护、超预算停用。
   *
   * 它替代的不是 cosine，而是 `forEachCell`——Q1 为了算 128 次乘加，
   * 原来要把全库的 MC03 blob 解一遍。10 万 cell 下解码是几十万次对象分配，
   * 比计算本身贵两个数量级（实测 822 cell 一次召回 18 ms，其中绝大部分是解码）。
   */
  private embIndex: EmbIndex | null = null
  private embIndexedCount = -1
  private embBuildMs = 0

  /** 图上最大度数（保留度 connectivity 的归一化分母），由 demoteDue 维护 */
  private maxDegreeCache = 8

  constructor(ctx: Context, opts: MemoryServiceOptions) {
    super(ctx, 'memory')
    this.config = opts.config
    this.scopeKey = opts.scopeKey ?? 'user:local'
    this.now = opts.now ?? (() => Date.now())
    this.space = new SdrSpace({ dim: opts.config.sdrDim, k: opts.config.sdrK })
    this.store = opts.store ?? createStore({ path: opts.config.dbPath, space: this.space })
    this.panelPath = opts.panelPath
    this.runtime = opts.runtime ?? new RuntimeStatus()
  }

  /**
   * 注入时钟（v0.5.1）。
   *
   * devkit 的 `createHarness({ now })` 之前只喂给了事件时间戳，`MemoryService`
   * 仍然读 `Date.now()`——于是"把时钟推到 1000 天后"的时间旅行测试是**静默失效**的：
   * `demoteDue` 看到的 `now - tAccess` 依然接近 0，直接按"刚访问过"跳过。
   * 现在 harness 会在拿到服务后调这里，测试里 `h.now()` 与 `memory.nowMs()` 必须相等。
   */
  setClock(fn: () => number): void {
    this.now = fn
  }

  // ── 生命周期 ─────────────────────────────────────────────────────

  /** 幂等启动。返回逆序释放函数（索引 → 连接，§14.7）。 */
  open(): () => void {
    if (this.opened) return () => this.close()
    this.store.open()
    const meta = this.store.meta('layout')
    // 布局键必须包含落盘向量维度：MC03 把 emb 折到 embStoreDim 存，
    // 只比较 embDim 会让"改了 embStoreDim 却复用旧库"这种事故静默通过。
    const expect = `${this.config.sdrDim}:${this.config.sdrK}:${this.config.embStoreDim}:3`
    if (meta && meta !== expect) {
      this.store.close()
      throw new Error(
        `[mnemo] 布局不匹配：库为 ${meta}，配置为 ${expect}。` +
          `MC03 换了存储布局（192→112 B 头、稀疏 SDR、64 维向量），旧库必须 /mnemo rebuild --from-log（§12.8）。`,
      )
    }
    if (!meta) this.store.setMeta('layout', expect)
    this.store.setMeta('layoutVersion', '3')
    this.opened = true
    return () => this.close()
  }

  close(): void {
    this.closed = true
    if (this.panelTimer) {
      clearTimeout(this.panelTimer)
      this.panelTimer = null
    }

    if (!this.opened) return
    this.opened = false
    try {
      this.store.close()
    } catch {
      /* 关闭失败不掩盖原始错误 */
    }
  }

  /** 当前时钟（毫秒）。给需要与记忆服务共用时钟的插件用（如 proactive）。 */
  nowMs(): number {
    return this.now()
  }

  /** 定时维护（由 apply() 的 ctx.effect 持有定时器，类本身不建）。 */
  tick(): void {
    if (!this.opened) return
    this.demoteDue()
    this.drainPanelActions()
    this.publishPanel()
  }

  // ── 向量索引（§9.1 Q1） ────────────────────────────────────────

  /**
   * 当前语义路形态。分档不是"偷懒"：小库全扫更快且没有近似误差，
   * 大库全扫会成为主要延迟（O(N·d) 且每次召回都跑）。
   */
  annMode(): 'exact' | 'hnsw' {
    const w = this.config.recall
    if (!w.annEnabled) return 'exact'
    return this.store.countCells() < w.annThreshold ? 'exact' : 'hnsw'
  }

  /** 懒建索引：第一次真正需要时才构建，避免"库很小却先花 200ms 建图"。 */
  private ensureAnn(): VectorIndex | null {
    if (this.annMode() !== 'hnsw') return null
    if (this.ann) return this.ann
    const t0 = this.now()
    const idx = new HnswIndex({
      m: this.config.recall.annM,
      efConstruction: Math.max(this.config.recall.annM * 4, 100),
      efSearch: this.config.recall.annEf,
    })
    this.store.forEachCell((c) => {
      if (c.emb && c.emb.length > 0) idx.add(c.cellId, c.emb)
    })
    this.ann = idx
    this.annBuilds++
    this.annBuildMs = this.now() - t0
    this.runtime.limits = this.runtime.limits.filter((x) => !x.startsWith('ANN'))
    return idx
  }

  private annAdd(cell: MemCell): void {
    if (!this.ann || !cell.emb) return
    this.ann.add(cell.cellId, cell.emb)
  }

  // ── SDR 倒排索引（v0.5.2） ─────────────────────────────────────

  /**
   * 懒建 SDR 倒排。返回 null 表示"本次请退回全扫"（配置关闭 / 超预算停用）。
   *
   * 自愈判据：`sdrIndexedCount !== store.countCells()` 说明有绕过本服务的写入
   * （巩固 pass 直接 `store.putCell`、`/mnemo rebuild` 清表）。此时整体重建一次，
   * 而不是让索引慢慢变脏——脏索引的后果是**漏召回**，它不会报错。
   */
  private ensureSdrIndex(): BitInvertedIndex | null {
    const cfg = this.config.index
    if (!cfg.sdrEnabled) return null
    const n = this.store.countCells()
    if (this.sdrIndex && this.sdrIndexedCount === n && !this.sdrIndex.stats().disabled) return this.sdrIndex

    const t0 = Date.now()
    const idx = this.sdrIndex ?? new BitInvertedIndex(this.space, cfg.sdrMaxCells)
    idx.reset()
    // 必须带 kind：去重只在同 kind 之间做，重建时漏了 kind 会让所有候选变成 kind=0，
    // 于是"外部写入触发重建"之后的第一次 ingest 会把本该合并的句子当成新记忆
    // （测试 test/v052-index 的"索引自愈"用例抓到的就是这个）。
    this.store.forEachCell((c) => idx.add(c.cellId, c.sdr, c.kind))
    const st = idx.stats()
    this.sdrIndex = idx
    this.sdrIndexedCount = n
    this.sdrBuildMs = Date.now() - t0
    this.runtime.setSdrIndex({
      enabled: !st.disabled,
      cells: st.cells,
      postings: st.postings,
      bytes: st.bytes,
      buildMs: this.sdrBuildMs,
      note: st.disabled
        ? `已超过 sdrMaxCells=${cfg.sdrMaxCells}，退回全扫（结果仍正确，只是更慢）`
        : `${st.cells} 条 / ${st.postings} posting / 约 ${Math.round(st.bytes / 1024)} KB`,
    })
    return st.disabled ? null : idx
  }

  /** 懒建向量矩阵。返回 null 表示"本次请退回全扫"。 */
  private ensureEmbIndex(): EmbIndex | null {
    const cfg = this.config.index
    if (!cfg.sdrEnabled) return null
    const n = this.store.countCells()
    if (this.embIndex && this.embIndexedCount === n && !this.embIndex.stats().disabled) return this.embIndex
    const t0 = Date.now()
    const idx = this.embIndex ?? new EmbIndex(this.config.embStoreDim, cfg.sdrMaxCells)
    idx.reset()
    this.store.forEachCell((c) => idx.add(c.cellId, c.emb))
    this.embIndex = idx
    this.embIndexedCount = n
    this.embBuildMs = Date.now() - t0
    return idx.stats().disabled ? null : idx
  }

  /** 全库余弦（走内存矩阵）。索引不可用时返回 false，让调用方退回逐条解码。 */
  private embScan(q: Int8Array, visit: (id: bigint, score: number) => void): void {
    const idx = this.ensureEmbIndex()
    if (!idx) return
    idx.scan(q, visit)
  }

  /** 索引自身的状态（面板"后端能力"与 doctor 用）。 */
  indexInfo(): { enabled: boolean; cells: number; postings: number; bytes: number; buildMs: number; note: string } {
    const st = this.sdrIndex?.stats()
    const emb = this.embIndex?.stats()
    return {
      enabled: Boolean(st && !st.disabled && this.config.index.sdrEnabled),
      cells: st?.cells ?? 0,
      postings: st?.postings ?? 0,
      bytes: (st?.bytes ?? 0) + (emb?.bytes ?? 0),
      buildMs: this.sdrBuildMs + this.embBuildMs,
      note: this.runtime.sdrIndex.note,
    }
  }

  /**
   * 与给定 SDR 共享 ≥ minOverlap 个位的候选。索引不可用时返回 null（调用方退回全扫）。
   *
   * 返回值是**超集**而不是近似：`minOverlapForJaccard/Containment` 由门限反推，
   * 凡是能满足门限的 cell 必然在候选里。所以接进写路径（去重/冲突）也不会丢数据。
   */
  sdrCandidates(sdr: MemCell['sdr'], minOverlap: number): SdrCandidate[] | null {
    const idx = this.ensureSdrIndex()
    if (!idx) return null
    return idx.candidatesByOverlap(sdr, minOverlap)
  }

  /** 索引增量维护：只在**新增**一条时调用（合并路径 id 与 SDR 都不变）。 */
  private indexCell(cell: MemCell): void {
    if (this.sdrIndex && !this.sdrIndex.stats().disabled) {
      this.sdrIndex.add(cell.cellId, cell.sdr, cell.kind)
      this.sdrIndexedCount = Math.max(this.sdrIndexedCount, this.store.countCells())
    }
    if (this.embIndex && !this.embIndex.stats().disabled) {
      this.embIndex.add(cell.cellId, cell.emb)
      this.embIndexedCount = Math.max(this.embIndexedCount, this.store.countCells())
    }
  }

  private unindexCell(cell: MemCell): void {
    this.embIndex?.remove(cell.cellId)
    if (this.embIndex) this.embIndexedCount = this.store.countCells()
    if (this.sdrIndex) {
      this.sdrIndex.remove(cell.cellId, cell.sdr)
      this.sdrIndexedCount = this.store.countCells()
    }
    for (const k of conflictKeys(cell)) {
      const list = this.conflictIndex.get(k)
      if (!list) continue
      const i = list.indexOf(cell.cellId)
      if (i >= 0) list.splice(i, 1)
      if (list.length === 0) this.conflictIndex.delete(k)
    }
  }

  // ── 冲突检测索引 ────────────────────────────────────────────────

  private ensureConflictIndex(): void {
    const n = this.store.countCells()
    if (this.conflictIndexedCount === n) return
    this.conflictIndex.clear()
    this.store.forEachCell((c) => {
      for (const key of conflictKeys(c)) {
        const list = this.conflictIndex.get(key)
        if (list) list.push(c.cellId)
        else this.conflictIndex.set(key, [c.cellId])
      }
    })
    this.conflictIndexedCount = n
  }

  annInfo(): { enabled: boolean; mode: 'exact' | 'hnsw'; size: number; threshold: number; builds: number; buildMs: number } {
    const w = this.config.recall
    return {
      enabled: w.annEnabled,
      mode: this.annMode(),
      size: this.ann ? this.ann.size : 0,
      threshold: w.annThreshold,
      builds: this.annBuilds,
      buildMs: this.annBuildMs,
    }
  }

  /** 精确扫描与 ANN 的重合度（面板/doctor 用来验证"索引没把好结果丢掉"）。 */
  annOverlap(k = 8): number {
    const idx = this.ann
    if (!idx) return 1
    const brute = new BruteIndex()
    this.store.forEachCell((c) => {
      if (c.emb) brute.add(c.cellId, c.emb)
    })
    const probe = this.store.listCells({ limit: 20, order: 'recent' }).filter((c) => c.emb)
    if (probe.length === 0) return 1
    let sum = 0
    for (const c of probe) {
      const a = new Set(idx.search(c.emb!, k).map((h) => h.id.toString(16)))
      const b = brute.search(c.emb!, k).map((h) => h.id.toString(16))
      const hit = b.filter((id) => a.has(id)).length
      sum += hit / Math.max(1, b.length)
    }
    return sum / probe.length
  }

  // ── 写入路径 ────────────────────────────────────────────────────

  /**
   * 唯一的写入口（对应内嗅皮层的串行瓶颈，§7）。
   * 去重 / 合并竞争 / 矛盾版本链都在这里，编码器只负责"记成什么形状"。
   */
  ingest(cell: MemCell, sources: Array<{ session: string; seq: number }> = []): IngestResult {
    const t = this.now()
    // 脱敏占位符绝不入库（§7.7 V-06）：槽位降 UNK，避免模型记住"key 是 ***"
    const slots = cell.slots.map((s) =>
      s.type === 'LIT' && isRedactionPlaceholder(s.value) ? ({ role: s.role, type: 'UNK', value: '' } as Slot) : s,
    )
    // 视角与情感标记在写入时算一次（读侧不再解析文本，§2.2 A2）
    const lens = cell.lens ?? deriveLens(cell)
    // 判据只用"效价强度"与"唤起"，**不用显著度**：
    // 显著度由 tanh 归一化后基线就在 0.7 附近，拿它当阈值会把每条事实都标成情感记忆（实测踩过）。
    const emotional = Math.abs(cell.valence) >= 0.45 || cell.arousal >= 0.65
    const clean: MemCell = {
      ...cell,
      lens,
      flags: emotional ? cell.flags | FLAG.emotional : cell.flags,
      slots,
      // 向量在写入口统一折到落盘维度：编码器/工具/情感三条写路径都不必各自记得折，
      // 也就不会出现"某条路径写了 256 维、另一条写 64 维"的混合库。
      emb: cell.emb ? foldEmb(cell.emb, this.config.embStoreDim) : null,
      tIngest: BigInt(cell.tIngest || t),
      // 作用域与会话归属：不写这两个字段，§14.10 的隔离就无从谈起
      scope: cell.scope ?? this.scopeKey,
      session: cell.session ?? (sources[0]?.session ?? ''),
    }

    return this.store.write(() => {
      // ① 残差先写（内容寻址，幂等）——崩溃时不会留下半条 cell（§14.11）
      if (clean.digest && !clean.residual) {
        const red = redact(clean.digest)
        if (red.pii) clean.flags |= FLAG.pii | FLAG.redacted
      }

      // ② 去重与合并竞争（§7.5）
      //
      // v0.5.2：从"全表比一遍 Jaccard"改成"先取倒排候选，再精确比"。
      // 候选门限由判定门限反推（J > 0.45 是关联的下限，0.85 是合并的下限），
      // 所以这是**超集**而不是近似——凡是值得合并/关联的一定在候选里。
      // 实测 10 万 cell 下候选占比 < 0.1%，单次 ingest 从 O(n) 降到 O(候选)。
      let best: { cell: MemCell; j: number } | undefined
      const consider = (other: MemCell) => {
        if (other.kind !== clean.kind) return
        const j = this.space.sim(other.sdr, clean.sdr)
        // Jaccard 高者胜；**并列时**按 §7.5 的合并竞争规则裁决（support → importance → tIngest 早）。
        // 之前 `compete()` 定义了却从未被调用，而"并列"在稀疏码上并不罕见——
        // 两个候选的相似度打成平手时，选谁完全取决于遍历顺序（即插入顺序的副作用）。
        if (!best || j > best.j + 1e-9) best = { cell: other, j }
        else if (Math.abs(j - best.j) <= 1e-9) best = { cell: compete(best.cell, other), j }
      }
      const linkFloor = 0.45
      const mySize = this.space.popcount(clean.sdr)
      const cands = this.sdrCandidates(clean.sdr, minOverlapForJaccard(mySize, linkFloor))
      if (cands) {
        /**
         * 索引路径：**不回表**算精确 Jaccard。
         *
         * J = o/(|a|+|b|−o)，三个量索引都有。v0.5.2 第一版对每个候选都 `getCell`
         * 解一遍 blob，400 个候选就是 400 次解码——比全扫省不了多少。
         * 现在只有"真要合并/并列"时才取一次 cell。
         */
        let bestId: bigint | undefined
        let bestJ = -1
        const tied: bigint[] = []
        for (const c of cands) {
          // 注意：**不能**跳过 `c.id === clean.cellId`。
          // 同一句话重复出现时 cellId 是按内容派生的，重复项与库里那条**同 id**——
          // 那正是最该合并的情况。第一版在这里加了"跳过自己"，结果去重静默失效
          // （测试当场抓住：同一句说 4 次产生了 4 条）。
          if (c.kind !== clean.kind) continue
          const union = mySize + c.size - c.overlap
          const j = union === 0 ? 0 : c.overlap / union
          if (j > bestJ + 1e-9) {
            bestJ = j
            bestId = c.id
            tied.length = 0
          } else if (Math.abs(j - bestJ) <= 1e-9) {
            tied.push(c.id)
          }
        }
        if (bestId !== undefined) {
          const other = this.store.getCell(bestId)
          if (other) best = { cell: other, j: bestJ }
          // 并列：只有这时才需要看 support/importance/tIngest 裁决（§7.5）
          for (const id of tied) {
            const other = this.store.getCell(id)
            if (other && best) best = { cell: compete(best.cell, other), j: bestJ }
          }
        }
      } else {
        this.store.forEachCell(consider)
      }

      // 已失效（tInvalid ≠ 0）的版本不参与合并：再次断言同一事实应当产生新版本，
      // 否则"改回来了"这件事会被静默抹平（§7.6 的立场）。
      if (best && best.j > 0.85 && sameSlots(best.cell.slots, clean.slots) && Number(best.cell.tInvalid ?? 0) === 0) {
        // 合并必须保留**先写入那条的 cell_id**：id 是外部引用（渲染行、面板、边），
        // 每次重复出现都换 id 会让旧引用全部悬空（这是实测抓到的真 bug，不是理论风险）。
        const target = best.cell
        target.support = Math.max(1, target.support) + Math.max(1, clean.support)
        target.stability = Math.min(3650, target.stability * 1.3)
        target.tAccess = BigInt(t)
        target.accessCount = target.accessCount + 1
        target.importance = Math.max(target.importance, clean.importance)
        target.confidence = Math.max(target.confidence, clean.confidence)
        // 残差共享：同一事实重复出现时只存一份（§6.3）
        target.residual = target.residual ?? clean.residual
        if (target.residual) this.store.addResidualRef(target.residual.sha)
        this.store.putCell(target)
        for (const s of sources) this.store.putSource(target.cellId, s.session, s.seq)
        return { cell: target, action: 'merged', mergedInto: toHex(target.cellId, 16) }
      }

      // ③ 矛盾检测：同 (AGENT, PRED) 但 PATIENT / POLARITY 冲突（§7.6）
      const conflict = this.findConflict(clean)
      if (conflict) {
        clean.edges.push({ targetPrefix: Number(conflict.cellId & 0xffffffffn), dst: conflict.cellId, rel: REL.CONTRADICTS, weight: 96 })
        const newer = Number(clean.tFrom) >= Number(conflict.tFrom)
        if (newer) {
          clean.edges.push({ targetPrefix: Number(conflict.cellId & 0xffffffffn), dst: conflict.cellId, rel: REL.SUPERSEDES, weight: 96 })
          conflict.flags |= FLAG.disputed
          conflict.importance = Math.max(0, conflict.importance * 0.6)
          // 双时态：旧版本在**新断言发生的时刻**不再为真。它不删，只是不再是"现在的答案"。
          // 用事件时间而不是入库时间：重放同一段日志必须得到同一组失效时刻（§18.5 可复现要求）。
          conflict.tInvalid = clean.tFrom
          this.store.putCell(conflict)
        } else {
          clean.flags |= FLAG.disputed
        }
        this.emit('memory/conflict', { a: toHex(clean.cellId, 16), b: toHex(conflict.cellId, 16), field: 'PATIENT/POLARITY' })
        // 用户改主意 = 一次预测误差事件：下一次召回时，被召回的旧记忆进入可塑窗口。
        // 这是"再巩固"里 confidence 下降的唯一触发点，见 reconsolidation.ts。
        this.pendingPredictionError = Math.max(this.pendingPredictionError, 0.6)
      }

      // ④ 关联而非合并（0.45 < J ≤ 0.85）
      if (best && best.j > 0.45 && best.j <= 0.85) {
        const rel = sameAgent(clean, best.cell) ? REL.PART_OF : REL.SAME_AS
        clean.edges.push({ targetPrefix: Number(best.cell.cellId & 0xffffffffn), dst: best.cell.cellId, rel, weight: 48 })
      }

      // ⑤ 落库：先 cell 后边（边是派生投影，可从 cell 重建）
      this.store.putCell(clean)
      for (const s of sources) this.store.putSource(clean.cellId, s.session, s.seq)
      for (const e of clean.edges) {
        // 精确 id 优先；只有外部构造/旧数据才回退到前缀扫描
        const dst = e.dst ?? this.resolveByPrefix(e.targetPrefix)
        if (dst) this.store.putEdge({ src: clean.cellId, dst, rel: e.rel, weight: e.weight })
      }
      // 索引增量更新：只在新 cell 落库后插入，合并路径改的是同 id 的计数、向量不变
      this.annAdd(clean)
      this.indexCell(clean)
      for (const key of conflictKeys(clean)) {
        const bucket = this.conflictIndex.get(key)
        if (bucket) bucket.push(clean.cellId)
        else this.conflictIndex.set(key, [clean.cellId])
      }
      /**
       * 必须**无条件**推进计数，即使这条 cell 没有 PRED 槽位。
       *
       * 第一版只在"有冲突键"时才更新，于是人格锚/关系模型/无谓词 cell 每次写入
       * 都会让计数落后一格 → 下一条 ingest 看到"计数不符"→ **重建整个冲突索引**。
       * 而重建要 `forEachCell` 解全库 blob。实测 800 cell 时 getCell 占了 33% 的 CPU，
       * 根因就是这里——一个"只在特殊情况下才更新"的计数器。
       */
      this.conflictIndexedCount = this.store.countCells()

      return {
        cell: clean,
        action: conflict ? 'conflict' : best && best.j > 0.45 ? 'linked' : 'created',
        conflictWith: conflict ? toHex(conflict.cellId, 16) : undefined,
      }
    })
  }

  /**
   * 元数据 cell 的 upsert（人格锚 / 关系模型 / 图式）。
   *
   * 为什么这些不能走 ingest：
   *   ingest 是"关于世界的断言"的入口——它做去重、矛盾检测、版本链。
   *   而人格锚与关系模型是**可变状态**：每轮数值都在变，但"用户是谁"没有两个版本，
   *   也不该产生 CONTRADICTS 边。之前它们走 ingest，每轮都判出"冲突"并新增一条，
   *   8 轮就留下 2 条人格锚 + 2 条关系模型（实测），长期会话会无限膨胀。
   *
   * 现在按 key 稳定寻址，一行永远只有一份，rev 记在槽位里。
   */
  upsertMeta(key: string, cell: MemCell): MemCell {
    const id = deriveCellId('mnemo:meta:' + key, [0], new Uint8Array(0))
    const clean: MemCell = {
      ...cell,
      cellId: id,
      tier: 1,
      tIngest: cell.tIngest || BigInt(this.now()),
      emb: cell.emb ? foldEmb(cell.emb, this.config.embStoreDim) : null,
      scope: cell.scope ?? 'global',
      lens: cell.lens ?? deriveLens(cell),
    }
    this.store.write(() => this.store.putCell(clean))
    this.annAdd(clean)
    this.indexCell(clean)
    this.conflictIndexedCount = this.store.countCells()
    return clean
  }

  /**
   * 矛盾检测（§7.6）。
   *
   * v0.5.2：从全表扫改成走 `agent|谓词家族` 索引。判据没变，只是**不再看无关的 cell**——
   * 原来每条新记忆都要解一遍全库的 blob，10 万 cell 下这是写路径上最贵的一步。
   */
  private findConflict(cell: MemCell): MemCell | undefined {
    const agent = slotValue(cell, 'AGENT')
    const pred = slotValue(cell, 'PRED')
    if (!pred) return undefined
    let out: MemCell | undefined
    const fam = predFamily(pred)
    const mannerKey = slotValue(cell, 'MANNER')
    const patientKey = slotValue(cell, 'PATIENT')
    const visit = (other: MemCell) => {
      if (other.cellId === cell.cellId) return
      const p1 = slotValue(cell, 'PATIENT') ?? ''
      const p2 = slotValue(other, 'PATIENT') ?? ''
      const m1 = slotValue(cell, 'MANNER') ?? ''
      const m2 = slotValue(other, 'MANNER') ?? ''
      const pol1 = slotValue(cell, 'POLARITY') ?? 'pos'
      const pol2 = slotValue(other, 'POLARITY') ?? 'pos'
      // 两种冲突形态：
      //   · 同一客体、极性相反（'喜欢深色' vs '不喜欢深色'）
      //   · 同一话题、取值不同（'字体=等宽' vs '字体=无衬线'）—— 这是偏好演化最常见的形态
      const sameTopic = (m1 && m1 === m2) || (p1 && p1 === p2)
      const valueDiffers = p1 !== p2 || pol1 !== pol2
      if (!sameTopic || !valueDiffers) return
      // 只和"仍然有效"的版本比：否则第二次改主意会去改一条已经失效的旧记录，
      // 结果是版本链断在中间（实测：pnpm→npm→bun 时 npm 永远不会被取代）。
      if (Number(other.tInvalid ?? 0) !== 0) return
      // 取最新的一条：链式取代必须逐级传递，不能跳回最早的版本
      if (!out || Number(other.tFrom) > Number(out.tFrom)) out = other
    }

    if (!fam) return undefined
    this.ensureConflictIndex()
    const a = agent ?? ''
    const pol = slotValue(cell, 'POLARITY') ?? 'pos'
    const ids = new Set<bigint>()
    // manner 桶：同方式、不同取值 → 全是候选（极性不限）
    if (mannerKey) for (const id of this.conflictIndex.get(`${a}\u0000${fam}\u0000M\u0000${mannerKey}`) ?? []) ids.add(id)
    // patient 桶：同客体时只有**相反极性**才算矛盾，所以只查反极性那一格
    if (patientKey) {
      for (const id of this.conflictIndex.get(`${a}\u0000${fam}\u0000P\u0000${patientKey}\u0000${flipPolarity(pol)}`) ?? []) ids.add(id)
    }
    if (ids.size === 0) {
      /**
       * 桶是空的：可能是"确实没有同客体/同方式的记忆"，也可能是"索引还没覆盖到这条写入"。
       * 两者必须区分——前者返回 undefined 是对的，后者漏判会让"用户改主意"静默丢失。
       * 判据：索引里的 cell 数 != 实际 cell 数 ⇒ 索引不完整，全扫兜底。
       */
      if (this.conflictIndexedCount === this.store.countCells()) return undefined
      this.store.forEachCell(visit)
      return out
    }
    for (const id of ids) {
      const other = this.store.getCell(id)
      if (other) visit(other)
    }
    return out
  }

  private resolveByPrefix(prefix: number): bigint | undefined {
    return this.store.findByPrefix(prefix) ?? undefined
  }

  // ── 读路径 ──────────────────────────────────────────────────────

  recall(q: RecallQuery): RecallResult {
    const r = runRecall(
      {
        space: this.space,
        store: this.store,
        config: this.config,
        now: this.now(),
        working: this.working,
        scopeKey: this.scopeKey,
        ann: this.ensureAnn() ?? undefined,
        sdrCandidates: (sdr, minOverlap) => this.sdrCandidates(sdr, minOverlap)?.map((c) => c.id) ?? null,
        embScan: (q, visit) => this.embScan(q, visit),
      },
      q,
    )
    if (q.readOnly) {
      // 只读：不写快照、不计命中率、不更新 tAccess、不建共激活边、不推面板。
      // 面板每 3 秒刷新一次，如果它算"使用"，那面板本身就是最强的遗忘抑制剂。
      return r
    }
    r.snapshotId = this.snapshot(r.rendered, r.tokens)
    this.recalls++
    if (r.hits.length > 0) this.hitRecalls++
    this.latencies.push(r.elapsedMs)
    if (this.latencies.length > 500) this.latencies.shift()
    this.tokenSeries.push({ turn: this.turns, tokens: r.tokens })
    if (this.tokenSeries.length > 500) this.tokenSeries.shift()

    // 被召回的 cell：**再巩固**（v0.4，对应方案 §1.2）
    //   提取即强化（测试效应）+ 预测误差大时进入可塑窗口（confidence 降）
    //   + 心境一致性轻微改写效价。这三件事以前只有第一件，所以"越聊越深"有，
    //   "被带偏"和"想起难过的事会难过一会儿"没有。
    const now = this.now()
    const predErr = this.pendingPredictionError
    this.pendingPredictionError = 0
    const moodV = this.affectState?.pad?.v ?? 0
    for (const h of r.hits) {
      const id = BigInt('0x' + h.cellId)
      const cell = this.store.getCell(id)
      if (!cell) continue
      const delta = onRetrieved(cell, {
        retrievalStrength: h.score,
        predictionError: predErr,
        moodCongruence: moodV * cell.valence,
        nowMs: now,
      })
      applyReconsolidation(cell, delta, now)
      /**
       * 强命中 = 一次真实使用：把已经沉到冷层/归档层的记忆拉回一级（v0.5.1）。
       * 这是"升档"的唯一自动入口之一（另一个是巩固期的睡眠重放）。
       * 墓碑不在此列——它要用户显式 `restore`。
       */
      if (h.score >= 0.55 && cell.tier >= 2 && cell.tier < 4) {
        cell.tier = (cell.tier - 1) as MemCell['tier']
      }
      this.store.putCell(cell)
      // tAccess/stability 变了 → 保留度的输入变了，缓存必须作废
      this.store.invalidateRetention(cell.cellId)
      this.working.touch(id, Math.min(1, 0.4 + h.score))
      if (delta.plastic || Math.abs(delta.dValence) >= 0.005 || Math.abs(delta.dConfidence) >= 0.005) {
        this.reconsolidationLog.push({
          at: now,
          cellId: h.cellId,
          dStability: delta.dStability,
          dConfidence: delta.dConfidence,
          dValence: delta.dValence,
          plastic: delta.plastic,
        })
        if (this.reconsolidationLog.length > 40) this.reconsolidationLog.shift()
      }
    }
    // 共激活强化（Hebbian）：同一轮被一起想起的东西，之间长出连接。
    // 这是"联想"的物理实现——不是随机连边，是"一起出现过"才连。
    this.coactivate(r.hits.map((h) => BigInt('0x' + h.cellId)))

    this.lastRecall = {
      queryId: r.queryId,
      at: now,
      tokens: r.tokens,
      hits: r.hits,
      breakdowns: r.breakdowns,
      rendered: r.rendered,
    }
    this.emit('memory/recall', {
      queryId: r.queryId,
      strategy: r.strategy,
      hits: r.hits,
      renderedTokens: r.tokens,
      surfaceMode: r.surfaceMode,
      snapshotId: r.snapshotId,
    })
    this.publishPanel()
    return r
  }

  snapshot(rendered: string, tokens: number): string {
    return this.store.putSnapshot(rendered, tokens)
  }

  /**
   * 共激活强化：把同一轮里一起被召回的记忆两两连起来（ASSOC 边权递增，封顶 120）。
   * 只连前 6 条——再多就是噪声，"一起被想起"这件事本身有强弱。
   */
  coactivate(ids: bigint[], delta = 8): void {
    // 边是 connectivity 因子的输入，加边之后两端的缓存都失效
    for (const id of ids) this.store.invalidateRetention(id)
    const top = ids.slice(0, 6)
    if (top.length < 2) return
    this.store.write(() => {
      for (let i = 0; i < top.length; i++) {
        for (let j = i + 1; j < top.length; j++) {
          const existing = this.store.edgesFrom(top[i]).find((e) => e.dst === top[j] && e.rel === REL.ASSOC)
          const weight = Math.min(120, (existing?.weight ?? 32) + delta)
          this.store.putEdge({ src: top[i], dst: top[j], rel: REL.ASSOC, weight })
          // 反向也连：联想是双向的，检索从任一端出发都该走得到
          this.store.putEdge({ src: top[j], dst: top[i], rel: REL.ASSOC, weight })
        }
      }
    })
  }

  /**
   * 联想链：从一条记忆出发，沿 ASSOC / SAME_AS / PART_OF / CAUSES 游走。
   * 返回按 `边权 × decay^hop` 排序的链条，供主动聊天挑话题、面板画邻域。
   *
   * 与"图路召回"的区别：那个是**从查询**扩散，这个是**从一条记忆**扩散，
   * 不需要 query 文本——"想到这件事，还会想到什么"。
   */
  associate(seedId: bigint | string, opts: { depth?: number; decay?: number; limit?: number } = {}): Array<{
    cellId: string
    shortId: string
    hop: number
    score: number
    digest: string
    lens: string
  }> {
    const depth = Math.max(1, Math.min(3, opts.depth ?? 2))
    const decay = opts.decay ?? 0.55
    const limit = opts.limit ?? 12
    const seed = typeof seedId === 'string' ? BigInt('0x' + seedId.replace(/^0x/, '').padStart(16, '0')) : seedId

    const visited = new Set<string>([toHex(seed, 16)])
    const out: Array<{ cellId: string; shortId: string; hop: number; score: number; digest: string; lens: string }> = []
    let frontier: Array<{ id: bigint; score: number; hop: number }> = [{ id: seed, score: 1, hop: 0 }]

    for (let hop = 1; hop <= depth; hop++) {
      const next: Array<{ id: bigint; score: number; hop: number }> = []
      for (const f of frontier) {
        for (const e of this.store.edgesFrom(f.id)) {
          if (e.rel !== REL.ASSOC && e.rel !== REL.SAME_AS && e.rel !== REL.PART_OF && e.rel !== REL.CAUSES && e.rel !== REL.EVOKES) continue
          const key = toHex(e.dst, 16)
          if (visited.has(key)) continue
          visited.add(key)
          const score = f.score * Math.pow(decay, hop) * Math.min(1, e.weight / 64)
          next.push({ id: e.dst, score, hop })
        }
      }
      for (const n of next) {
        const cell = this.store.getCell(n.id)
        if (!cell) continue
        out.push({
          cellId: toHex(cell.cellId, 16),
          shortId: toHex(cell.cellId, 16).slice(-4),
          hop: n.hop,
          score: Math.round(n.score * 1000) / 1000,
          digest: cell.digest ?? '',
          lens: cell.lens ?? 'fact',
        })
      }
      frontier = next
      if (frontier.length === 0) break
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit)
  }

  /**
   * 重放一次召回的渲染快照（修 D-05 的验证路径）。
   * 事件里只存 snapshotId，重放时按 id 取回原文，保证"重放看到的 = 当时看到的"。
   */
  replayRecall(snapshotId: string): { rendered: string; tokens: number } | null {
    const snap = this.store.getSnapshot(snapshotId)
    return snap ? { rendered: snap.rendered, tokens: snap.tokens } : null
  }

  /** 重建钩子由编码器注册（它才知道怎么把日志重新编码成 cell）。 */
  private rebuildHook?: () => Promise<{ turns: number; cells: number }>

  registerRebuildHook(fn: () => Promise<{ turns: number; cells: number }>): void {
    this.rebuildHook = fn
  }

  /**
   * 从会话日志重建晶格（§14.11）。
   * 不删 session_log、不删 residuals —— 重建的是**派生层**，不是事实源。
   */
  async rebuildFromLog(): Promise<{ turns: number; cells: number }> {
    if (!this.rebuildHook) throw new Error('没有注册重建钩子（需要 mnemo-encoder）')
    // 索引是派生投影：重建前先丢弃，重建后按新库懒建
    this.ann = null
    const r = await this.rebuildHook()
    this.store.setMeta('lastRebuildAt', String(this.now()))
    this.publishPanel(true)
    return r
  }

  /** 展开（§14.9）：800 字硬上限、遮蔽检测、单会话 2 次上限、写 expand 事件。 */
  expand(cellId: string, level: 0 | 1 | 2, sessionId = 'default'): ExpandResult {
    const id = BigInt('0x' + cellId.replace(/^0x/, '').padStart(16, '0'))
    // 第 2 次之后不再返回原文：同一段文字反复展开，等于把压缩掉的内容反复塞回上下文
    const key = sessionId + ':' + cellId
    const used = this.expandCounts.get(key) ?? 0
    if (level === 2 && used >= 2) {
      const text = '[本会话内该记忆已展开 2 次，不再重复返回原文。如确需细节，请先 /mnemo search 重新定位]'
      this.emit('memory/expand', { cellId, level, chars: text.length, capped: true })
      return { cellId, level, text, tokens: estimateTokens(text), shadowed: false, truncated: false, chars: text.length }
    }
    if (level === 2) this.expandCounts.set(key, used + 1)
    const cell = this.store.getCell(id)
    if (!cell) throw new Error(`cell 不存在: ${cellId}`)
    if (level === 0) {
      const text = summarize(cell)
      return { cellId, level, text, tokens: estimateTokens(text), shadowed: false, truncated: false, chars: text.length }
    }
    if (level === 1) {
      const text = cell.slots
        .map((s) => `${SLOT_ROLE_NAME[s.role] ?? s.role}=${s.type === 'UNK' ? 'UNK' : s.value}`)
        .join(' ')
      return { cellId, level, text, tokens: estimateTokens(text), shadowed: false, truncated: false, chars: text.length }
    }
    // level 2：原文残差
    const sources = this.store.sourcesOf(id)
    const shadowed = sessionId ? sources.every((s) => this.store.isShadowed(s.session, s.seq)) : false
    if (shadowed) {
      const text = '[该段已被压缩摘要覆盖，原文仅按需提供]'
      this.emit('memory/expand', { cellId, level, chars: text.length, shadowed: true })
      return { cellId, level, text, tokens: estimateTokens(text), shadowed: true, truncated: false, chars: text.length }
    }
    const raw = cell.residual ? this.store.getResidual(Number(cell.residual.off)) : null
    let text = raw ? new TextDecoder().decode(raw) : summarize(cell)
    let truncated = false
    if (text.length > 800) {
      text = text.slice(0, 800) + '…[截断]'
      truncated = true
    }
    this.emit('memory/expand', { cellId, level, chars: text.length, shadowed: false })
    return { cellId, level, text, tokens: estimateTokens(text), shadowed, truncated, chars: text.length }
  }

  forget(cellId: string, mode: 'soft' | 'hard', actor: EvictRecord['actor'] = 'user', reason = 'user request'): void {
    const id = BigInt('0x' + cellId.replace(/^0x/, '').padStart(16, '0'))
    const cell = this.store.getCell(id)
    if (!cell) return
    this.store.write(() => {
      if (mode === 'hard') {
        this.store.deleteCell(id) // 内含残差释放（没人再引用时物理删）
        this.ann?.remove(id)
        this.unindexCell(cell)
      } else {
        cell.tier = 3
        cell.importance = Math.min(cell.importance, 0.05)
        cell.flags &= ~FLAG.noDecay
        this.store.putCell(cell)
      }
      const rec: EvictRecord = { cellId, mode, reason, actor, at: this.now() }
      this.store.appendEvict(rec)
      this.evictions++
    })
    this.emit('memory/evict', { cellId, mode, reason, actor })
    this.publishPanel()
  }

  explain(cellId: string, q?: RecallQuery): string {
    const target = cellId.replace(/^0x/, '').padEnd(16, '0').slice(-16)
    const b = this.lastRecall?.breakdowns.find((x) => x.cellId.endsWith(target.slice(-4)) || x.cellId === target)
    if (!b) {
      // 没有当轮召回记录时，现场算一次解释，而不是返回"无数据"
      // v0.5.2：必须 readOnly。v0.5 修了"面板刷新=一次使用"，但解释器这条路径漏了——
      // `/mnemo explain` 会抬高被解释那条的 tAccess/stability，并写再巩固日志。
      // 解释是**观察**，观察不该改变被观察的东西。
      const r = this.recall({ ...(q ?? { text: '', budget: 400 }), manual: true, readOnly: true })
      const fresh = r.breakdowns.find((x) => x.cellId.endsWith(target.slice(-4)))
      return fresh ? formatBreakdown(fresh, this.config.recall.ignition) : `cell ${target} 不在候选池内（可能低于 ignition 或被隔离）`
    }
    return formatBreakdown(b, this.config.recall.ignition)
  }

  // ── 统计与体检 ──────────────────────────────────────────────────

  stats(): StatsSnapshot {
    const s = this.store.stats()
    /**
     * v0.5.2：改成聚合查询。
     *
     * 原来这里是 `forEachCell` + `allEdges`——**为了数几个数把全库 blob 解一遍**，
     * 而面板每 3 秒就调一次 `stats()`。800 cell 实测 20 ms，10 万 cell 就是 500 ms 级，
     * 面板刷新会变成 CPU 热点。SQL 的 `GROUP BY` 是毫秒级。
     */
    const agg = this.store.counts()
    const byKind: Record<string, number> = {}
    for (const [k, n] of Object.entries(agg.byKind)) byKind[KIND_NAME[Number(k)] ?? k] = n
    const byTier = agg.byTier
    const supportOne = agg.supportOne
    const disputed = agg.disputed
    const invalidated = agg.invalidated
    const contradictions = agg.contradictions
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0
    const tokensPerTurn = this.tokenSeries.length
      ? this.tokenSeries.reduce((n, x) => n + x.tokens, 0) / this.tokenSeries.length
      : 0
    return {
      cells: s.cells,
      edges: s.edges,
      bytes: s.bytes,
      byKind,
      byTier,
      supportOne,
      disputed,
      invalidated,
      contradictions,
      hitRate: this.recalls ? this.hitRecalls / this.recalls : 0,
      tokensPerTurn,
      tokenSeries: this.tokenSeries.slice(-40),
      // 存储比 = (cell blob + 压缩后残差) / 原始文本字节。这是 §18.1 的 storage_ratio 口径。
      storageRatio: (s as { rawBytes?: number }).rawBytes ? s.bytes / (s as { rawBytes: number }).rawBytes : 0,
      recallP95Ms: p95,
      turns: this.turns,
      evictions: this.evictions,
    }
  }

  /**
   * 带缓存的 doctor（面板专用）。`doctor()` 本身仍然随时可调，只是面板不必每次都付钱。
   */
  private doctorCache: { at: number; report: DoctorReport } | null = null

  private cachedDoctor(): DoctorReport {
    const ttl = 30_000
    const now = this.now()
    if (this.doctorCache && now - this.doctorCache.at < ttl) return this.doctorCache.report
    const report = this.doctor()
    this.doctorCache = { at: now, report }
    return report
  }

  doctor(opts: { fix?: boolean; unlock?: boolean } = {}): DoctorReport {
    const now = this.now()
    const issues: string[] = []
    const fixed: string[] = []
    /**
     * 单趟扫描收齐三件事（v0.5.2）。
     *
     * 原来这里连着三次 `forEachCell`：取 id 集合、查悬空槽、查失效未降档——
     * 每次都要把全库 blob 解一遍。10 万 cell 下那是三次 500 ms 级的解码，
     * 而它们看的是同一批数据。合成一趟之后只剩一次。
     */
    const ids = new Set<string>()
    /**
     * REF 引用先收集、循环结束后再判定。
     *
     * 单趟扫描里 `ids` 是一边扫一边长的：如果当场判定，指向"还没扫到的那条"的
     * REF 会被误报成悬空。先收集再判，既保持一趟扫描的收益，也不改变语义。
     */
    const refTargets: string[] = []
    let danglingSlots = 0
    let invalidNotDemoted = 0
    let tombstones = 0
    let tombstoneBytes = 0
    let scanned = 0
    this.store.forEachCell((c) => {
      scanned++
      ids.add(toHex(c.cellId, 16))
      for (const s of c.slots) if (s.type === 'REF') refTargets.push(s.value.padStart(16, '0'))
      const tInvalid = Number(c.tInvalid ?? 0)
      if (tInvalid !== 0 && now - tInvalid > INVALID_GRACE_MS && c.tier < 3) {
        invalidNotDemoted++
        if (opts.fix) {
          c.tier = 3
          c.emb = pq32(c.emb)
          this.store.putCell(c)
        }
      }
      if (c.tier >= 4) {
        tombstones++
        tombstoneBytes += encodeCell(c).length
      }
    })

    let orphanEdges = 0
    for (const e of this.store.allEdges()) {
      const a = ids.has(toHex(e.src, 16))
      const b = ids.has(toHex(e.dst, 16))
      if (!a || !b) {
        orphanEdges++
        if (opts.fix) this.store.deleteEdge(e.src, e.dst, e.rel)
      }
    }
    if (orphanEdges && opts.fix) fixed.push(`删除孤儿边 ${orphanEdges} 条`)
    else if (orphanEdges) issues.push(`孤儿边 ${orphanEdges} 条（/mnemo doctor --fix 可清理）`)

    for (const ref of refTargets) if (!ids.has(ref)) danglingSlots++
    if (danglingSlots) issues.push(`悬空槽位引用 ${danglingSlots} 个`)

    // 遗留锁：未匹配的 consolidate/start（§10.2）
    const openLock = this.store.meta('consolidate:open')
    if (openLock) {
      if (opts.unlock) {
        this.store.setMeta('consolidate:open', '')
        fixed.push(`清除遗留锁 ${openLock}`)
      } else issues.push(`遗留巩固锁 ${openLock}（/mnemo doctor --unlock 解除）`)
    }

    const layout = this.store.meta('layout') ?? ''
    const expect = `${this.config.sdrDim}:${this.config.sdrK}:${this.config.embStoreDim}:3`
    if (layout && layout !== expect) issues.push(`布局不匹配 ${layout} ≠ ${expect}，需 rebuild`)

    /**
     * 孤儿残差：没有任何 cell 引用、却还留在盘上的原文。
     *
     * 这类残差是"硬删没删干净"的遗留物——v0.3 之前 `deleteCell` 只删行不删残差，
     * 于是用户被告知"已物理删除"，原文仍在磁盘上。v0.3.1 起 deleteCell 会顺手释放，
     * 这一项负责把**历史遗留**清掉。
     */
    const orphans = this.store.orphanResiduals()
    let orphanResiduals = orphans.length
    if (orphanResiduals > 0) {
      if (opts.fix) {
        let purged = 0
        for (const o of orphans) if (this.store.purgeOrphanResidual(o.sha)) purged++
        orphanResiduals = this.store.orphanResiduals().length
        fixed.push(`清理孤儿残差 ${purged} 条（释放 ${(orphans.reduce((n, o) => n + o.bytes, 0) / 1024).toFixed(1)} KB）`)
      } else {
        const bytes = orphans.reduce((n, o) => n + o.bytes, 0)
        issues.push(`孤儿残差 ${orphanResiduals} 条 / ${(bytes / 1024).toFixed(1)} KB（/mnemo doctor --fix 可清理）`)
      }
    }

    /**
     * 失效但未降档（v0.5 数据迁移）。
     *
     * v0.4 的保留度不看 `tInvalid`，于是"已失效但停在热/温层"的旧版本会一直占着位置。
     * 改代码不会自动触及存量库，所以给 doctor 一条显式检查 + `--fix` 批量降档。
     */
    if (invalidNotDemoted) {
      if (opts.fix) fixed.push(`失效记忆降档 ${invalidNotDemoted} 条 → 归档层`)
      else issues.push(`已失效但仍在上层 ${invalidNotDemoted} 条（/mnemo doctor --fix 可批量归档）`)
    }

    return {
      ok: issues.length === 0,
      orphanEdges,
      danglingSlots,
      orphanResiduals,
      invalidNotDemoted,
      tombstones,
      tombstoneBytes,
      scanned,
      staleLocks: openLock ? 1 : 0,
      indexConsistent: orphanEdges === 0 && danglingSlots === 0,
      layoutVersion: Number(this.store.meta('layoutVersion') ?? 3),
      sdrDim: this.config.sdrDim,
      issues,
      fixed,
    }
  }

  /**
   * 墓碑压实（v0.5）。
   *
   * 进 tier 4 时调用：释放残差（原文不再可展开）、丢弃向量（不再参与语义匹配）、
   * 置 `FLAG.tombstone`。保留 id / digest / 槽位 / SDR——血缘和"曾经有过这件事"还在。
   *
   * 这是"库只进不出"的正面回答：**不删行**（删了版本链就断了），
   * 但把最大的一块字节（残差 ≈ 全部存储的 47%）还回去。
   * 代价是墓碑不可展开原文——这正是"墓碑"这个词的本义。
   */
  private compactTombstone(c: MemCell): Uint8Array | null {
    const sha = c.residual?.sha ?? null
    c.residual = null
    c.emb = null
    c.flags = c.flags & ~FLAG.residual
    // 返回 sha，由调用方在 putCell **之后**释放：
    // releaseResidualRef 的判据是"还有没有 cell 引用它"，先释放会因为本条还没落库而变成 no-op
    // （第一版就是这么写的，结果残差全部变成孤儿，doctor 报 5 条）。
    return sha
  }

  /**
   * 从墓碑复活（v0.5）：用户显式操作，不是自动流程。
   * 注意：原文已释放，复活后只能看到 digest + 槽位。
   */
  restore(cellId: string): { ok: boolean; message: string } {
    const id = BigInt('0x' + cellId.replace(/^0x/, '').padStart(16, '0'))
    const cell = this.store.getCell(id)
    if (!cell) return { ok: false, message: 'cell 不存在' }
    if (cell.tier < 4) return { ok: false, message: '这条不在墓碑层' }
    cell.tier = 1
    cell.importance = Math.max(cell.importance, 0.6)
    cell.tAccess = BigInt(this.now())
    this.store.putCell(cell)
    this.publishPanel()
    return { ok: true, message: '已从墓碑恢复到温层（原文已释放，只能看到摘要）' }
  }

  /**
   * 降档 pass（v0.5.2：增量 + 剪枝）。
   *
   * ── v0.5.1 之前的两处浪费 ────────────────────────────────────────
   * ① 每次 tick 全表评估七因子。`tick()` 每轮都调，于是"库越大越慢"；
   * ② `allEdges()` 把整张边表读进内存算度数。10 万 cell / 50 万边时这是每次 tick 一次
   *    百万级对象的分配——它比七因子本身贵得多。
   *
   * ── 现在的两段 ──────────────────────────────────────────────────
   * **快路径（剪枝）**：缓存里已经判定"该降"的直接降，不重算。
   * 依据是 v0.5.1 修好的单调性：无访问 → ACT-R 激活单调减；无结构变更 → 其余六因子不变；
   * `stale` 单调减；周年加成被封顶在本档上沿。所以 t₀ 的"该降"在 t>t₀ 仍成立。
   * **反向不成立**，所以未命中的仍要重算——剪枝只会漏掉"其实该降但缓存说不用"的，
   * 而那类会在 TTL 过期后重算到。这是保守方向，不会错降。
   *
   * **慢路径（增量）**：只评估 `demoteBatch` 条**最久未被评估**的 cell。
   * 于是单次 tick 的成本与库规模无关，全库扫描由多个 tick 分摊完成。
   */
  demoteDue(): number {
    const now = this.now()
    const cfg = this.config.index
    const weights = RETENTION_WEIGHTS[(this.config.preset === 'custom' ? 'balanced' : this.config.preset) as PresetName]
    const budget = Math.max(1, Math.floor(cfg.demoteBatch))
    let moved = 0

    /**
     * 整段包在一个事务里。
     *
     * 不包会怎样：`setRetention` 是 `INSERT ... ON CONFLICT`，SQLite 默认每条语句一个事务，
     * WAL 下每次提交都要落盘。实测 1 万 cell 的一次 pass（2000 条）耗时 **2066 ms**，
     * 而同样的工作在单个事务里是百毫秒级——**97% 的时间花在 fsync 上**。
     */
    this.store.write(() => {
    // ① 剪枝快路径：缓存说该降的，直接降一级
    for (const id of this.store.demotableByCache(budget)) {
      const c = this.store.getCell(id)
      if (!c) continue
      if (this.applyDemotion(c)) moved++
    }

    // ② 增量慢路径：评估最久未评估的那一批
    const remaining = Math.max(0, budget - moved)
    if (remaining > 0) {
      const staleBefore = now - Math.max(60_000, cfg.retentionTtlMs)
      for (const id of this.store.stalestForRetention(remaining, staleBefore)) {
        const c = this.store.getCell(id)
        if (!c) continue
        if (c.flags & FLAG.noDecay) continue
        // 30 分钟内的访问仍算"在工作记忆里"，不降档（v0.2 的 hot 语义保留）
        if (now - Number(c.tAccess) < 30 * 60_000) continue

        const degree = this.degreeOf(c.cellId)
        if (degree > this.maxDegreeCache) this.maxDegreeCache = degree
        const sameAs = c.edges.filter((e) => e.rel === REL.SAME_AS).length
        const r = evaluateRetention(c, {
          nowMs: now,
          weights,
          degree,
          maxDegree: this.maxDegreeCache,
          redundancy: Math.min(1, sameAs / 2),
          isSuperseded: this.store.edgesTo(c.cellId).some((e) => e.rel === REL.SUPERSEDES),
        })
        // 缓存：只存 score/band/at。七因子分解不进缓存——面板逐条展示要它，
        // 而面板只算最近 120 条（实测 2 ms），不值得为它让存储涨 20%。
        this.store.setRetention(c.cellId, r.score, Number(r.effective.slice(1)), now)
        if (r.tier > c.tier && this.applyDemotion(c)) moved++
      }
    }
    })
    return moved
  }

  /** 图上度数（出 + 入）。走两条索引查询，不再把整张边表读进内存。 */
  private degreeOf(id: bigint): number {
    return this.store.edgesFrom(id).length + this.store.edgesTo(id).length
  }

  /**
   * 真正落一次降档：一次只移动一级，进墓碑时压实。
   * 返回是否真的移动了（tier 没变时返回 false，避免把"评估过"记成"降过"）。
   */
  private applyDemotion(c: MemCell): boolean {
    const target = nextTier(c.tier, (c.tier + 1) as 0 | 1 | 2 | 3 | 4)
    if (target === c.tier) return false
    c.tier = target
    if (target >= 2) c.emb = pq32(c.emb)
    // 进墓碑时压实：释放残差、丢掉向量，只留 id + digest + 槽位 + SDR。
    // 这是"库有进有出"的落点——不删行（血缘还在），但把最大的一块字节还回去。
    const tombstoneSha = target >= 4 ? this.compactTombstone(c) : null
    this.store.putCell(c)
    if (tombstoneSha) this.store.releaseResidualRef(tombstoneSha)
    /**
     * **不**作废缓存（v0.5.2 修正）。
     *
     * 第一版在降完就把缓存删掉，结果是：`demotableByCache` 永远返回空——
     * 因为缓存只可能存在于"评估过但没降"的条目上，而那些本来就不该降。
     * 剪枝路径因此是死代码。
     *
     * 现在保留缓存：档位（band）只由七因子决定，而 tier 不是七因子的输入，
     * 所以降了一级之后"该不该继续降"的结论仍然有效。于是逐级下降
     * （0→1→2→3→4）在后续 pass 里走**快路径**，不再重算七因子。
     * 缓存真正作废的时机是**输入变了**：召回更新 tAccess、加边、改重要性——
     * 见 invalidateRetention 的三个调用点。
     */
    return true
  }

  // ── 面板（host 侧数据源，§12.4 / §12.10 / §20.2） ───────────────

  setAffectState(state: PanelSnapshot['affect']): void {
    this.affectState = state
  }

  onPanelUpdate(fn: (s: PanelSnapshot) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 面板视图：万级 cell 也不全量渲染——默认只给最近 500 条，其余靠搜索。 */
  panelCells(limit = 500): PanelCellView[] {
    const cells = this.store.listCells({ limit, order: 'recent' })
    const shortIds = assignShortIds(cells.map((cell) => ({ cell })))
    return cells.map((c, i) => {
      const kv = kvPairs(c)
      return {
        cellId: toHex(c.cellId, 16),
        shortId: shortIds[i],
        kind: c.kind,
        kindName: KIND_NAME[c.kind] ?? 'fact',
        tier: c.tier,
        tFrom: Number(c.tFrom),
        valence: c.valence,
        arousal: c.arousal,
        salience: c.salience,
        importance: c.importance,
        support: c.support,
        confidence: c.confidence,
        provenance: c.provenance,
        trust: c.trust,
        changed: (c.flags & FLAG.disputed) !== 0,
        pinned: (c.flags & FLAG.noDecay) !== 0,
        disputed: (c.flags & FLAG.disputed) !== 0,
        invalidated: Number(c.tInvalid ?? 0) !== 0,
        tInvalid: Number(c.tInvalid ?? 0),
        lens: (c.lens ?? 'fact') as never,
        emotional: (c.flags & FLAG.emotional) !== 0,
        digest: c.digest ?? kv.map(([k, v]) => `${k}=${v}`).join(' '),
        kv,
        slots: c.slots,
        residualChars: c.residual?.rawLen ?? 0,
        stability: c.stability,
        accessCount: c.accessCount,
      }
    })
  }

  /**
   * 保留度视图（v0.4）。
   *
   * 只算最近 120 条：面板是 3 秒刷新的，全量算保留度会把面板变成 CPU 热点。
   * 六档计数也只统计这 120 条，并在面板上写明口径——**不假装是全域统计**。
   */
  private retentionView(): PanelSnapshot['retention'] {
    const presetName = (this.config.preset === 'custom' ? 'balanced' : this.config.preset) as PresetName
    const weights = RETENTION_WEIGHTS[presetName]
    const now = this.now()
    /**
     * v0.5.2：不再 `allEdges()`。
     *
     * 面板是 3 秒刷新的，而 `allEdges()` 会把整张边表读进内存——10 万 cell / 50 万边时
     * 每次刷新分配几十万个对象，比七因子本身贵两个数量级。
     * 现在只对**要展示的那 120 条**各查两次索引（出边 + 入边），成本与库规模无关。
     */
    const sample = this.store.listCells({ limit: 120, order: 'recent' })
    const maxDegree = Math.max(this.maxDegreeCache, 1)
    const shortIds = assignShortIds(sample.map((cell) => ({ cell })))
    const byDisposition: Record<string, number> = { P5: 0, P4: 0, P3: 0, P2: 0, P1: 0 }
    const entries: PanelRetentionEntry[] = []
    sample.forEach((c, i) => {
      const key = toHex(c.cellId, 16)
      const sameAs = c.edges.filter((e) => e.rel === REL.SAME_AS).length
      const r = evaluateRetention(c, {
        nowMs: now,
        weights,
        degree: this.degreeOf(c.cellId),
        maxDegree,
        redundancy: Math.min(1, sameAs / 2),
        isSuperseded: this.store.edgesTo(c.cellId).some((e) => e.rel === REL.SUPERSEDES),
      })
      byDisposition[r.effective] = (byDisposition[r.effective] ?? 0) + 1
      entries.push({
        cellId: key,
        shortId: shortIds[i],
        digest: c.digest || kvPairs(c).map(([k, v]) => `${k}=${v}`).join(' '),
        kind: c.kind,
        tier: c.tier,
        score: r.score,
        disposition: r.effective,
        protectedBy: r.protectedBy,
        invalid: r.invalid,
        stale: r.stale,
        parts: { ...r.parts } as unknown as Record<string, number>,
        contributions: { ...r.contributions } as unknown as Record<string, number>,
        anniversary: r.anniversary,
        why: retentionWhy(r, KIND_NAME[c.kind] ?? '记忆'),
      })
    })
    entries.sort((a, b) => b.score - a.score)

    const aff = this.affectState
    const nm = neuromodulate({
      arousal: aff?.pad?.a ?? 0.2,
      load: aff?.intero?.load ?? 0,
      conflict: aff?.intero?.conflict ?? 0,
      novelty: 0.2,
      predictionError: this.pendingPredictionError,
    })

    return {
      byDisposition,
      floors: { P5: DISPOSITION_FLOOR.P5, P4: DISPOSITION_FLOOR.P4, P3: DISPOSITION_FLOOR.P3, P2: DISPOSITION_FLOOR.P2 },
      entries: entries.slice(0, 40),
      neuromod: nm,
      mode: modeOf(nm),
      temperature: retrievalTemperature(nm),
      weights: { ...weights } as unknown as Record<string, number>,
      reconsolidation: [...this.reconsolidationLog].reverse().slice(0, 12),
    }
  }

  panelSnapshot(): PanelSnapshot {
    const cells = this.panelCells()
    const byId = new Map(cells.map((c) => [c.cellId, c]))
    const edges: PanelEdgeView[] = this.store
      .allEdges(4000)
      .map((e) => ({
        src: toHex(e.src, 16),
        dst: toHex(e.dst, 16),
        rel: e.rel,
        relName: REL_NAME[e.rel] ?? String(e.rel),
        weight: e.weight,
      }))
      .filter((e) => byId.has(e.src) && byId.has(e.dst))

    const byFrom = [...cells].sort((a, b) => b.tFrom - a.tFrom)
    const byAccess = [...cells].sort((a, b) => b.accessCount - a.accessCount || b.tFrom - a.tFrom)
    // 待确认 = "值得人看一眼"的那一小撮，不是"所有单证据记忆"。
    // 判据：有争议，或者（只被说过一次 且 重要性不低 且 图上是孤立的）。
    // 孤立这一条很关键：一条记忆如果已经和别的东西连起来，说明它在上下文里
    // 被反复提及过，不需要人来确认；孤零零一条才是"可能记错了"的高风险项。
    // 人格锚/关系模型/图式（kind 3/4/5）是系统派生状态，永远 support=1，必须排除。
    const degree = new Map<string, number>()
    for (const e of edges) {
      degree.set(e.src, (degree.get(e.src) ?? 0) + 1)
      degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1)
    }
    const pending = [...cells]
      .filter(
        (c) =>
          c.kind <= 2 &&
          (c.disputed || (!c.invalidated && c.support <= 1 && c.importance >= 0.6 && (degree.get(c.cellId) ?? 0) === 0)),
      )
      .sort((a, b) => Number(b.disputed) - Number(a.disputed) || b.importance - a.importance)

    /**
     * doctor 有缓存（v0.5.2）。
     *
     * `doctor()` 要做完整性检查：孤儿边、悬空槽、孤儿残差——其中两项必须遍历全库。
     * 面板每 3 秒刷新一次，把它放在热路径上等于"每 3 秒做一次全库体检"。
     * 体检是运维动作，30 秒一次足够；面板要的是"最近一次结论"，不是"此刻结论"。
     */
    const doctor = this.cachedDoctor()
    const ann = this.annInfo()

    return {
      version: 2,
      generatedAt: this.now(),
      stats: this.stats(),
      affect: this.affectState,
      cells,
      edges,
      lastRecall: this.lastRecall,
      evictions: this.store.recentEvicts(50),
      proactive: this.proactiveView(),
      runtime: {
        source: 'host',
        dbPath: this.config.dbPath,
        storeKind: this.store.kind,
        preset: this.config.preset,
        surfaceMode: this.config.surfaceMode,
        ignition: this.config.recall.ignition,
        embDim: this.config.embDim,
        embStoreDim: this.config.embStoreDim,
        layoutVersion: Number(this.store.meta('layoutVersion') ?? 3),
        ann: { enabled: ann.enabled, mode: ann.mode, size: ann.size, threshold: ann.threshold },
        l1: { ...this.runtime.l1 },
        commandFace: this.runtime.commandFace,
        remoteFace: this.runtime.remoteFace,
        tools: [...this.runtime.tools],
        capabilities: [...this.runtime.capabilities],
        limits: [...this.runtime.limits],
      },
      index: {
        builtAt: this.now(),
        status: doctor.indexConsistent ? 'ok' : 'stale',
        path: this.config.dbPath,
        entries: cells.length,
        lastRebuildAt: Number(this.store.meta('lastRebuildAt') ?? 0),
      },
      tags: buildTags(cells),
      categories: buildCategories(cells),
      recentNew: byFrom.slice(0, 6),
      recentUpdated: byAccess.filter((c) => c.accessCount > 0).slice(0, 6),
      pending,
      consolidation: this.lastConsolidation,
      retention: this.retentionView(),
    }
  }

  /** 巩固 pass 结束后由 consolidator 回填，面板"最近一次整理"用。 */
  noteConsolidation(r: { merged: number; abstracted: number; pruned: number; decayed: number; elapsedMs: number }): void {
    this.lastConsolidation = { at: this.now(), ...r }
    this.publishPanel()
  }

  /** 面板操作（pin / 改效价 / 遗忘 / 裁决）。`support` 不可手改是刻意的（§12.4）。 */
  applyAction(a: PanelAction): { ok: boolean; message: string } {
    const id = 'cellId' in a ? BigInt('0x' + a.cellId.replace(/^0x/, '').padStart(16, '0')) : undefined
    const cell = id ? this.store.getCell(id) : null
    switch (a.kind) {
      case 'pin':
        if (!cell) return { ok: false, message: 'cell 不存在' }
        cell.flags = a.pinned ? cell.flags | FLAG.noDecay : cell.flags & ~FLAG.noDecay
        if (a.pinned) cell.importance = Math.max(cell.importance, 0.8)
        this.store.putCell(cell)
        this.publishPanel()
        return { ok: true, message: a.pinned ? '已固定（不衰减）' : '已取消固定' }
      case 'valence':
        if (!cell) return { ok: false, message: 'cell 不存在' }
        cell.valence = Math.max(-1, Math.min(1, a.valence))
        if (a.salience !== undefined) cell.salience = Math.max(0, Math.min(1, a.salience))
        this.store.putCell(cell)
        this.publishPanel()
        return { ok: true, message: `效价 → ${fmt2(cell.valence)}` }
      case 'importance':
        if (!cell) return { ok: false, message: 'cell 不存在' }
        cell.importance = Math.max(0, Math.min(1, a.importance))
        this.store.putCell(cell)
        this.publishPanel()
        return { ok: true, message: `重要性 → ${fmt2(cell.importance)}` }
      case 'slot':
        if (!cell) return { ok: false, message: 'cell 不存在' }
        cell.slots = cell.slots.filter((s) => s.role !== a.role)
        if (a.value.trim()) cell.slots.push({ role: a.role, type: 'LIT', value: a.value.trim() })
        cell.sdr = this.reencodeSdr(cell)
        this.store.putCell(cell)
        this.publishPanel()
        return { ok: true, message: '槽位已更新（触发重编码）' }
      case 'restore':
        return this.restore(a.cellId)
      case 'forget':
        if (a.mode === 'hard' && a.confirm !== 'delete') return { ok: false, message: '硬删除需输入 delete 确认' }
        this.forget(a.cellId, a.mode)
        return { ok: true, message: a.mode === 'hard' ? '已物理删除' : '已软删除（可唤醒）' }
      case 'resolve': {
        const A = BigInt('0x' + a.a.replace(/^0x/, ''))
        const B = BigInt('0x' + a.b.replace(/^0x/, ''))
        this.store.putEdge({ src: A, dst: B, rel: REL.SUPERSEDES, weight: 96 })
        const b = this.store.getCell(B)
        if (b) {
          b.flags |= FLAG.disputed
          b.importance = Math.max(0, b.importance * 0.6)
          this.store.putCell(b)
        }
        this.publishPanel()
        return { ok: true, message: '已裁决：新版本覆盖旧版本' }
      }
      case 'proactive': {
        const pro = this.ctx.get('mnemoProactive') as
          | {
              config: Record<string, unknown>
              candidate(now?: number, opts?: { ignoreSchedule?: boolean }): unknown
              fire(c: unknown): void
              muteFor(ms: number): void
              unmute(): void
            }
          | undefined
        if (!pro) return { ok: false, message: '未安装 mnemo-proactive' }
        if (a.action === 'mute') {
          pro.muteFor((a.minutes ?? 120) * 60_000)
          return { ok: true, message: `已静音 ${a.minutes ?? 120} 分钟` }
        }
        if (a.action === 'unmute') {
          pro.unmute()
          return { ok: true, message: '已解除静音' }
        }
        if (a.action === 'config') {
          Object.assign(pro.config, a.patch ?? {})
          this.publishPanel()
          return { ok: true, message: `主动设置已更新：${Object.keys(a.patch ?? {}).join(', ')}` }
        }
        // 'now'：绕过时间表试一次（手动触发不受频率限制，但仍然记账）
        const c = pro.candidate(this.now(), { ignoreSchedule: true })
        if (!c) return { ok: false, message: '当前没有值得主动说的由头（可关掉"必须要有由头"再试）' }
        pro.fire(c)
        return { ok: true, message: `已生成主动开口：${(c as { reason?: string }).reason ?? ''}` }
      }
      case 'reappraise': {
        const affect = this.ctx.get('affect') as { reappraise?(id: string): { ok: boolean; message: string } } | undefined
        if (!affect?.reappraise) return { ok: false, message: '情感内核未安装' }
        const r = affect.reappraise(a.cellId)
        return { ok: r.ok, message: r.message }
      }
      case 'config': {
        const next = this.setConfig(a.patch as Partial<MnemoConfig>)
        return { ok: true, message: `已更新 ${Object.keys(a.patch).join(', ')}（preset=${next.preset}，下一轮生效）` }
      }
      case 'refresh':
        this.publishPanel(true)
        return { ok: true, message: '已刷新' }
      case 'consolidate': {
        const c = this.ctx.get('mnemoConsolidator') as { run(id: string): unknown } | undefined
        if (!c?.run) return { ok: false, message: '未安装 mnemo-consolidator' }
        try {
          const r = c.run(`panel-${this.now()}`) as { merged?: number; abstracted?: number; pruned?: number; decayed?: number; elapsedMs?: number }
          this.noteConsolidation({
            merged: Number(r?.merged ?? 0),
            abstracted: Number(r?.abstracted ?? 0),
            pruned: Number(r?.pruned ?? 0),
            decayed: Number(r?.decayed ?? 0),
            elapsedMs: Number(r?.elapsedMs ?? 0),
          })
          return { ok: true, message: `整理完成：合并 ${r?.merged ?? 0} · 抽象 ${r?.abstracted ?? 0} · 剪枝 ${r?.pruned ?? 0}` }
        } catch (err) {
          return { ok: false, message: `整理失败：${String((err as Error)?.message ?? err)}` }
        }
      }
      case 'rebuild':
        if (a.confirm !== 'rebuild') return { ok: false, message: '重建需输入 rebuild 确认' }
        return { ok: true, message: '重建已排队（异步执行，完成后面板会刷新）' }
      case 'doctor': {
        const d = this.doctor({ fix: a.fix, unlock: a.unlock })
        this.publishPanel(true)
        return {
          ok: d.ok || (a.fix || a.unlock ? true : false),
          message: d.issues.length ? d.issues.join('；') : d.fixed.length ? d.fixed.join('；') : '体检通过，没有发现问题',
        }
      }
      case 'confirm':
        if (!cell) return { ok: false, message: 'cell 不存在' }
        cell.support = Math.max(2, cell.support + 1)
        cell.confidence = Math.min(1, cell.confidence + 0.1)
        cell.flags &= ~FLAG.disputed
        this.store.putCell(cell)
        this.publishPanel()
        return { ok: true, message: '已确认（support +1，双置信度机制里这算一条独立证据）' }
      case 'dismiss':
        if (!cell) return { ok: false, message: 'cell 不存在' }
        cell.importance = Math.min(cell.importance, 0.2)
        this.store.putCell(cell)
        this.store.appendEvict({ cellId: a.cellId, mode: 'soft', reason: a.reason ?? 'panel dismiss', actor: 'user', at: this.now() })
        this.publishPanel()
        return { ok: true, message: '已忽略（降低重要性，不删除）' }
      case 'search':
        return { ok: true, message: `命中 ${this.search(a.q).length} 条` }
      default:
        return { ok: false, message: `未支持的操作: ${(a as { kind: string }).kind}` }
    }
  }

  search(text: string, limit = 50): PanelCellView[] {
    if (!text.trim()) return this.panelCells(limit)
    const qSdr = this.space.bundle(
      (text.match(/[\u4e00-\u9fa5]{2,8}|[A-Za-z_][A-Za-z0-9_.\-]{1,40}/g) ?? [text]).slice(0, 16).map((e) => this.space.identity('E:' + e.toLowerCase())),
    )
    const scored: Array<{ c: MemCell; s: number }> = []
    const needle = text.toLowerCase()
    this.store.forEachCell((c) => {
      let s = this.space.simNorm(qSdr, c.sdr)
      const hay = (c.digest ?? '') + ' ' + c.slots.map((x) => x.value).join(' ')
      if (hay.toLowerCase().includes(needle)) s = Math.max(s, 0.95)
      if (s > 0.05) scored.push({ c, s })
    })
    scored.sort((a, b) => b.s - a.s)
    const cells = scored.slice(0, limit).map((x) => x.c)
    const shortIds = assignShortIds(cells.map((cell) => ({ cell })))
    return cells.map((c, i) => ({
      cellId: toHex(c.cellId, 16),
      shortId: shortIds[i],
      kind: c.kind,
      kindName: KIND_NAME[c.kind] ?? 'fact',
      tier: c.tier,
      tFrom: Number(c.tFrom),
      valence: c.valence,
      arousal: c.arousal,
      salience: c.salience,
      importance: c.importance,
      support: c.support,
      confidence: c.confidence,
      provenance: c.provenance,
      trust: c.trust,
      changed: (c.flags & FLAG.disputed) !== 0,
      pinned: (c.flags & FLAG.noDecay) !== 0,
      disputed: (c.flags & FLAG.disputed) !== 0,
      invalidated: Number(c.tInvalid ?? 0) !== 0,
      lens: (c.lens ?? 'fact') as never,
      emotional: (c.flags & FLAG.emotional) !== 0,
      tInvalid: Number(c.tInvalid ?? 0),
      digest: c.digest ?? '',
      kv: kvPairs(c),
      slots: c.slots,
      residualChars: c.residual?.rawLen ?? 0,
      stability: c.stability,
      accessCount: c.accessCount,
    }))
  }

  /** 主动开口的状态：从 proactive 服务取（未装则为 null，面板显示"未启用"） */
  private proactiveView(): PanelSnapshot['proactive'] {
    const pro = this.ctx.get('mnemoProactive') as
      | {
          config: { enabled: boolean; maxPerDay: number; minIntervalMin: number; quietStart: number; quietEnd: number; idleMin: number }
          snapshot(): {
            blocked: string | null
            todayCount: number
            lastAt: number
            nextEligibleAt: number
            lastCandidate: { text: string; reason: string; kind: string; cellIds: string[]; urgency: number } | null
            skipped: Array<{ at: number; reason: string }>
          }
        }
      | undefined
    if (!pro) return null
    try {
      const st = pro.snapshot()
      return {
        enabled: pro.config.enabled,
        blocked: st.blocked,
        todayCount: st.todayCount,
        maxPerDay: pro.config.maxPerDay,
        minIntervalMin: pro.config.minIntervalMin,
        quietStart: pro.config.quietStart,
        quietEnd: pro.config.quietEnd,
        idleMin: pro.config.idleMin,
        lastAt: st.lastAt,
        nextEligibleAt: st.nextEligibleAt,
        lastCandidate: st.lastCandidate,
        skipped: st.skipped.slice(-6),
      }
    } catch {
      return null
    }
  }

  /** 落盘给 client 侧面板消费（原子替换，避免读到半个文件）。 */
  /**
   * 发布面板快照。
   *
   * ── 为什么要节流 ────────────────────────────────────────────────
   * `panelSnapshot()` 会重建整份面板数据（全量 cell 视图 + doctor 两次全扫 +
   * 标签 + 分类），成本随库线性增长。v0.3 里**每次召回都同步调它一次**——
   * 2000 cell 时一次召回 444ms，其中大半花在"重建一份没人看的面板"上。
   *
   * 现在默认 400ms 合并一次（同一窗口内的多次调用只写一次），
   * 需要立即落盘的路径（面板动作、重建、手动刷新）传 `force = true`。
   */
  publishPanel(force = false): void {
    if (!force) {
      if (this.panelTimer || this.closed) return
      this.panelTimer = setTimeout(() => {
        this.panelTimer = null
        // 定时器可能在 close() 之后才触发：那时 store 已关，再查就是抛异常。
        // 这类"关掉之后还在跑的定时器"是测试里最难查的一类失败（进程级 uncaught）。
        if (this.closed) return
        try {
          this.writePanel()
        } catch {
          /* 面板写失败不影响主链路 */
        }
      }, 400)
      // 不因为这个定时器把进程吊住（CLI/测试里很重要）
      ;(this.panelTimer as unknown as { unref?: () => void }).unref?.()
      return
    }
    if (this.panelTimer) {
      clearTimeout(this.panelTimer)
      this.panelTimer = null
    }
    this.writePanel()
  }

  private writePanel(): void {
    const snap = this.panelSnapshot()
    for (const fn of this.listeners) {
      try {
        fn(snap)
      } catch (err) {
        this.ctx.logger?.('mnemo')?.warn?.(`panel listener failed: ${String(err)}`)
      }
    }
    if (!this.panelPath) return
    try {
      mkdirSync(dirname(this.panelPath), { recursive: true })
      const tmp = this.panelPath + '.tmp'
      writeFileSync(tmp, JSON.stringify(snap), 'utf8')
      renameSync(tmp, this.panelPath)
    } catch (err) {
      this.ctx.logger?.('mnemo')?.warn?.(`publishPanel failed: ${String(err)}`)
    }
  }

  /** client 侧动作队列（无 remote 时的桥；有 remote 时由 tools 直接调 applyAction）。 */
  enqueueAction(a: PanelAction): void {
    this.pendingActions.push(a)
  }

  drainPanelActions(): number {
    if (this.pendingActions.length === 0) return 0
    const batch = this.pendingActions.splice(0, 64)
    for (const a of batch) this.applyAction(a)
    return batch.length
  }

  // ── 内部工具 ────────────────────────────────────────────────────

  private reencodeSdr(cell: MemCell): MemCell['sdr'] {
    const items = cell.slots
      .filter((s) => s.type !== 'UNK' && s.value)
      .slice(0, 8)
      .map((s) => {
        const roleName = SLOT_ROLE_NAME[s.role] ?? String(s.role)
        return this.space.bind(this.space.identity('V:' + s.value.toLowerCase()), this.space.role(roleName))
      })
    return this.space.bundle(items)
  }

  /** 参数热更新（§12.8）。写 mnemo/settings 事件，便于审计谁在什么时候改了什么。 */
  setConfig(patch: Partial<MnemoConfig>): MnemoConfig {
    // 改细项即视为 custom：否则 applyPreset 会把刚改的值覆盖回预设值，
    // 这正是文档 §12.2 要避免的"我改了但被预设覆盖"。
    const touchesFine = Object.keys(patch).some((k) => k !== 'preset')
    const effective = touchesFine && patch.preset === undefined ? { ...patch, preset: 'custom' as const } : patch
    const next = applyPreset({ ...this.config, ...effective })
    const changed = Object.keys(effective)
    // 索引参数变了就丢弃索引（下次召回懒建）：否则"改了 annM 但图还是旧的那张"
    if (changed.some((k) => k.startsWith('recall.ann') || k === 'embStoreDim' || k === 'sdrDim' || k === 'sdrK')) {
      this.ann = null
    }
    this.config = next
    this.emit('mnemo/settings', { changed, preset: next.preset, appliedAt: this.now() })
    this.publishPanel()
    return next
  }

  noteTurn(): number {
    this.turns++
    // turn 结束只释放引用，不删数据（§8.2）；感觉记忆按轮过期（§8.1）
    this.working.clearTurn()
    this.sensory.expire(this.turns)
    return this.turns
  }

  get turnCount(): number {
    return this.turns
  }

  /** 对外日志入口：其他包不该直接摸 this.ctx（protected）。 */
  warn(msg: string): void {
    this.ctx.logger?.('mnemo').warn?.(msg)
  }

  error(msg: string): void {
    this.ctx.logger?.('mnemo').error?.(msg)
  }

  /** 事件发射：cordis 的 Events 由 dsh 包合并，插件自定义事件走宽类型入口 + 运行时校验。 */
  emit(name: string, payload: Record<string, unknown>): void {
    try {
      ;(this.ctx as unknown as { emit: (n: string, p: unknown) => void }).emit(name, payload)
    } catch (err) {
      this.ctx.logger?.('mnemo')?.warn?.(`emit ${name} failed: ${String(err)}`)
    }
  }
}

// ── 辅助 ──────────────────────────────────────────────────────────

export function slotValue(cell: MemCell, roleName: string): string | undefined {
  const role = SLOT_ROLE[roleName as keyof typeof SLOT_ROLE]
  if (!role) return undefined
  const s = cell.slots.find((x) => x.role === role && x.type !== 'UNK')
  return s?.value
}

/** 视角判定：故事 > 感受 > 关系 > 事实。顺序即优先级。 */
export function deriveLens(cell: MemCell): 'fact' | 'feeling' | 'bond' | 'story' {
  if (cell.kind === KIND.narrative) return 'story'
  // 同 ingest：显著度不能当判据（它的基线太高）
  if (Math.abs(cell.valence) >= 0.45) return 'feeling'
  const text = (cell.digest ?? '') + ' ' + cell.slots.map((s) => s.value).join(' ')
  if (/我们|一起|陪我|陪你|在乎|想你|喜欢你|谢谢|约定|答应|吵架|和好/.test(text)) return 'bond'
  return 'fact'
}

/**
 * 谓词家族归一（§7.6）：'喜欢'/'不喜欢'、'用'/'改用'/'部署' 说的是同一件事的不同极/不同说法。
 * 不做这层归一，矛盾检测会漏掉最常见的"用户改主意"形态。
 *
 * v0.5.2 把它提到模块级：`findConflict` 的索引键需要它，而它原来是内联在扫描回调里的闭包
 * ——每遍历一条 cell 就重新建一次函数对象。
 */
export function predFamily(pred?: string): string | undefined {
  if (!pred) return undefined
  if (pred === 'prefers' || pred === 'dislikes') return 'prefers'
  if (pred === 'uses' || pred === 'changes' || pred === 'deploys') return 'uses'
  if (pred === 'decides') return 'decides'
  return pred
}

/**
 * 冲突索引键（v0.5.2 第二版）。
 *
 * 第一版只按 `agent|谓词家族` 分桶——而用户的 agent 永远是"用户"、谓词只有六个家族，
 * 于是桶里躺着全库 1/6 的 cell：实测 400 条时桶大小就是 400，`findConflict`
 * 退化成"每次 ingest 解 400 个 blob"。
 *
 * 真正决定"这两条会不会矛盾"的是**同客体或同方式**（`sameTopic`），
 * 所以键里必须带上 manner / patient。一个 cell 最多落两个桶。
 */
function conflictKeys(cell: MemCell): string[] {
  const fam = predFamily(slotValue(cell, 'PRED'))
  if (!fam) return []
  const agent = slotValue(cell, 'AGENT') ?? ''
  const pol = slotValue(cell, 'POLARITY') ?? 'pos'
  const keys: string[] = []
  const manner = slotValue(cell, 'MANNER')
  const patient = slotValue(cell, 'PATIENT')
  if (manner) keys.push(`${agent}\u0000${fam}\u0000M\u0000${manner}`)
  // patient 桶必须带极性：实测语料里"方案"这种 PATIENT 会横跨全库，
  // 而"同客体"要判成矛盾还需要**极性相反**——把极性放进键里，桶就只剩真正的候选。
  if (patient) keys.push(`${agent}\u0000${fam}\u0000P\u0000${patient}\u0000${pol}`)
  return keys
}

/** 极性取反（`pos` ↔ `neg`；其它值原样返回，让它只匹配同类——宁可漏判也不误判）。 */
function flipPolarity(pol: string): string {
  if (pol === 'pos') return 'neg'
  if (pol === 'neg') return 'pos'
  return pol
}

function sameSlots(a: readonly Slot[], b: readonly Slot[]): boolean {
  const norm = (xs: readonly Slot[]) =>
    xs
      .filter((s) => s.type !== 'UNK')
      .map((s) => `${s.role}:${s.value}`)
      .sort()
      .join('|')
  return norm(a) === norm(b)
}

function sameAgent(a: MemCell, b: MemCell): boolean {
  return (slotValue(a, 'AGENT') ?? '') === (slotValue(b, 'AGENT') ?? '')
}

/** 合并竞争（§7.5）：support 高者胜 → importance 高者胜 → t_ingest 早者胜（可复现）。 */
function compete(a: MemCell, b: MemCell): MemCell {
  if (a.support !== b.support) return a.support > b.support ? a : b
  if (a.importance !== b.importance) return a.importance > b.importance ? a : b
  return Number(a.tIngest) <= Number(b.tIngest) ? a : b
}

function summarize(cell: MemCell): string {
  const kv = kvPairs(cell)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  return `${KIND_NAME[cell.kind] ?? 'fact'} ${mmdd(Number(cell.tFrom))} ${kv} V${fmt2(cell.valence)} S${fmt2(cell.salience)} C${fmt2(cell.confidence)}`
}

/**
 * 冷层 PQ：8 段 × 4 bit → 32 B（§8.4 修 D-07）。丢掉 emb 会让语义召回归零。
 *
 * v0.3 起与 `cell.pq4` 共用同一套量化：先按最大绝对值归一化，再取 4 bit。
 * 不归一化的话，哈希 embedding 的分量只有 ±4…±8，`avg/16` 会全部取整成 0，
 * 冷层向量变成零向量——冷记忆在语义路上永远拿 0 分（实测就是这个结果）。
 */
export function pq32(emb: Int8Array | null): Int8Array | null {
  if (!emb) return null
  if (emb.length <= 32) return emb
  const packed = pq4(emb)
  const out = new Int8Array(32)
  for (let i = 0; i < 32; i++) out[i] = (packed[i] << 28) >> 28
  return out
}

/** 派生 cell id（供编码器用，保证重放幂等）。 */
export function cellIdFor(sessionId: string, seqs: number[], sdr: Uint32Array): bigint {
  return deriveCellId(sessionId, seqs, new Uint8Array(new Uint32Array(sdr).buffer))
}

// ── 面板派生统计 ────────────────────────────────────────────────────

const TAG_STOP = new Set([
  '我们', '他们', '这个', '那个', '一个', '什么', '怎么', '可以', '还是', '就是', '因为', '所以',
  '但是', '现在', '然后', '这样', '那样', '一下', '已经', '需要', '应该', 'the', 'and', 'for',
])

/**
 * 标签云。
 *
 * ── 为什么只取 PATIENT / MANNER / QTY 三个槽 ──────────────────────
 * 第一版从 digest 里用正则抓 2–6 字的片段，结果抓出来的是
 * 「别写进代码」「的缓存方案先」「等宽只用在代」这种半截话——
 * 它看起来像标签，实际上是分词失败的产物。
 *
 * 槽位是**已经抽取过的结构化事实**：PATIENT 是客体、MANNER 是话题、
 * QTY 是数量。这三类才配当标签。AGENT/PRED/POLARITY 是所有记忆共有的结构，
 * 放进标签云只会让每条记忆都长得一样。
 */
export function buildTags(cells: PanelCellView[], limit = 24): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  const ROLE = { PATIENT: 2, MANNER: 6, QTY: 8 } as const
  const keep = new Set<number>([ROLE.PATIENT, ROLE.MANNER, ROLE.QTY])
  const TAG_STOP = new Set(['用户', '助手', '工具', '未知', 'unk'])
  for (const c of cells) {
    for (const s of c.slots) {
      if (!keep.has(s.role) || s.type === 'UNK') continue
      const t = s.value.trim()
      if (t.length < 2 || t.length > 12) continue
      if (TAG_STOP.has(t.toLowerCase())) continue
      if (/^[\d.]+$/.test(t)) continue
      if (/^\d{4}-\d{1,2}(-\d{1,2})?$/.test(t)) continue
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit)
}

/**
 * 分类统计。这一层是**视图投影**，不是新的存储结构——
 * 一条 cell 可以同时进"长期偏好"和"项目"，因为分类问题本来就允许重叠。
 */
export function buildCategories(cells: PanelCellView[]): Array<{ key: string; label: string; count: number }> {
  const cat: Record<string, { label: string; count: number }> = {
    profile: { label: '用户档案', count: 0 },
    preference: { label: '长期偏好', count: 0 },
    project: { label: '项目', count: 0 },
    progress: { label: '项目进展', count: 0 },
    decision: { label: '决策', count: 0 },
    knowledge: { label: '知识', count: 0 },
    lesson: { label: '经验教训', count: 0 },
    task: { label: '任务', count: 0 },
  }
  for (const c of cells) {
    const text = `${c.digest} ${c.slots.map((s) => s.value).join(' ')}`.toLowerCase()
    const pred = (c.slots.find((s) => s.role === 3)?.value ?? '').toLowerCase()
    if (c.kind === 4 || c.kind === 5 || c.lens === 'bond') cat.profile.count++
    if (pred === 'prefers' || pred === 'dislikes' || /喜欢|偏好|习惯|prefer/.test(text)) cat.preference.count++
    if (/项目|仓库|工程|repo|project|模块|服务/.test(text)) cat.project.count++
    if (/进度|进展|里程碑|完成|上线|发布|progress|milestone/.test(text)) cat.progress.count++
    if (pred === 'decides' || /决定|定了|方案|采用|选定|decide/.test(text)) cat.decision.count++
    if (c.kind === 1 || c.kind === 2 || c.kind === 3) cat.knowledge.count++
    if (/教训|踩坑|下次|避免|注意|坑|lesson|pitfall/.test(text)) cat.lesson.count++
    if (/待办|任务|todo|要做|跟进|task/.test(text)) cat.task.count++
  }
  return Object.entries(cat).map(([key, v]) => ({ key, label: v.label, count: v.count }))
}

export { SIM_FLOOR, encodeCell, topicOf, hash64 }
