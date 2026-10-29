/**
 * 神经调制四信号（v0.4.0 新增，对应 v0.4 方案 §2.2.4）
 *
 * 四个标量，全部由**已有量**算出来，不新增任何模型调用：
 *
 *   DA  δ      预测误差（新输入与上轮图式/查询的距离）
 *   ACh        新信息密度（新实体 / 全部实体）→ 高则进"编码模式"，抑制联想扩散
 *   NE         唤醒度 → 检索锐度（高唤醒收窄到 top-1，低唤醒发散）
 *   CORT       应激（load + conflict）→ 收窄为 exploit，减少主动澄清
 *
 * ── 为什么要这四个数，而不是再加一堆权重 ────────────────────────
 * 打分公式每加一项都要重新标定 bench 基线，而"全局增益"不需要：
 * 它只改**检索宽度**与**编码初值**，不改候选之间的相对次序。
 * 这是本版本唯一能安全引入类脑机制的位置。
 */

export interface NeuromodInputs {
  /** 预测误差 0..1（可由 reconsolidation.predictionErrorProxy 提供） */
  predictionError?: number
  /** 新实体占比 0..1 */
  novelty?: number
  /** 当前唤醒度 0..1 */
  arousal?: number
  /** 任务负荷 0..1 */
  load?: number
  /** 冲突度 0..1 */
  conflict?: number
}

export interface NeuromodState {
  /** 多巴胺：预测误差 / 新颖性 */
  da: number
  /** 乙酰胆碱：新信息密度 */
  ach: number
  /** 去甲肾上腺素：唤醒 / 突显 */
  ne: number
  /** 皮质醇：应激 */
  cort: number
}

export function neuromodulate(x: NeuromodInputs): NeuromodState {
  const da = clamp01(0.65 * (x.predictionError ?? 0) + 0.35 * (x.novelty ?? 0))
  const ach = clamp01(x.novelty ?? 0)
  const ne = clamp01(x.arousal ?? 0)
  const cort = clamp01(((x.load ?? 0) + (x.conflict ?? 0)) / 2)
  return { da: round3(da), ach: round3(ach), ne: round3(ne), cort: round3(cort) }
}

/** 编码增益：δ 大 → 这一轮的记忆获得更高的 importance 初值（杏仁核门控的等价物）。 */
export function encodingGain(s: NeuromodState): number {
  return round3(clamp(0.85 + 0.45 * s.da + 0.2 * s.ne, 0.85, 1.45))
}

/**
 * 图跳数：高 ACh（新信息多）→ 抑制自联想扩散，少跳；
 * 低 ACh（在检索旧知识）→ 允许更多跳。
 * 高 CORT → 再收窄一档（应激时只走最强通道）。
 */
export function graphHopsFor(s: NeuromodState, base: number): number {
  let hops = base
  if (s.ach > 0.6) hops -= 1
  else if (s.ach < 0.25) hops += 1
  if (s.cort > 0.7) hops -= 1
  return Math.max(1, Math.min(3, Math.round(hops)))
}

/** 检索锐度：返回 softmax 温度。高 NE → 低温（只取最强），低 NE → 高温（发散）。 */
export function retrievalTemperature(s: NeuromodState): number {
  return round3(clamp(1.0 - 0.5 * s.ne + 0.3 * s.cort, 0.45, 1.6))
}

/** 当前处于编码模式还是检索模式（面板显示用）。 */
export function modeOf(s: NeuromodState): 'encode' | 'retrieve' {
  return s.ach >= 0.5 ? 'encode' : 'retrieve'
}

/** 应激下是否应该减少主动澄清（CORT 高时，多问一句只会加压）。 */
export function shouldReduceClarification(s: NeuromodState): boolean {
  return s.cort > 0.7
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0))
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo))
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
