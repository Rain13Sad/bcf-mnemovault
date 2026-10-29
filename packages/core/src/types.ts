/**
 * 包族共享类型。凡是跨包传递的形状都在这里定义一次，
 * 避免 core / affect / recall / tools 各写一份而悄悄漂移。
 */

import type { CellKind, Slot } from './cell.js'
import type { ForgettingProfile } from './forgetting.js'

// ── 情感 ────────────────────────────────────────────────────────────

/** 虚拟内稳态：6 个运行时真实可测的内部变量（§11.1）。 */
export interface Intero {
  /** 任务负荷：并行子任务多、上下文长 */
  load: number
  /** 不确定性：检索命中率低、工具连续失败 */
  uncert: number
  /** 冲突度：记忆互相矛盾、指令冲突 */
  conflict: number
  /** 关系张力：用户否定、纠正、重复追问 */
  strain: number
  /** 目标进度：计划滞后、阻塞 */
  progress: number
  /** 预算余量：token / 时间 / 调用次数消耗 */
  budget: number
}

/** 6 维评价（§11.2 ②）。 */
export interface Appraisal {
  goalRel: number
  goalCon: number
  agency: number
  certainty: number
  novelty: number
  norm: number
  /**
   * 情绪强度（-1..1）：这句话本身有多"带电"，与是否推进目标无关。
   * 文档的六维是"认知评价"，但陪伴场景里"用户很难受"这件事必须先被感知到——
   * 哪怕它和当前任务毫无关系。这是对六维的**增量**，不是替换。
   */
  charge?: number
}

/** 核心情感 PAD + 显著度。v/a/d ∈ [−1,1]，s ∈ [0,1]。 */
export interface Pad {
  v: number
  a: number
  d: number
  s: number
}

export interface RelationalSnapshot {
  trust: number
  familiarity: number
  attunement: number
  boundaries: string[]
  repairDebt: number
  turns: number
}

/** 情感 → 行为的策略表（§11.6）。这是硬约束，可回归测试。 */
export interface AffectPolicy {
  /** 澄清倾向：0 不主动问，2 先问再做 */
  clarification: number
  /** 输出精简档位：−1 精简，0 正常，+1 展开 */
  verbosity: -1 | 0 | 1
  /** 语气降温系数，1 = 正常 */
  warmth: number
  /** 必须显式列出矛盾并要求裁决 */
  requireConflictResolution: boolean
  /** 高风险工具转 ask */
  escalateApproval: boolean
  /** 停止发散游走 */
  disableDivergence: boolean
  /** 主动重述目标 */
  restateGoal: boolean
  /** 本轮建议的 sampling temperature 偏移 */
  temperatureDelta: number
  /** 触发原因，供 UI 与解释器展示 */
  reasons: string[]
}

// ── 配置 ────────────────────────────────────────────────────────────

export type Preset = 'lean' | 'balanced' | 'fidelity' | 'custom'
export type SurfaceMode = 'rows' | 'compact' | 'prose'

export interface RecallWeights {
  wSim: number
  wRecency: number
  wFreq: number
  wAffect: number
  wGoal: number
  wCue: number
  wInterf: number
  ignition: number
  annTopK: number
  /**
   * HNSW 开关。cell 数 < annThreshold 时仍然走精确余弦扫描——
   * 小库上全扫更快、且没有近似误差，"有索引"不等于"必须用索引"。
   */
  annEnabled: boolean
  /** 触发 ANN 的最小 cell 数（默认 2000） */
  annThreshold: number
  /** HNSW 每层最大邻居数 */
  annM: number
  /** 查询期搜索宽度 */
  annEf: number
  graphHops: number
  graphDecay: number
}

export interface ConsolidationConfig {
  everyTurns: number
  everyCells: number
  idleMs: number
  schemaMinSupport: number
  remValenceDecay: number
  remArousalDecay: number
  remLinkBudget: number
}

export interface SafetyConfig {
  piiRedaction: boolean
  blockMemoryInEgress: boolean
  requireApprovalFor: string[]
}

export interface MnemoConfig {
  dbPath: string
  /** 作用域键：单机 'user:local'；多用户部署传 'user:<id>'（§14.10） */
  scopeKey: string
  residualDir: string
  sdrDim: number
  sdrK: number
  /** 计算向量的维度（哈希桶数） */
  embDim: number
  /**
   * 落盘向量的维度（MC03）。计算仍在 embDim 上做，写入前折叠到这一维，
   * 每条 cell 因此从 256 B 降到 64 B——这是存储比能达标的主因之一。
   * 改它必须 rebuild。
   */
  embStoreDim: number
  preset: Preset
  maxSlots: number
  maxEntriesPerTurn: number
  surfaceMode: SurfaceMode
  maxSurfaceTokens: number
  forgettingProfile: ForgettingProfile
  affectEnabled: boolean
  recall: RecallWeights
  consolidation: ConsolidationConfig
  safety: SafetyConfig
}

// ── 检索 ────────────────────────────────────────────────────────────

export interface RecallQuery {
  text: string
  /** 当前 PAD（affect 缺席时用中性） */
  pad?: Pad
  /** 当前话题指纹（cell.topic 口径） */
  topic?: string
  /** 当前 goal 的 SDR 与实体，无 goal 时 undefined → 不计 w_goal */
  goal?: { sdrText: string; entities: string[] }
  /** surface 预算（token） */
  budget: number
  /** 手动检索（工具/命令）跳过门控与 ignition */
  manual?: boolean
  /**
   * 双时态查询：按"当时认为"的口径取快照（§9.1 Q4 的时间推理扩展）。
   * 给了 asOf 就只返回 `t_from <= asOf` 且当时仍然有效的 cell，
   * 这才是"上周三我们定了什么"的正确答案——而不是"现在的版本"。
   */
  asOf?: number
  /** 面板/诊断用：连已失效的版本一起返回（默认 false） */
  includeInvalidated?: boolean
  kinds?: CellKind[]
  /** 视角过滤：只看事实 / 只看感受 / 只看关系 / 只看故事（多角度记忆） */
  lens?: 'fact' | 'feeling' | 'bond' | 'story'
  timeRange?: { from: number; to: number }
  /** 关系快照，用于情感状态行（缺省时用中性值，而不是编一个 0.5） */
  relational?: { trust: number; familiarity: number }
  /**
   * 作用域（§14.10）：
   *   'session'（默认）—— 情景记忆只在同一会话内可见
   *   'global' —— 放宽到全部作用域（用户显式要求"翻遍所有记忆"时用）
   */
  scope?: 'session' | 'global'
  sessionId?: string
  /** 作用域键：单机部署固定 'user:local'，多用户时是 'user:<id>'（v0.6 的 ACL 基础） */
  scopeKey?: string
  /** 内部：上一次查询，用于 why/explain */
  queryId?: string
}

export interface ScoreParts {
  sim: number
  recency: number
  freq: number
  affect: number
  goal: number
  cue: number
  interf: number
}

export interface ScoreBreakdown {
  cellId: string
  /** 各分量**已乘权重**后的贡献值 */
  parts: ScoreParts
  /** 各分量的原始 [0,1] 值，供解释器显示 "0.62 × 1.00" */
  raw: Record<keyof ScoreParts, number>
  weights: Record<keyof ScoreParts, number>
  rawSum: number
  activeW: number
  score: number
  slot: number
  channel: RecallChannel | 'mixed'
  notes: string[]
}

export type RecallChannel = 'semantic' | 'symbolic' | 'graph' | 'temporal'

export interface RecallHit {
  cellId: string
  shortId: string
  score: number
  slot: number
  channel: RecallChannel | 'mixed'
}

export interface RecallResult {
  queryId: string
  strategy: 'semantic' | 'symbolic' | 'graph' | 'temporal' | 'mixed'
  hits: RecallHit[]
  rendered: string
  tokens: number
  surfaceMode: SurfaceMode
  snapshotId: string
  breakdowns: ScoreBreakdown[]
  candidates: number
  elapsedMs: number
  slotsUsed: number
  emptySlots: number
}

export interface ExpandResult {
  cellId: string
  level: 0 | 1 | 2
  text: string
  tokens: number
  /** 被 compaction 遮蔽时的提示（§14.9） */
  shadowed: boolean
  truncated: boolean
  chars: number
}

export interface StatsSnapshot {
  cells: number
  edges: number
  bytes: number
  byKind: Record<string, number>
  byTier: Record<string, number>
  supportOne: number
  disputed: number
  invalidated: number
  contradictions: number
  hitRate: number
  tokensPerTurn: number
  tokenSeries: Array<{ turn: number; tokens: number }>
  storageRatio: number
  recallP95Ms: number
  turns: number
  evictions: number
}

export interface DoctorReport {
  ok: boolean
  orphanEdges: number
  danglingSlots: number
  staleLocks: number
  indexConsistent: boolean
  layoutVersion: number
  sdrDim: number
  issues: string[]
  fixed: string[]
}

// ── 面板快照（host → client，§12.10 / §20.2） ───────────────────────

export interface PanelCellView {
  cellId: string
  shortId: string
  kind: number
  kindName: string
  tier: number
  tFrom: number
  valence: number
  arousal: number
  salience: number
  importance: number
  support: number
  confidence: number
  provenance: number
  trust: number
  changed: boolean
  pinned: boolean
  disputed: boolean
  /** 记忆视角（事实/感受/关系/故事） */
  lens: 'fact' | 'feeling' | 'bond' | 'story'
  /** 情感记忆（闪光灯记忆），不参与情绪衰减 */
  emotional: boolean
  /** 已被更新的版本取代（tInvalid ≠ 0），仍保留可回溯 */
  invalidated: boolean
  tInvalid: number
  digest: string
  kv: Array<[string, string]>
  slots: Slot[]
  residualChars: number
  stability: number
  accessCount: number
}

export interface PanelEdgeView {
  src: string
  dst: string
  rel: number
  relName: string
  weight: number
}

/**
 * 运行时自检信息（§12.4 的"后端能力"区块）。
 *
 * 这一块存在的理由很具体：文档里所有"未实机验证"的能力（L1 端口、ANN、remote 面、
 * 命令面）都必须有一个**运行时可读**的状态，而不是靠 README 里的一句话。
 * 面板直接展示它，doctor 也读它——"未经测量的能力不该被说成已有"。
 */
export interface PanelRuntimeInfo {
  /** 面板数据源：remote / event / demo */
  source: string
  dbPath: string
  storeKind: string
  preset: string
  surfaceMode: string
  ignition: number
  embDim: number
  embStoreDim: number
  layoutVersion: number
  /** 语义路当前形态 */
  ann: { enabled: boolean; mode: 'exact' | 'hnsw'; size: number; threshold: number }
  /** L1 切分当前形态 */
  l1: { enabled: boolean; mode: 'port' | 'lite' | 'l0'; entry: string | null; ok: boolean; lastMs: number; note: string }
  /** 命令面形态 */
  commandFace: 'cmdline' | 'tool' | 'none'
  /** 是否已提供 remote 面 */
  remoteFace: boolean
  /** 已注册的模型可见工具 */
  tools: string[]
  /** 能力标签（面板显示成 chip） */
  capabilities: string[]
  /** 限制说明（诚实清单） */
  limits: string[]
}

export interface PanelIndexInfo {
  builtAt: number
  status: 'ok' | 'stale' | 'rebuild'
  path: string
  entries: number
  lastRebuildAt: number
}

export interface PanelSnapshot {
  version: 2
  generatedAt: number
  stats: StatsSnapshot
  affect: {
    enabled: boolean
    intero: Intero
    pad: Pad
    mood: Pad
    relational: RelationalSnapshot
    policy: AffectPolicy
    /** 人格锚：当前向量、基线、版本号（§11.8） */
    persona?: { rev: number; vector: number[]; baseline: number[] }
    /** 离线环抽出的用户图式（§11.7） */
    schema?: Array<{ topic: string; pattern: string; confidence: number; support: number }>
    /** 依恋度 0..1（熟悉 40% + 信任 30% + 共同情绪事件 30%） */
    attachment?: number
    /** 关系阶段 */
    stage?: { key: string; label: string; progress: number }
    /** PAD 轨迹（每轮一点） */
    trajectory?: Array<{ turn: number; v: number; a: number; d: number }>
    /** 未平复的情绪事件 */
    episodes?: Array<{ turn: number; v: number; a: number; strength: number; trigger: string }>
  } | null
  cells: PanelCellView[]
  edges: PanelEdgeView[]
  lastRecall: {
    queryId: string
    at: number
    tokens: number
    hits: RecallHit[]
    breakdowns: ScoreBreakdown[]
    rendered: string
  } | null
  evictions: Array<{ cellId: string; mode: string; reason: string; actor: string; at: number }>
  /** 运行时自检（L1 / ANN / 命令面 / remote 面） */
  runtime?: PanelRuntimeInfo
  /** 索引状态（面板"索引状态"区块） */
  index?: PanelIndexInfo
  /** 标签云（由 topic 指纹投影而来） */
  tags?: Array<{ tag: string; count: number }>
  /** 分类统计（用户档案 / 长期偏好 / 项目 / 决策 / 知识 / 经验教训 / 任务） */
  categories?: Array<{ key: string; label: string; count: number }>
  /** 最近新增 / 最近更新（面板四列） */
  recentNew?: PanelCellView[]
  recentUpdated?: PanelCellView[]
  /** 待确认（support=1 且高重要性 / 有争议） */
  pending?: PanelCellView[]
  /** 最近一次巩固 pass 的结果 */
  consolidation?: { at: number; merged: number; abstracted: number; pruned: number; decayed: number; elapsedMs: number } | null
  /** 主动开口的状态（未装 proactive 包时为 null） */
  proactive: {
    enabled: boolean
    blocked: string | null
    todayCount: number
    maxPerDay: number
    minIntervalMin: number
    quietStart: number
    quietEnd: number
    idleMin: number
    lastAt: number
    nextEligibleAt: number
    lastCandidate: { text: string; reason: string; kind: string; cellIds: string[]; urgency: number } | null
    skipped: Array<{ at: number; reason: string }>
  } | null
}

export type PanelAction =
  | { kind: 'pin'; cellId: string; pinned: boolean }
  | { kind: 'valence'; cellId: string; valence: number; salience?: number }
  | { kind: 'importance'; cellId: string; importance: number }
  | { kind: 'slot'; cellId: string; role: number; value: string }
  | { kind: 'forget'; cellId: string; mode: 'soft' | 'hard'; confirm?: string }
  | { kind: 'resolve'; a: string; b: string }
  | { kind: 'preset'; preset: Preset }
  | { kind: 'surfaceMode'; mode: SurfaceMode }
  /** 通用参数热更新（调参向导用）。改细项即视为 preset=custom。 */
  | { kind: 'config'; patch: Record<string, number | string | boolean> }
  | { kind: 'search'; q: string }
  /** 主动开口：立即试一次 / 静音 N 分钟 / 解除静音 / 改频率 */
  | { kind: 'proactive'; action: 'now' | 'mute' | 'unmute' | 'config'; minutes?: number; patch?: Record<string, number | boolean> }
  /** 情感再评估：用当前心境重估一条记忆的效价 */
  | { kind: 'reappraise'; cellId: string }
  /** 立即跑一次双相巩固 */
  | { kind: 'consolidate' }
  /** 从会话日志重建晶格（危险操作，需 confirm='rebuild'） */
  | { kind: 'rebuild'; confirm?: string }
  /** 体检 / 修孤儿边 / 清遗留锁 */
  | { kind: 'doctor'; fix?: boolean; unlock?: boolean }
  /** 收件箱：把一条待确认记忆标记为"已确认"（提升 support）或"忽略"（降重要性） */
  | { kind: 'confirm'; cellId: string }
  | { kind: 'dismiss'; cellId: string; reason?: string }
  | { kind: 'refresh' }
