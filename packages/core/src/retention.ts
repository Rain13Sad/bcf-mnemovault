/**
 * 保留度（v0.4.0 新增，对应 v0.4 方案 §1.3）
 *
 * ── 为什么换掉「只看最后访问时间」 ────────────────────────────────
 * `forgetting.ts` 的 R(t) 只回答"还提得起来吗"，它把**频率**丢掉了：
 * 一条被反复确认过的事实与一条只出现过一次的同龄记忆，R 完全相同。
 * 而用户真正的诉求是"重要但不常提的事别被冲掉，情感记忆别被稀释"。
 *
 * 这里用 ACT-R 的 base-level activation 把**频率与近因统一进一个量**：
 *
 *     B = ln( Σ_j (t_now − t_j)^(−d) ),  d = 0.5
 *
 * 它天然是幂律，与 R(t) = (1+Ft/S)^(−d) 形状一致，可以无缝替换。
 *
 * ── 七因子 ──────────────────────────────────────────────────────
 * activation（频率+近因）· importance（编码自评）· affectIntensity（情绪强度）
 * connectivity（图枢纽度）· narrativeRole（叙事角色）· userAffinity（用户锚定）
 * spacing（间隔效应）· 减 redundancy（冗余惩罚）
 *
 * ── 六档处置，物理删除永不自动执行 ───────────────────────────────
 * P5 保持 / P4 压缩 / P3 摘要化 / P2 归档 / P1 墓碑 / P0 物理删除（仅用户显式发起）。
 * 六道"永不删除"的闸优先于任何分数——它们是预防原则的工程形态：
 * 判断错一次的代价（永久丢掉"那天你怎么说"）远高于多留一条的存储成本。
 */

import { FLAG, KIND, type MemCell } from './cell.js'
import type { PresetName } from './preset.js'

const DAY = 86_400_000
/** ACT-R 衰减指数。0.5 是 Anderson 的经典取值。 */
export const ACTR_D = 0.5
/** 归一化上下界：B 的实测范围约 −9（一年未访问）… −1（刚访问且高频）。 */
const B_FLOOR = -10
const B_CEIL = -1

export interface RetentionInputs {
  /** ACT-R 激活归一化到 0..1 */
  activation: number
  /** 编码时自评的重要度 0..1 */
  importance: number
  /** max(|valence|, arousal)，情感强度 */
  affectIntensity: number
  /** log1p(degree)/log1p(maxDegree)，图上的枢纽程度 */
  connectivity: number
  /** 0=普通 0.5=关系节点 1=里程碑 */
  narrativeRole: number
  /** pinned / 用户一手 / 被确认过 */
  userAffinity: number
  /** 间隔效应 0..1 */
  spacing: number
  /** 与最近邻的冗余 0..1（惩罚项） */
  redundancy: number
}

export interface RetentionWeights {
  activation: number
  importance: number
  affect: number
  connectivity: number
  narrative: number
  affinity: number
  spacing: number
  redundancy: number
  /** 阈值偏移：越大越"舍得忘" */
  bias: number
  /**
   * 线性增益：score = 0.5 + gain·(base − bias)。
   *
   * 增益必须**小于 1**：base 的实测区间只有 0.08（两年未访问的琐事）… 0.76（刚说的重要事实），
   * 用 1.4 这种斜率会让区间上半段全部饱和到 1.0，面板上每条记忆都是满分、七因子分解失去意义。
   * 现在的取值让 90 天的重要事实落在 P4、新说的重要事实落在 P5。
   */
  gain: number
}

/**
 * 三档权重。fidelity 把 affect 提到最高（情绪记忆最不该被稀释），
 * lean 反过来更看重 affinity（用户亲口说的比"聊得多"重要）。
 */
export const RETENTION_WEIGHTS: Record<PresetName, RetentionWeights> = {
  lean: { activation: 0.3, importance: 0.18, affect: 0.16, connectivity: 0.08, narrative: 0.1, affinity: 0.22, spacing: 0.05, redundancy: 0.18, bias: 0.3, gain: 0.55 },
  balanced: { activation: 0.3, importance: 0.26, affect: 0.24, connectivity: 0.1, narrative: 0.12, affinity: 0.2, spacing: 0.08, redundancy: 0.15, bias: 0.24, gain: 0.62 },
  fidelity: { activation: 0.26, importance: 0.26, affect: 0.3, connectivity: 0.12, narrative: 0.16, affinity: 0.24, spacing: 0.08, redundancy: 0.08, bias: 0.2, gain: 0.68 },
}

export type Disposition = 'P5' | 'P4' | 'P3' | 'P2' | 'P1'

export const DISPOSITION_LABEL: Record<Disposition, string> = {
  P5: '保持',
  P4: '压缩',
  P3: '摘要化',
  P2: '归档',
  P1: '墓碑',
}

/** 档位下界（含）。P5 ≥ 0.75、P4 ≥ 0.55、P3 ≥ 0.35、P2 ≥ 0.18、其余 P1。 */
export const DISPOSITION_FLOOR: Record<Disposition, number> = { P5: 0.75, P4: 0.55, P3: 0.35, P2: 0.18, P1: 0 }

/**
 * ACT-R 激活。
 *
 * 库里只存 `accessCount / tAccess / tIngest`，没有每一次提取的时间戳，
 * 因此把 n 次提取视为在 [tIngest, tAccess] 上**均匀分布**逐项求和：
 *   · n = 1 时退化为单项，与定义完全一致；
 *   · n > 1 时对近期项有系统性低估，再用 tAccess 单独补一项（权重 0.5）修正。
 * 这是可解释的近似，而不是"拍一个数字"。
 */
export function actrActivation(accessCount: number, tAccessMs: number, tIngestMs: number, nowMs: number, d = ACTR_D): number {
  const now = nowMs
  const n = Math.max(1, Math.floor(accessCount || 1))
  const last = Math.max(0, now - (tAccessMs || tIngestMs || now)) / 1000
  const span = Math.max(0, (tAccessMs || now) - (tIngestMs || tAccessMs || now)) / 1000
  let sum = 0
  if (n === 1) {
    sum = Math.pow(Math.max(1, last), -d)
  } else {
    for (let j = 0; j < n; j++) {
      // j=0 是最早的一次，j=n−1 是最近的一次
      const t = span * (j / (n - 1))
      sum += Math.pow(Math.max(1, last + (span - t)), -d)
    }
    sum += 0.5 * Math.pow(Math.max(1, last), -d)
  }
  return Math.log(Math.max(1e-12, sum))
}

/** B → 0..1。线性映射而不是 sigmoid：档位阈值需要可预测，不能挤在 0.5 附近。 */
export function activationNorm(b: number): number {
  return clamp01((b - B_FLOOR) / (B_CEIL - B_FLOOR))
}

/**
 * 间隔效应：分散复习优于集中突击。
 * 用"平均间隔"与"提取次数"两个量，都有上限，防止刷次数把分数顶满。
 */
export function spacingScore(accessCount: number, tIngestMs: number, tAccessMs: number): number {
  const n = Math.max(0, Math.floor(accessCount || 0))
  if (n <= 1) return 0
  const spanDays = Math.max(0, (tAccessMs - tIngestMs) / DAY)
  const meanInterval = spanDays / Math.max(1, n - 1)
  const spread = clamp01(meanInterval / 3)
  const reps = clamp01(Math.log1p(n) / Math.log1p(8))
  return clamp01(0.35 + 0.65 * spread) * reps
}

/** 周年效应：|now − tFrom| mod 365 落在 ±3 天内，保留度临时 +0.25。 */
export function anniversaryBoost(tFromMs: number, nowMs: number): number {
  if (!tFromMs) return 0
  const days = Math.abs(nowMs - tFromMs) / DAY
  if (days < 300) return 0
  const rem = days % 365
  const dist = Math.min(rem, 365 - rem)
  if (dist > 3) return 0
  return 0.25 * (1 - dist / 3.5)
}

/** 用户锚定：pin > 用户亲口一手 > 被确认过 > 单证据。 */
export function userAffinityOf(cell: MemCell): number {
  if (cell.flags & FLAG.noDecay) return 1
  if (cell.trust >= 240 && cell.provenance === 0) return 0.8
  if (cell.support >= 3) return 0.6
  if (cell.support >= 2) return 0.35
  return 0
}

/** 叙事角色：故事线节点 > 关系模型 > 里程碑。 */
export function narrativeRoleOf(cell: MemCell): number {
  if (cell.flags & FLAG.milestone) return 1
  if (cell.kind === KIND.narrative) return 0.6
  if (cell.kind === KIND.relational) return 0.4
  if (cell.kind === KIND.persona) return 0.8
  return 0
}

/**
 * 情绪强度。
 *
 * **刻意不用 salience**：它的基线经 tanh 归一化后就在 0.7 附近，
 * 拿它当强度会把每条事实都算成"高情绪"（v0.3 的 ingest 踩过同一个坑）。
 * 这里只取 |valence| 与 arousal，闪光灯标记额外加 0.3。
 */
export function affectIntensityOf(cell: MemCell): number {
  const raw = Math.max(Math.abs(cell.valence), cell.arousal)
  const bump = cell.flags & FLAG.emotional ? 0.3 : 0
  return clamp01(Math.max(raw, bump))
}

/** 单条保留度打分。纯函数：同样的输入永远同样的输出，便于回归与面板解释。 */
export function retentionScore(x: RetentionInputs, w: RetentionWeights): number {
  const base =
    w.activation * x.activation +
    w.importance * x.importance +
    w.affect * x.affectIntensity +
    w.connectivity * x.connectivity +
    w.narrative * x.narrativeRole +
    w.affinity * x.userAffinity +
    w.spacing * x.spacing -
    w.redundancy * x.redundancy
  return clamp01(0.5 + w.gain * (base - w.bias))
}

export function disposition(score: number): Disposition {
  if (score >= DISPOSITION_FLOOR.P5) return 'P5'
  if (score >= DISPOSITION_FLOOR.P4) return 'P4'
  if (score >= DISPOSITION_FLOOR.P3) return 'P3'
  if (score >= DISPOSITION_FLOOR.P2) return 'P2'
  return 'P1'
}

/** 六档 → 存储层 tier。P1 与 P2 都落在归档层（墓碑仍可"复活"，只是不再参与热检索）。 */
export function tierForDisposition(d: Disposition): 0 | 1 | 2 | 3 {
  switch (d) {
    case 'P5':
      return 0
    case 'P4':
      return 1
    case 'P3':
      return 2
    default:
      return 3
  }
}

export interface RetentionContext {
  nowMs: number
  weights: RetentionWeights
  /** 图上最大度数（归一化用）；缺省 1 表示不归一化 */
  maxDegree?: number
  /** 该 cell 的出度 */
  degree?: number
  /** 与邻居的冗余 0..1 */
  redundancy?: number
  /** 是否存在 SUPERSEDES 出边（版本链环节） */
  hasSupersedes?: boolean
  /** 是否仍被其他记忆引用（入边 > 0） */
  referencedByOthers?: boolean
}

export interface RetentionResult {
  score: number
  disposition: Disposition
  /** 各因子原始值（未乘权重），面板画堆叠条用 */
  parts: RetentionInputs
  /** 各因子已乘权重的贡献值 */
  contributions: Record<keyof RetentionInputs, number>
  activationRaw: number
  /** 命中六道闸时返回理由，否则 null */
  protectedBy: string | null
  tier: 0 | 1 | 2 | 3
  /** 周年加成（已并入 score） */
  anniversary: number
}

/**
 * 六道"永不删除"的闸（hard gate）。
 *
 * 顺序即优先级：越靠前越"不可辩驳"。
 * 命中任意一条 → 该 cell 至少保留在 P4 以上，永不进入墓碑。
 */
export function protectedFromDeletion(
  cell: MemCell,
  opts: { hasSupersedes?: boolean; referencedByOthers?: boolean } = {},
): string | null {
  if (cell.flags & FLAG.noDecay) return '用户 pin'
  if (cell.flags & FLAG.emotional) return '情感记忆（闪光灯）'
  if (cell.kind === KIND.persona) return '人格锚'
  if (cell.kind === KIND.narrative && cell.flags & FLAG.milestone) return '关系里程碑'
  if (cell.trust >= 240 && cell.provenance === 0) return '用户亲口所述的一手事实'
  if (opts.hasSupersedes) return '版本链环节（删了历史就断了）'
  if (opts.referencedByOthers) return '仍被其他记忆引用'
  return null
}

/** 一次算全：分数、档位、分解、闸门。面板与降层 pass 共用这一条路径。 */
export function evaluateRetention(cell: MemCell, ctx: RetentionContext): RetentionResult {
  const degree = Math.max(0, ctx.degree ?? 0)
  const maxDegree = Math.max(1, ctx.maxDegree ?? 1)
  const activationRaw = actrActivation(cell.accessCount, Number(cell.tAccess), Number(cell.tIngest), ctx.nowMs)
  const parts: RetentionInputs = {
    activation: activationNorm(activationRaw),
    importance: clamp01(cell.importance),
    affectIntensity: affectIntensityOf(cell),
    connectivity: clamp01(Math.log1p(degree) / Math.log1p(maxDegree)),
    narrativeRole: narrativeRoleOf(cell),
    userAffinity: userAffinityOf(cell),
    spacing: spacingScore(cell.accessCount, Number(cell.tIngest), Number(cell.tAccess)),
    redundancy: clamp01(ctx.redundancy ?? 0),
  }
  const w = ctx.weights
  const contributions: Record<keyof RetentionInputs, number> = {
    activation: w.activation * parts.activation,
    importance: w.importance * parts.importance,
    affectIntensity: w.affect * parts.affectIntensity,
    connectivity: w.connectivity * parts.connectivity,
    narrativeRole: w.narrative * parts.narrativeRole,
    userAffinity: w.affinity * parts.userAffinity,
    spacing: w.spacing * parts.spacing,
    redundancy: -w.redundancy * parts.redundancy,
  }
  const anniversary = anniversaryBoost(Number(cell.tFrom), ctx.nowMs)
  let score = clamp01(retentionScore(parts, w) + anniversary)

  const protectedBy = protectedFromDeletion(cell, { hasSupersedes: ctx.hasSupersedes, referencedByOthers: ctx.referencedByOthers })
  /**
   * 闸门的作用是"不许掉进墓碑"，**不是**"永远保持热层"。
   *
   * v0.4 的初版把闸门写成"至少 P4"，结果所有用户亲口说过的话都永远温热——
   * 而本项目里每条用户发言都是 provenance=0/trust=240，等于把六档压成了两档。
   * 现在：普通闸门保到 P3（摘要化，内容不丢但可以降温），情感记忆保到 P4
   * （情绪记忆的逆衰减，对应 §1.3.4），pin 由调用方直接跳过整条降档流程。
   */
  if (protectedBy) {
    const floor = cell.flags & FLAG.emotional ? DISPOSITION_FLOOR.P4 : DISPOSITION_FLOOR.P3
    score = Math.max(score, floor + 0.01)
  }
  // 情感记忆的逆衰减：高唤醒的闪光灯记忆强行拉回热层。
  if (cell.flags & FLAG.emotional && parts.affectIntensity >= 0.7) score = Math.max(score, DISPOSITION_FLOOR.P5 + 0.03)

  const d = disposition(score)
  return {
    score: round3(score),
    disposition: d,
    parts,
    contributions,
    activationRaw,
    protectedBy,
    tier: tierForDisposition(d),
    anniversary,
  }
}

/** 面板文案：为什么它还在 / 为什么快没了。 */
export function retentionWhy(r: RetentionResult, kindName = '记忆'): string {
  if (r.protectedBy) return `${r.protectedBy}：不参与自动清理`
  if (r.disposition === 'P5') {
    const top = topFactor(r)
    return `保留度 ${r.score.toFixed(2)}：主要靠${top}`
  }
  if (r.disposition === 'P1' || r.disposition === 'P2') {
    const weak = weakestFactor(r)
    return `保留度 ${r.score.toFixed(2)}：${weak}偏低，已降到${DISPOSITION_LABEL[r.disposition]}`
  }
  return `${kindName}保留度 ${r.score.toFixed(2)}，处于${DISPOSITION_LABEL[r.disposition]}档`
}

const FACTOR_LABEL: Record<keyof RetentionInputs, string> = {
  activation: '频率与近因',
  importance: '重要度',
  affectIntensity: '情绪强度',
  connectivity: '关联度',
  narrativeRole: '叙事角色',
  userAffinity: '用户锚定',
  spacing: '间隔效应',
  redundancy: '冗余',
}

function topFactor(r: RetentionResult): string {
  const entries = Object.entries(r.contributions) as Array<[keyof RetentionInputs, number]>
  const best = entries.sort((a, b) => b[1] - a[1])[0]
  return best ? FACTOR_LABEL[best[0]] : '综合因素'
}

function weakestFactor(r: RetentionResult): string {
  const entries = (Object.entries(r.parts) as Array<[keyof RetentionInputs, number]>).filter(([k]) => k !== 'redundancy')
  const worst = entries.sort((a, b) => a[1] - b[1])[0]
  return worst ? FACTOR_LABEL[worst[0]] : '综合因素'
}

export const FACTOR_ORDER: Array<keyof RetentionInputs> = [
  'activation',
  'importance',
  'affectIntensity',
  'connectivity',
  'narrativeRole',
  'userAffinity',
  'spacing',
  'redundancy',
]

export const FACTOR_NAME = FACTOR_LABEL

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0))
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
