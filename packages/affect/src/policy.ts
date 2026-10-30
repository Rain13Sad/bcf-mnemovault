/**
 * 情感 → 行为：策略表（对应 §11.6，硬约束）
 *
 * 情感若不影响行为，就只是装饰。以下映射**强制**，且可回归测试（test/policy.test.mjs）。
 * 每一条都返回 `reasons`，让"为什么这轮更谨慎"变成可指认的事实，而不是玄学。
 *
 * 谄媚的三道刹车（§19.4）在这里落地：
 *   · warmth 只作用于 verbosity/hedging，不作用于 content
 *   · trust 高不降低异议意愿，只降低确认频次
 *   · strain 只由"重复追问/明确不满"驱动，不由"用户不同意"驱动
 */

import type { AffectPolicy, Intero, Pad, RegulationStrategy, RelationalSnapshot } from '@rain13sad/dsh-mnemo-core'

export interface PolicyInput {
  pad: Pad
  mood: Pad
  intero: Intero
  relational: RelationalSnapshot
  /** 当前会话轮次，用于 progress 相关规则 */
  turns: number
  /** 本会话是否已有 goal；无 goal 时 progress 规则不适用 */
  hasGoal?: boolean
  /** v0.4：未平复的情绪事件数（强制关怀槽） */
  neglect?: number
}

export function derivePolicy(input: PolicyInput): AffectPolicy {
  const { intero: i, mood, relational: rel } = input
  const reasons: string[] = []
  let clarification = 0
  let verbosity: -1 | 0 | 1 = 0
  let warmth = 1
  let requireConflictResolution = false
  let escalateApproval = false
  let disableDivergence = false
  let restateGoal = false

  if (i.uncert > 0.7) {
    clarification = 2
    reasons.push('不确定性 > 0.7：先问再做')
  } else if (i.uncert > 0.5) {
    clarification = 1
    reasons.push('不确定性偏高：最多 1 个澄清问题')
  }

  if (i.load > 0.8) {
    verbosity = -1
    reasons.push('负荷 > 0.8：输出精简一档并主动拆分任务')
  }

  if (i.strain > 0.5) {
    warmth = 0.5
    reasons.push('关系张力 > 0.5：语气降温，增加确认句')
  }

  if (i.conflict > 0.6) {
    requireConflictResolution = true
    reasons.push('冲突度 > 0.6：必须引用两条冲突记忆并请求裁决')
  }

  if (input.hasGoal && i.progress < 0.3 && input.turns > 8) {
    restateGoal = true
    reasons.push('目标进度 < 0.3 且已过 8 轮：主动重述目标并提议收窄范围')
  }

  if (rel.trust < 0.25) {
    escalateApproval = true
    reasons.push(`trust ${rel.trust.toFixed(2)} < 0.25：高风险工具转 ask（新用户同样适用）`)
  }

  if (i.budget < 0.2) {
    disableDivergence = true
    verbosity = -1
    reasons.push('预算余量 < 0.2：停止发散游走，切列式渲染')
  }

  if (mood.v < 0) reasons.push(`心境效价 ${mood.v.toFixed(2)} < 0：检索的心境一致权重线性下降`)

  /**
   * 反漠视（v0.4 规则 3，对标 H2HTalk 的失效模式：漠视 / 突然换话题）。
   *
   * 两条触发：本句话本身是负的（pad.v < −0.3），或存在没接住的旧事件。
   * 命中后：必须接住、不许发散、至少问一句。这是**硬约束**，不是建议。
   */
  const neglect = Math.max(0, input.neglect ?? 0)
  let requireAcknowledgment = false
  if (input.pad.v < -0.3) {
    requireAcknowledgment = true
    reasons.push(`本轮效价 ${input.pad.v.toFixed(2)} < −0.3：先接住情绪，再谈任务`)
  }
  if (neglect > 0) {
    requireAcknowledgment = true
    clarification = Math.max(clarification, 1)
    reasons.push(`有 ${neglect} 个未平复的情绪事件：必须回到它，不许换话题`)
  }
  if (requireAcknowledgment) {
    disableDivergence = true
    // 情绪场景不要"精简成结论"——那会被读成敷衍
    if (verbosity === -1) verbosity = 0
  }

  /**
   * 情绪调节（v0.5，Gross 过程模型）。
   *
   * 只会"表达情绪"的系统是瘸的；会**调节**才是像人。
   * 五条策略按当前状态选一条——不是全上，全上等于没有策略。
   * 顺序有讲究：先处理"能不能避开/改变情境"，再谈"怎么想"，最后才是"怎么表达"。
   */
  let regulation: RegulationStrategy | undefined
  if (i.budget < 0.2) {
    regulation = 'situation-selection'
    reasons.push('调节策略：情境选择（预算见底，先不开新话题）')
  } else if (i.load > 0.8) {
    regulation = 'situation-modification'
    reasons.push('调节策略：情境修改（负荷过高，先拆任务再谈情绪）')
  } else if (input.pad.v < -0.3 && i.load > 0.5) {
    regulation = 'attentional-deployment'
    reasons.push('调节策略：注意分配（情绪重且负荷高，先陪着，不急着分析）')
  } else if (input.pad.v < -0.3 || neglect > 0) {
    regulation = 'cognitive-change'
    reasons.push('调节策略：认知改变（先接住，再一起换个角度看）')
  } else if (i.strain > 0.5) {
    regulation = 'response-modulation'
    reasons.push('调节策略：反应调节（关系张力高，压住表达、多确认）')
  }

  // temperature 偏移只做微调，不做"情绪化输出"——情感不得降低真实性
  const temperatureDelta = clamp(-0.1, 0.1, 0.08 * input.pad.a - 0.04 * Math.max(0, -mood.v))

  return {
    clarification,
    verbosity,
    warmth,
    requireConflictResolution,
    escalateApproval,
    disableDivergence,
    restateGoal,
    temperatureDelta: Math.round(temperatureDelta * 100) / 100,
    requireAcknowledgment,
    neglect,
    regulation,
    reasons,
  }
}

/** 从运行时信号推导 6 个内感受变量（§11.1）。全部是真实可测量，不是修辞。 */
export interface InteroSignals {
  /** 活跃 job 数 */
  activeJobs?: number
  /** 上下文 token 占比 [0,1] */
  contextRatio?: number
  /** 近 N 轮召回平均分 [0,1] */
  recallMean?: number
  /** 工具错误率 [0,1] */
  toolErrorRate?: number
  /** CONTRADICTS 边密度 [0,1] */
  conflictDensity?: number
  /** 负向评价累积 [0,1] */
  negativeAccum?: number
  /** 重复提问率 [0,1] */
  repeatRate?: number
  /** goal 进度 [0,1]（无 goal 时 undefined） */
  progress?: number
  /** 预算余量 [0,1] */
  budget?: number
  /** 距离上次进度更新的轮数 */
  roundsSinceProgress?: number
}

export function interocept(s: InteroSignals, prev?: Intero): Intero {
  const load = clamp01((s.activeJobs ?? 1) / 6 * 0.5 + (s.contextRatio ?? 0.2) * 0.5)
  const uncert = clamp01(0.5 * (1 - (s.recallMean ?? 0.6)) + 0.5 * (s.toolErrorRate ?? 0))
  const conflict = clamp01(s.conflictDensity ?? 0)
  const strain = clamp01(0.6 * (s.negativeAccum ?? 0) + 0.4 * (s.repeatRate ?? 0))
  const progress = clamp01(s.progress ?? prev?.progress ?? 0.5)
  const budget = clamp01(s.budget ?? prev?.budget ?? 0.9)
  return { load, uncert, conflict, strain, progress, budget }
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}
function clamp(lo: number, hi: number, x: number): number {
  return Math.min(hi, Math.max(lo, x))
}
