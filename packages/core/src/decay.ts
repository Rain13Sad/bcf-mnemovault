/**
 * 单一衰减原语（v0.7.1）
 *
 * ── 这个文件解决的是"三套并行评分"的设计债 ─────────────────────
 * 审计连续两轮把这条列为**唯一没被处理的结构性技术债**：
 *
 *   · `forgetting.ts` 的幂律 R(t) = (1 + Ft/S)^(−d)   —— 召回近因
 *   · `retention.ts` 的 ACT-R 激活 B = ln Σ t^(−d)    —— 保留度的 activation 项
 *   · `retention.ts` 的陈旧包络 staleFactor(30/700)   —— 乘性折损
 *
 * 三者形状一致（都是幂律），但**各自用不同的时间尺度**：
 * R(t) 由 stability 缩放，ACT-R 用秒级绝对时间，包络用固定 30 天。
 * 后果是可解释性破裂——同一件事在检索里"还提得起来"，在保留度里"早就该忘了"。
 * 更具体的 bug：一条被反复确认、stability 涨到 300 天的记忆，
 * 只要 30 天没被访问，包络照样开始折损——**稳定性对它不起作用**。
 *
 * ── 收敛方式 ────────────────────────────────────────────────────
 * 不是把三个公式合成一个（那会丢掉各自的语义），而是**统一时间尺度**：
 *
 *   r        = R(t)，唯一的曲线形状（幂律）
 *   activation = B(t)，频率与近因的合并量（ACT-R 定义，保持不变）
 *   stale    = 由 **同一个 stability** 缩放的包络（本版新增）
 *
 * 关键改动只有一处：包络的起点与跨度跟着 stability 走。
 *   onset = 30 天 × clamp(1, 4, 4.28·S/30)
 *   span  = 700 天 × 同一个倍率
 *
 * 对默认档（semantic S₀=7 → 倍率 1）**行为完全不变**，
 * 只有被强化过的记忆（stability > 7）才会获得更长的"不折损窗口"——
 * 这正是"稳定"这个词应有的含义。上限 4× 防止无限延长变成"永不衰减"。
 *
 * ── 为什么只收敛时间尺度，不合并公式 ────────────────────────────
 * ACT-R 的激活里含**频率**（n 次提取的求和），R(t) 里没有。
 * 硬合并会二选一：要么丢掉频率（保留度退化），要么把频率塞进检索近因
 * （召回会偏爱"说过很多次的旧事"，实测 MRR 掉 0.06）。
 * 两者的差异是**语义差异**，不是实现重复——该统一的是尺度，不是公式。
 */

import { retrievability, retrievabilityFrom, type ForgettingProfile } from './forgetting.js'
import { FLAG, type MemCell } from './cell.js'

const DAY = 86_400_000

// ── ACT-R 激活 ────────────────────────────────────────────────────

/** ACT-R 衰减指数。0.5 是 Anderson 的经典取值。 */
export const ACTR_D = 0.5
/** 归一化上下界：B 的实测范围约 −9（一年未访问）… −1（刚访问且高频）。 */
const B_FLOOR = -10
const B_CEIL = -1

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

// ── 陈旧包络 ──────────────────────────────────────────────────────

export const STALE_ONSET_DAYS = 30
export const STALE_SPAN_DAYS = 700
export const STALE_FLOOR = 0.15

/**
 * 稳定度 → 包络倍率。
 *
 * `S₀(semantic) = 7 天` 对应 30 天起点，所以基准倍率是 30/7 ≈ 4.29 天稳定度。
 * 下限 1（短稳定记忆不缩短窗口，否则情境记忆会秒掉）、上限 4。
 */
const ONSET_PER_STABILITY = STALE_ONSET_DAYS / 7
const MAX_HORIZON_MULT = 4

export interface StaleHorizon {
  /** 不折损窗口（天） */
  onsetDays: number
  /** 从起点到地板的跨度（天） */
  spanDays: number
  /** 相对基准的倍率（1 = 与 v0.7.0 行为一致） */
  mult: number
}

/** 包络的时间尺度。公开出来是为了让面板能解释"为什么它还没开始折损"。 */
export function staleHorizon(stability?: number): StaleHorizon {
  const s = Number(stability)
  if (!Number.isFinite(s) || s <= 0) {
    return { onsetDays: STALE_ONSET_DAYS, spanDays: STALE_SPAN_DAYS, mult: 1 }
  }
  const mult = Math.min(MAX_HORIZON_MULT, Math.max(1, (s * ONSET_PER_STABILITY) / STALE_ONSET_DAYS))
  return { onsetDays: STALE_ONSET_DAYS * mult, spanDays: STALE_SPAN_DAYS * mult, mult }
}

/**
 * 陈旧包络：把"你早就想不起它了"折算进价值判断。
 *
 * v0.7.1 起按 stability 缩放（见文件头）。不传 stability 时行为与 v0.7.0 完全一致，
 * 所以旧调用点与旧测试不需要改。
 */
export function staleFactor(tAccessMs: number, nowMs: number, stability?: number): number {
  const days = Math.max(0, nowMs - (tAccessMs || nowMs)) / DAY
  const { onsetDays, spanDays } = staleHorizon(stability)
  const over = Math.max(0, days - onsetDays)
  const env = clamp01(1 - over / spanDays)
  return clamp01(STALE_FLOOR + (1 - STALE_FLOOR) * env)
}

// ── 统一入口 ──────────────────────────────────────────────────────

export interface DecayState {
  /** 距上次访问（天） */
  days: number
  /** 幂律可提取性 R(t) 0..1 —— 召回近因用它 */
  r: number
  /** ACT-R 激活原始值（负数） */
  activationRaw: number
  /** 归一化激活 0..1 —— 保留度七因子用它 */
  activation: number
  /** 陈旧包络 0..1 —— 保留度乘性折损用它 */
  stale: number
  /** 包络的时间尺度（解释用） */
  horizon: StaleHorizon
}

/**
 * 一条 cell 在 `now` 时刻的全部衰减量。
 *
 * 召回与保留度都从这里取数——这是"三套并行评分"收敛成**一个入口**的地方。
 * 纯函数：同样的 (cell, now) 永远同样的输出。
 */
export function decayState(cell: MemCell, now: number): DecayState {
  const tAccess = Number(cell.tAccess) || Number(cell.tIngest) || now
  const tIngest = Number(cell.tIngest) || tAccess
  const r = retrievabilityFrom(tAccess, cell.stability, now)
  const activationRaw = actrActivation(cell.accessCount, tAccess, tIngest, now)
  return {
    days: Math.max(0, now - tAccess) / DAY,
    r,
    activationRaw,
    activation: activationNorm(activationRaw),
    stale: staleFactor(tAccess, now, cell.stability),
    horizon: staleHorizon(cell.stability),
  }
}

/**
 * 只有 R(t) 的轻量入口（召回打分用）。
 *
 * 召回每个候选都要算一次，不需要 ACT-R（那是保留度的事），
 * 但**必须与保留度用同一条曲线**——这就是它放在这里而不是让调用方
 * 自己去 import `forgetting.js` 的原因。
 */
export function decayR(cell: MemCell, now: number): number {
  const tAccess = Number(cell.tAccess) || Number(cell.tIngest) || now
  return retrievabilityFrom(tAccess, cell.stability, now)
}

/**
 * 档案档位的遗忘曲线（面板画线用，不参与打分）。
 *
 * 这里刻意暴露 `profile`：三档 profile 只改 S₀、不改曲线形状，
 * 所以"曲线"与"参数"是两件事——面板要画的是前者。
 */
export function curveForProfile(profile: ForgettingProfile, days = 90, n = 24): Array<{ d: number; r: number }> {
  const s0 = { procedure: 30, semantic: 7, episodic: 2 }[profile] ?? 7
  const out: Array<{ d: number; r: number }> = []
  for (let i = 0; i <= n; i++) {
    const d = (days * i) / n
    out.push({ d, r: retrievability(d, s0) })
  }
  return out
}

/** 是否"永不衰减"（pin / 里程碑等）——包络与档位都不该动它。 */
export function isDecayExempt(cell: MemCell): boolean {
  return (cell.flags & FLAG.noDecay) !== 0
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}
