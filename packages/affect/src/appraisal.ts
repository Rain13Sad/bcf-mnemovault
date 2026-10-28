/**
 * 评价 → 核心情感（对应 §11.2 / §11.3）
 *
 * 立场（不可让渡）：这满足"有需要维持的内部状态"，**不满足**"有主观体验"。
 * 所有输出都是状态变量的投影；标签（"焦虑"/"满意"）只在渲染时生成，不入库。
 */

import type { Appraisal, Intero, Pad } from '@bcf/dsh-mnemo-core'

const clamp = (x: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, x))

export interface AppraiseInput {
  text: string
  /** 当前 goal 的关键词/实体；无 goal 时为空数组 */
  goalEntities?: string[]
  /** 本会话已知话题集合，用于 novelty */
  seenTopics?: Set<string>
  topic?: string
  /** 上一条助手消息是否被否定 */
  lastAssistantRejected?: boolean
}

/**
 * 六维评价。规则可解释、可消融、可回归——这是"情感是参数不是台词"的前提（A3）。
 * 它当然不如 LLM 标注细腻，但它的每一次输出都能被指着说"因为这句话里的这个词"。
 */
export function appraise(input: AppraiseInput): Appraisal {
  const t = input.text
  // 陪伴场景的词汇表和"客服场景"完全不同：用户说的是"难受""累""委屈"，
  // 不是"不满意""差评"。这张表是这套系统能不能"听懂情绪"的第一道关。
  const pos = countMatches(
    t,
    // 不保留裸的"好/对/差"：'不好' 里的 '好' 会把否定句算成正向（实测踩过）
    /很好|真好|太好了|好棒|不错|开心|高兴|舒服|轻松|喜欢|爱|暖|安心|踏实|感动|幸福|爽|辛苦了|谢谢|满意|赞|great|thanks|perfect|nice|good|happy|love/gi,
  )
  const neg = countMatches(
    t,
    /不好|不对|错了|糟糕|垃圾|烦|失望|不行|太慢|难受|难过|累|疲惫|委屈|生气|愤怒|焦虑|害怕|孤独|寂寞|崩溃|撑不住|想哭|哭|郁闷|压抑|无助|绝望|心累|头疼|压力|烦死|受不了|算了|没用|做不到|broken|wrong|bad|hate|annoy|tired|sad|angry|lonely|anxious/gi,
  )
  const hedge = countMatches(t, /可能|也许|大概|不确定|好像|maybe|perhaps|not sure|I think/gi)
  const novel = input.topic && input.seenTopics && !input.seenTopics.has(input.topic) ? 1 : 0
  const goalHit = (input.goalEntities ?? []).filter((e) => e && t.toLowerCase().includes(e.toLowerCase())).length
  const goalRel = input.goalEntities?.length ? Math.min(1, 0.4 + goalHit / Math.max(1, input.goalEntities.length)) : 0.35
  const goalCon = clamp((pos - neg) / 3 + (input.lastAssistantRejected ? -0.4 : 0))
  const agency = clamp(0.5 + pos * 0.1 - neg * 0.15)
  const certainty = clamp(0.6 - hedge * 0.15)
  const novelty = clamp(novel * 0.7 + Math.min(1, t.length / 400) * 0.3)
  const norm = countMatches(t, /请|麻烦|谢谢|please|kindly/gi) > 0 ? 0.4 : 0
  // 情绪强度：正负抵消后剩下的"带电程度"，按出现次数饱和。
  // '今天真的很难受' → pos 0 / neg 1 → charge = -0.33，足以把效价推到 -0.5 以下。
  const total = pos + neg
  const charge = total === 0 ? 0 : ((pos - neg) / total) * Math.min(1, total / 3)
  return { goalRel, goalCon, agency, certainty, novelty, norm, charge }
}

/**
 * PAD + 显著度（§11.3 的四个式子，一字未改）。
 * 设计要点：tanh 保证有界且两端饱和；arousal 显式依赖 load（负荷高时同样评价产生更高唤起）；
 * dominance 依赖 uncert（负向）。所有系数可配置、可消融。
 */
export function coreAffect(a: Appraisal, i: Intero, coeff = DEFAULT_COEFF): Pad {
  const c = coeff
  const v = Math.tanh(c.v1 * a.goalRel * a.goalCon + c.v2 * a.novelty * a.goalCon + c.v3 * a.norm + c.v4 * (a.charge ?? 0))
  const ar = Math.tanh(c.a1 * a.novelty + c.a2 * Math.abs(a.goalCon) * a.goalRel + c.a3 * i.load)
  const d = Math.tanh(c.d1 * a.agency + c.d2 * a.certainty - c.d3 * i.uncert)
  const s = Math.tanh(c.s1 * a.goalRel + c.s2 * Math.abs(a.goalCon) + c.s3 * a.novelty)
  return { v, a: ar, d, s: (s + 1) / 2 }
}

export interface AffectCoefficients {
  v1: number
  /** 情绪强度对效价的贡献（陪伴场景的主信号） */
  v4: number
  v2: number
  v3: number
  a1: number
  a2: number
  a3: number
  d1: number
  d2: number
  d3: number
  s1: number
  s2: number
  s3: number
}

export const DEFAULT_COEFF: AffectCoefficients = {
  v1: 1.2,
  v4: 1.1,
  v2: 0.4,
  v3: 0.3,
  a1: 0.8,
  a2: 0.6,
  a3: 0.5,
  d1: 0.7,
  d2: 0.3,
  d3: 0.2,
  s1: 0.9,
  s2: 0.7,
  s3: 0.4,
}

/** 心境积分（§11.4）：m ← m + (e − m)/τ。τ≈20 轮。这层是稳定性来源，没有它 persona 会碎。 */
export function integrateMood(mood: Pad, e: Pad, tau: number): Pad {
  const k = 1 / Math.max(1, tau)
  return {
    v: mood.v + (e.v - mood.v) * k,
    a: mood.a + (e.a - mood.a) * k,
    d: mood.d + (e.d - mood.d) * k,
    s: mood.s + (e.s - mood.s) * k,
  }
}

export function neutralPad(): Pad {
  return { v: 0, a: 0.2, d: 0.5, s: 0.3 }
}

export function neutralIntero(): Intero {
  return { load: 0.2, uncert: 0.2, conflict: 0, strain: 0, progress: 0.5, budget: 0.9 }
}

/**
 * 情绪标签：只在渲染时生成，不入库（§11.2 ④）。
 * 注意措辞：这是"状态描述"，不是"我感到"。§19.3 禁止输出"我感到…"。
 */
export function label(p: Pad): string {
  if (p.v > 0.35 && p.a < 0.4) return '平稳积极'
  if (p.v > 0.2 && p.a >= 0.4) return '投入'
  if (p.v < -0.3 && p.a > 0.55) return '紧张'
  if (p.v < -0.2 && p.a <= 0.55) return '低落'
  if (p.a > 0.7) return '高唤起'
  if (Math.abs(p.v) < 0.15) return '中性'
  return p.v > 0 ? '略积极' : '略消极'
}

/** 人格漂移钳制（§11.8 修 D-13）：只在超界时收缩，绝不放大。 */
export function clampPersona(persona: number[], persona0: number[], eps: number): number[] {
  const d = persona.map((x, i) => x - (persona0[i] ?? 0))
  const n = Math.sqrt(d.reduce((a, b) => a + b * b, 0))
  if (n <= eps) return persona.slice() // 关键：不放大
  const k = eps / n
  return persona0.map((x, i) => x + d[i] * k)
}

function countMatches(text: string, re: RegExp): number {
  const m = text.match(re)
  return m ? m.length : 0
}
