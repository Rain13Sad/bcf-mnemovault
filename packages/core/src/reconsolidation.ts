/**
 * 再巩固（v0.4.0 新增，对应 v0.4 方案 §1.2）
 *
 * 真实记忆不是"编码 → 巩固 → 遗忘"的单向流水线：**每次提取都会让它重新可塑**
 * （destabilization），随后再稳定下来（restabilization）。这解释了两件现有架构解释不了的事：
 *   · 为什么越聊越深——被反复提取的记忆稳定性单调上升（测试效应）；
 *   · 为什么会被带偏——提取时若有大的预测误差，记忆内容会被改写（confidence 下降）。
 *
 * 三条规则都来自记忆原理那份材料：
 *   1. 测试效应：提取即强化（`reinforce` 已有，这里接入）
 *   2. 可塑性：预测误差 > 0.4 → 记忆变软，confidence 降、support 计数由上层加
 *   3. 心境一致性：当前心境与记忆效价同向时，效价被轻微放大（`1−|v|` 保证不越界）
 * 另加一条"硬化"：反复提取且从未出错的记忆逐渐不可塑，防止每次都被改写。
 */

import { FLAG, type MemCell } from './cell.js'
import { reinforce, retrievabilityFrom } from './forgetting.js'

const DAY = 86_400_000

export interface ReconsolidationContext {
  /** 这次被召回的分数（0..1） */
  retrievalStrength: number
  /** 用户后续反应与预期的偏差（0..1）。0 = 没有新信息，>0.4 = 被纠正/意外 */
  predictionError?: number
  /** 当前心境与记忆效价的一致性（−1..1）。同号为正 */
  moodCongruence?: number
  nowMs: number
}

export interface ReconsolidationDelta {
  /** 稳定性增量（天） */
  dStability: number
  /** 置信度增量 */
  dConfidence: number
  /** 效价增量 */
  dValence: number
  /** 本次是否进入可塑窗口 */
  plastic: boolean
  /** 可塑系数：越常被提取越小（记忆硬化） */
  labile: number
  notes: string[]
}

/**
 * 计算一条被召回记忆的再巩固增量。**纯函数**：不写库、不改入参。
 *
 * 为什么必须纯：再巩固会改 confidence 与 valence，这是"记忆被改写"的唯一入口。
 * 一旦它掺进随机性或隐式状态，"同一次重放得到同一条记忆"就不成立了。
 */
export function onRetrieved(cell: MemCell, ctx: ReconsolidationContext): ReconsolidationDelta {
  const notes: string[] = []
  const now = ctx.nowMs
  const dtDays = (now - Number(cell.tAccess)) / DAY
  const R = retrievabilityFrom(Number(cell.tAccess), cell.stability, now)
  const nextS = reinforce(cell.stability, R, dtDays)
  let dStability = nextS - cell.stability

  // 情感记忆的逆衰减：每次被提及 ×1.35（普通记忆由 reinforce 的 1+0.6(1−R) 承担）
  if (cell.flags & FLAG.emotional) {
    dStability *= 1.12
    notes.push('情感记忆：提取增益 ×1.12')
  }

  const predErr = clamp01(ctx.predictionError ?? 0)
  const plastic = predErr > 0.4
  // 硬化：提取次数越多，越不容易被再次改写。下限 0.05，避免"老记忆永远不能更新"。
  const labile = Math.max(0.05, 1 / (1 + Math.log1p(Math.max(0, cell.accessCount))))
  const dConfidence = (plastic ? -0.08 * predErr : 0.02) * labile
  const congruence = clamp(ctx.moodCongruence ?? 0, -1, 1)
  const dValence = 0.05 * congruence * (1 - Math.abs(cell.valence)) * labile

  if (plastic) notes.push(`预测误差 ${predErr.toFixed(2)}：记忆进入可塑窗口`)
  if (Math.abs(congruence) > 0.3) notes.push(`心境一致性 ${congruence.toFixed(2)}：效价被轻微改写`)

  return {
    dStability: round4(dStability),
    dConfidence: round4(dConfidence),
    dValence: round4(dValence),
    plastic,
    labile: round4(labile),
    notes,
  }
}

/** 把增量应用到 cell（原地修改，由调用方负责落库）。 */
export function applyReconsolidation(cell: MemCell, d: ReconsolidationDelta, nowMs: number): MemCell {
  cell.stability = clamp(cell.stability + d.dStability, 0, 3650)
  cell.confidence = clamp01(cell.confidence + d.dConfidence)
  cell.valence = clamp(cell.valence + d.dValence, -1, 1)
  cell.tAccess = BigInt(nowMs)
  cell.accessCount += 1
  return cell
}

/**
 * 预测误差的廉价近似：新查询与"上一条被召回记忆"的语义距离。
 *
 * 这不是真正的"用户反应偏差"——那需要宿主把用户下一句的语义反馈回传。
 * 在没有该信号时，用查询间距离作代理，并**在文档里标明这是代理量**，
 * 而不是把它说成预测误差本身。
 */
export function predictionErrorProxy(prevQueryEmb: Int8Array | null, currQueryEmb: Int8Array | null): number {
  if (!prevQueryEmb || !currQueryEmb || prevQueryEmb.length !== currQueryEmb.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < prevQueryEmb.length; i++) {
    dot += prevQueryEmb[i] * currQueryEmb[i]
    na += prevQueryEmb[i] * prevQueryEmb[i]
    nb += currQueryEmb[i] * currQueryEmb[i]
  }
  if (na === 0 || nb === 0) return 0
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb))
  return clamp01((1 - cos) / 2)
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0))
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo))
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000
}
