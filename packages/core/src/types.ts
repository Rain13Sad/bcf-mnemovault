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
  embDim: number
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
  | { kind: 'refresh' }
