/**
 * 关系模型（对应 §11.5，修 D-12）
 *
 * 三条关键设计，缺一条就会退化成"越聊越谄媚"：
 *   1. 不对称更新：负面权重是正面的 3 倍（信任建立慢、崩塌快）
 *   2. boundaries 只增不减：用户划的边界不能被"后来聊得好"自动撤销
 *   3. attunement 驱动 persona 微调：高 → 更简洁；低 → 更多澄清
 *
 * attunement 的事件来源必须是**可检测的**。v0.1 假设存在 affirmed/corrected 事件
 * 却没定义谁产生——这里用三条启发式，各自带置信度，低置信不更新。
 */

import type { RelationalSnapshot } from '@rain13sad/dsh-mnemo-core'
import { attunementSignal, detectBoundary } from '@rain13sad/dsh-mnemo-core'

export interface RelationalModel extends RelationalSnapshot {
  /** 内部：上次 attunement 更新的轮次，避免同一轮重复计分 */
  lastAttuneTurn: number
}

export function initialRelational(): RelationalModel {
  return { trust: 0, familiarity: 0, attunement: 0.5, boundaries: [], repairDebt: 0, turns: 0, lastAttuneTurn: -1 }
}

export interface RelationalUpdate {
  model: RelationalModel
  delta: { trust: number; attunement: number; repairDebt: number }
  reason: string[]
}

export interface UpdateOptions {
  text: string
  turn: number
  /** 用户是否重复了同一请求（明确纠正的强信号） */
  repeated?: boolean
  /** 承诺兑现（kept）或违背（broken），来自工具执行结果 */
  promise?: 'kept' | 'broken'
  /** 负面权重（默认 3，§11.5） */
  negativeWeight?: number
  /** trust 学习率 η */
  eta?: number
}

export function updateRelational(model: RelationalModel, opts: UpdateOptions): RelationalUpdate {
  const eta = opts.eta ?? 0.02
  const negW = opts.negativeWeight ?? 3
  const reason: string[] = []
  const next: RelationalModel = { ...model, boundaries: [...model.boundaries] }
  const delta = { trust: 0, attunement: 0, repairDebt: 0 }

  next.turns += 1
  // familiarity 单调：1 − exp(−n/40)
  next.familiarity = 1 - Math.exp(-next.turns / 40)

  // ── 边界：只增不减 ──
  const b = detectBoundary(opts.text)
  if (b && !next.boundaries.includes(b)) {
    next.boundaries.push(b)
    reason.push(`新增边界「${b}」`)
  }

  // ── attunement 三条启发式 ──
  const sig = attunementSignal(opts.text)
  if (sig.signal !== 'none' && opts.turn !== model.lastAttuneTurn) {
    const applied =
      sig.signal === 'affirmed'
        ? 0.03
        : sig.signal === 'corrected'
          ? -0.05
          : 0.01
    // 低置信（隐式接受）只在没有更明确信号时生效
    if (sig.confidence >= 0.4) {
      delta.attunement = applied * (sig.confidence >= 0.8 ? 1 : 0.5)
      next.attunement = clamp01(next.attunement + delta.attunement)
      next.lastAttuneTurn = opts.turn
      reason.push(`attunement ${sig.signal}(置信 ${sig.confidence}) ${delta.attunement >= 0 ? '+' : ''}${delta.attunement.toFixed(3)}`)
    }
  }
  if (opts.repeated) {
    delta.attunement -= 0.05
    next.attunement = clamp01(next.attunement - 0.05)
    reason.push('重复同一请求，attunement −0.05')
  }

  // ── trust：承诺兑现 vs 违背，违背权重 3× ──
  if (opts.promise === 'kept') {
    delta.trust = eta
    next.trust = clampSym(next.trust + eta)
    reason.push('承诺兑现，trust +0.02')
  } else if (opts.promise === 'broken') {
    delta.trust = -eta * negW
    next.trust = clampSym(next.trust - eta * negW)
    reason.push(`承诺违背，trust −${(eta * negW).toFixed(2)}`)
  }

  // ── repairDebt：误解 +1，成功修复 −1 ──
  if (sig.signal === 'corrected') {
    delta.repairDebt = 1
    next.repairDebt += 1
  } else if (sig.signal === 'affirmed' && next.repairDebt > 0) {
    delta.repairDebt = -1
    next.repairDebt = Math.max(0, next.repairDebt - 1)
    reason.push('误解已修复，repairDebt −1')
  }

  return { model: next, delta, reason }
}

/**
 * attunement → persona 微调（§11.5 第 3 条）。
 * 高 → 更简洁少解释；低 → 更多澄清与铺垫。返回的是**策略参数**，不是人设文案。
 */
export function personaFromAttunement(attunement: number): { verbosity: -1 | 0 | 1; clarification: number; hedging: number } {
  if (attunement >= 0.7) return { verbosity: -1, clarification: 0, hedging: 0 }
  if (attunement <= 0.35) return { verbosity: 1, clarification: 1, hedging: 0.4 }
  return { verbosity: 0, clarification: 0, hedging: 0.1 }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}
function clampSym(x: number): number {
  return Math.min(1, Math.max(-1, x))
}
