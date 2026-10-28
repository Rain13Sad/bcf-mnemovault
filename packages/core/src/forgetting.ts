/**
 * 遗忘曲线（v0.2 重写，修 D-06，对应 §10.6）
 *
 *   R(t) = (1 + F·t/S)^(−d),  F = 19/81, d = 0.5
 *
 * 构造性质：t = S 时 R = 0.9。所以 S 的语义是"可提取性降到 0.9 所需的天数"。
 * 三档 profile 只改 S₀，不改曲线形状。
 *
 * 艾宾浩斯的 20 分钟数据点**不进这条曲线**——那个量级由 Sensory Ring 的 TTL
 * 与 Working Set 承担，用一条曲线同时拟合 20 分钟与 30 天是方法论错误。
 */

export type ForgettingProfile = 'procedure' | 'semantic' | 'episodic'

export const F_CONST = 19 / 81
export const D_EXP = 0.5

export const S0: Record<ForgettingProfile, number> = {
  procedure: 30,
  semantic: 7,
  episodic: 2,
}

/** 降层阈值。对应 t/S ≈ 30.54。 */
export const DEMOTE_AT = 0.35
/** 30 天未访问也降层——曲线管"想不想得起来"，访问间隔管"还用不用得上"。 */
export const STALE_DAYS = 30

const DAY_MS = 86_400_000

/** R(t)，t 单位天。负 t 视为 0。 */
export function retrievability(tDays: number, stability: number): number {
  const s = Math.max(1e-6, stability)
  const t = Math.max(0, tDays)
  return Math.pow(1 + (F_CONST * t) / s, -D_EXP)
}

/** 便捷：从毫秒时间戳算。 */
export function retrievabilityFrom(tAccessMs: number, stability: number, now = Date.now()): number {
  return retrievability((now - tAccessMs) / DAY_MS, stability)
}

/** 达到 R 所需的天数（解上式），用于解释器展示"还有多久降层"。 */
export function daysToReach(r: number, stability: number): number {
  const s = Math.max(1e-6, stability)
  return (s * (Math.pow(r, -1 / D_EXP) - 1)) / F_CONST
}

/**
 * 复述增益（对应过度学习与间隔效应）：
 *   S' = S · (1 + 0.6·(1 − R)) · spacing_bonus
 *   spacing_bonus = min(2.0, 1 + 0.3·log1p(Δt_prev / S))
 * 两个因子都有上限，防止 S 无限膨胀。
 */
export function reinforce(stability: number, r: number, deltaDaysPrev: number): number {
  const gain = 1 + 0.6 * (1 - clamp01(r))
  const spacing = Math.min(2.0, 1 + 0.3 * Math.log1p(Math.max(0, deltaDaysPrev) / Math.max(1e-6, stability)))
  return Math.min(3650, stability * gain * spacing)
}

/** 是否该降层（温 → 冷）。 */
export function shouldDemote(tAccessMs: number, stability: number, now = Date.now()): boolean {
  if (retrievabilityFrom(tAccessMs, stability, now) < DEMOTE_AT) return true
  return (now - tAccessMs) / DAY_MS > STALE_DAYS
}

/** 是否该归档（冷 → 归档）。比降层更保守：R < 0.12 或 180 天未访问。 */
export function shouldArchive(tAccessMs: number, stability: number, now = Date.now()): boolean {
  if (retrievabilityFrom(tAccessMs, stability, now) < 0.12) return true
  return (now - tAccessMs) / DAY_MS > 180
}

/** 遗忘曲线采样，供诊断视图画曲线（不参与打分）。 */
export function curveSamples(stability: number, days = 90, n = 24): Array<{ d: number; r: number }> {
  const out: Array<{ d: number; r: number }> = []
  for (let i = 0; i <= n; i++) {
    const d = (days * i) / n
    out.push({ d, r: retrievability(d, stability) })
  }
  return out
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}
