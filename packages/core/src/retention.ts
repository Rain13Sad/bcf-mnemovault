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

/**
 * 陈旧包络（v0.5 新增）。
 *
 * v0.4 的一个致命偏差：七因子里六个是**静态**的（重要度、情绪、关联、叙事、锚定、间隔），
 * 只有 activation 随时间变化，于是 400 天没被碰过的用户陈述仍然拿 0.73（P4）——
 * 「库只进不出」的真正原因不是闸，是**价值项不随时间贬值**。
 *
 * 这里加一个乘性包络：30 天内不折损，之后线性下降，730 天到地板 0.15。
 * 它不是"遗忘曲线回来了"——它不决定档位，只是把"你早就想不起它了"这件事
 * 折算进价值判断：想不起来的记忆，谈不上多重要。
 */
export const STALE_ONSET_DAYS = 30
export const STALE_SPAN_DAYS = 700
export const STALE_FLOOR = 0.15

export function staleFactor(tAccessMs: number, nowMs: number): number {
  const days = Math.max(0, nowMs - (tAccessMs || nowMs)) / DAY
  const over = Math.max(0, days - STALE_ONSET_DAYS)
  const env = clamp01(1 - over / STALE_SPAN_DAYS)
  return clamp01(STALE_FLOOR + (1 - STALE_FLOOR) * env)
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
  if (cell.trust >= 240 && cell.provenance === 0) return 0.7
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

/**
 * 六档 → 存储层 tier。
 *
 * v0.4 把 P2 与 P1 都映射到 tier 3，结果是"墓碑"这个概念名存实亡：
 * 存储层分不出"归档但还能展开"与"只剩摘要"。
 * v0.5 起 P1 独占 **tier 4 = tombstone**，并且 tombstone 不参与召回。
 */
export function tierForDisposition(d: Disposition): 0 | 1 | 2 | 3 | 4 {
  switch (d) {
    case 'P5':
      return 0
    case 'P4':
      return 1
    case 'P3':
      return 2
    case 'P2':
      return 3
    default:
      return 4
  }
}

/** tier → 档位（面板与 doctor 反查用）。 */
export function dispositionForTier(tier: number): Disposition {
  if (tier <= 0) return 'P5'
  if (tier === 1) return 'P4'
  if (tier === 2) return 'P3'
  if (tier === 3) return 'P2'
  return 'P1'
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
  /**
   * 本 cell 是否**已被取代**（SUPERSEDES 边的 dst 侧）。
   *
   * v0.4 把这里写成 `hasSupersedes` 并取边的 **src**，方向是反的：
   * 新值拿到"版本链环节"的保护，而真正该降档的旧值没有信号。
   * v0.5 改名并取 dst——被取代是最强的降档理由，不是保护理由。
   *
   * 注意：它现在只用于面板解释，不再参与闸门判定（见 protectedFromDeletion）。
   */
  isSuperseded?: boolean
}

export interface RetentionResult {
  score: number
  /** 由分数直接决定的档位（纯函数，不含任何闸门修正） */
  disposition: Disposition
  /** 实际生效的档位：闸门可能把 P1 挡回 P2 */
  effective: Disposition
  /** 各因子原始值（未乘权重），面板画堆叠条用 */
  parts: RetentionInputs
  /** 各因子已乘权重的贡献值 */
  contributions: Record<keyof RetentionInputs, number>
  activationRaw: number
  /** 陈旧包络（0.15..1），已乘进 score */
  stale: number
  /** 命中闸门时返回理由，否则 null */
  protectedBy: string | null
  tier: 0 | 1 | 2 | 3 | 4
  /** 周年加成（已并入 score） */
  anniversary: number
  /** 是否已失效（tInvalid 超过宽限期） */
  invalid: boolean
}

/** 失效宽限期：被取代后仍保留 30 天回溯窗口，之后强制归档。 */
export const INVALID_GRACE_MS = 30 * DAY

/**
 * 六道"永不删除"的闸。
 *
 * ── v0.5 的两处关键修正 ────────────────────────────────────────
 * ① **闸不再改分数，只封顶 tier**。
 *    v0.4 的闸会 `score = max(score, floor)`，而第五道闸的判据是
 *    `trust >= 240 && provenance === 0`——而 `TRUST_BY_PROVENANCE[0]` 恰好就是 240，
 *    于是**对 100% 的用户输入恒真**，七因子评分被整体架空：
 *    实测 10 条用户陈述 10/10 命中，`demoteDue` 移动 0 条。
 *    现在分数永远由公式给出，闸只负责"不许进墓碑"。
 * ② **第五道闸加两个必要条件**：仍是当前有效版本、且被确证或被用过三次以上。
 *    随口说一句的琐事不再受保护，但"用户亲口确认过的事"仍然不会被清掉。
 */
export function protectedFromDeletion(cell: MemCell): string | null {
  if (cell.flags & FLAG.noDecay) return '用户 pin'
  if (cell.flags & FLAG.emotional) return '情感记忆（闪光灯）'
  if (cell.kind === KIND.persona) return '人格锚'
  if (cell.kind === KIND.narrative && cell.flags & FLAG.milestone) return '关系里程碑'
  if (
    cell.trust >= 240 &&
    cell.provenance === 0 &&
    Number(cell.tInvalid ?? 0) === 0 &&
    (cell.support >= 3 || cell.accessCount >= 3)
  ) {
    return '用户亲口确认过的一手事实'
  }
  // 图式（kind=3）是抽象出来的"经验"，只增不减——它没有原文可丢，也就没有墓碑的意义。
  if (cell.kind === KIND.schema) return '图式（只增不减）'
  /**
   * 两道被移出的闸，以及为什么：
   *
   * · **版本链环节**：v0.4 取的是 SUPERSEDES 的 src（新值），方向反了；而且被取代
   *   本来就该是最强的降档理由。现在由 INVALID_GRACE + P2 归档承担。
   * · **仍被其他记忆引用**：墓碑**不删行**，引用不会悬空，所以这道闸没有存在必要；
   *   而它留在原地会让所有被图式引用的情景记忆永远停在归档层，正是"只进不出"的一半。
   *   物理删除仍需用户审批，那道防线在 `forget --hard` 上，不在这里。
   */
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

  const stale = staleFactor(Number(cell.tAccess), ctx.nowMs)
  const anniversary = anniversaryBoost(Number(cell.tFrom), ctx.nowMs)
  // 陈旧包络乘在**原始分**上：它压的是"价值判断"，不是"是否记得"。
  let score = clamp01(retentionScore(parts, w) * stale + anniversary)

  const tInvalid = Number(cell.tInvalid ?? 0)
  const invalid = tInvalid !== 0 && ctx.nowMs - tInvalid > INVALID_GRACE_MS
  const protectedBy = protectedFromDeletion(cell)

  if (invalid) {
    // 失效版本：强制归档，闸不生效（"一手事实"保护的是**当前**陈述，不是历史版本）。
    score = Math.min(score, DISPOSITION_FLOOR.P2 + 0.01)
    return {
      score: round3(score),
      disposition: 'P2',
      effective: 'P2',
      parts,
      contributions,
      activationRaw,
      stale: round3(stale),
      protectedBy: null,
      tier: 3,
      anniversary,
      invalid: true,
    }
  }

  // 情感记忆的逆衰减：高唤醒的闪光灯记忆强行拉回热层（这是唯一的"改分"闸）。
  if (cell.flags & FLAG.emotional && parts.affectIntensity >= 0.7) {
    score = Math.max(score, DISPOSITION_FLOOR.P5 + 0.03)
  }

  const d = disposition(score)
  // 闸门只封顶：允许降到归档（tier 3），但不许进墓碑（tier 4）。
  const effective: Disposition = protectedBy && d === 'P1' ? 'P2' : d
  return {
    score: round3(score),
    disposition: d,
    effective,
    parts,
    contributions,
    activationRaw,
    stale: round3(stale),
    protectedBy,
    tier: tierForDisposition(effective),
    anniversary,
    invalid: false,
  }
}

/** 面板文案：为什么它还在 / 为什么快没了。 */
export function retentionWhy(r: RetentionResult, kindName = '记忆'): string {
  if (r.invalid) return `已失效（被新版本取代）：强制归档，可回溯`
  if (r.protectedBy && r.effective !== r.disposition) {
    return `保留度 ${r.score.toFixed(2)} 已低于墓碑线，但「${r.protectedBy}」：降为归档而不进墓碑`
  }
  if (r.protectedBy) return `${r.protectedBy}：不参与自动清理`
  if (r.effective === 'P5') {
    const top = topFactor(r)
    return `保留度 ${r.score.toFixed(2)}：主要靠${top}`
  }
  if (r.effective === 'P1' || r.effective === 'P2') {
    const weak = weakestFactor(r)
    const stale = r.stale < 0.6 ? '，且长期未被提取（陈旧折损 ' + r.stale.toFixed(2) + '）' : ''
    return `保留度 ${r.score.toFixed(2)}：${weak}偏低${stale}，已降到${DISPOSITION_LABEL[r.effective]}`
  }
  return `${kindName}保留度 ${r.score.toFixed(2)}，处于${DISPOSITION_LABEL[r.effective]}档`
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
