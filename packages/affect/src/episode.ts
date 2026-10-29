/**
 * 情绪事件机（v0.4.0 新增，对应 v0.4 方案 §3.4 / §3.5）
 *
 * ── 要解决的具体失效 ────────────────────────────────────────────
 * v0.3 的 `episodes` 只是一个带半衰期的数组：它记录"这一轮情绪有起伏"，
 * 但**没有任何状态**。于是"用户很难过、我没接住"和"用户很难过、我安慰过了"
 * 在架构上完全一样——两者的强度都按同一条指数曲线衰减。
 * 这就是"漠视"无法被阻止的根本原因：不是模型不想管，是系统里没有"还没管"这个状态。
 *
 * ── 三条硬规则（可断言） ────────────────────────────────────────
 * 1. **未获回应的情绪不衰减**：status=open 时强度只增不减（`decayEpisode`）
 * 2. **开放事件强制进入注入预算**：独立高优先槽，不参与 4±1 竞争（`neglectQueue`）
 * 3. **反漠视**：负效价时策略必须 requireAcknowledgment / 不许发散（policy.ts）
 *
 * ── 边界 ────────────────────────────────────────────────────────
 * `classifyEmotion` 是**纯函数**，不调 LLM。情感逻辑不能被模型随机性污染——
 * 与项目"写入可复现"同一条理由。LLM 只负责上游的 appraisal 提取（可选增强路径）。
 */

import type { Appraisal } from '@rain13sad/dsh-mnemo-core'

const HOUR = 3_600_000

/** OCC 22 类。分四组：事件 / 主体 / 对象 / 关系（陪伴场景特化）。 */
export type EmotionLabel =
  // 事件类
  | 'joy'
  | 'distress'
  | 'hope'
  | 'fear'
  | 'relief'
  | 'disappointment'
  | 'satisfaction'
  | 'regret'
  // 主体类
  | 'pride'
  | 'shame'
  | 'admiration'
  | 'reproach'
  | 'gratitude'
  | 'anger'
  // 对象类
  | 'love'
  | 'hate'
  | 'interest'
  | 'boredom'
  | 'nostalgia'
  // 关系类
  | 'loneliness'
  | 'attunement'
  | 'hurt'
  | 'warmth'

export const EMOTION_LABEL_ZH: Record<EmotionLabel, string> = {
  joy: '喜悦',
  distress: '痛苦',
  hope: '希望',
  fear: '担忧',
  relief: '宽慰',
  disappointment: '失望',
  satisfaction: '满足',
  regret: '懊悔',
  pride: '自豪',
  shame: '羞愧',
  admiration: '钦佩',
  reproach: '责备',
  gratitude: '感激',
  anger: '愤怒',
  love: '喜爱',
  hate: '厌恶',
  interest: '兴趣',
  boredom: '无聊',
  nostalgia: '怀念',
  loneliness: '孤独',
  attunement: '合拍',
  hurt: '受伤',
  warmth: '温暖',
}

export interface EmotionHit {
  label: EmotionLabel
  /** 0..1 */
  intensity: number
}

/**
 * OCC 决策表的一个**可区分子集**。
 *
 * 完整的 OCC 有 22 类，但 6 维评价只能区分其中一部分——把 22 类都硬塞进来，
 * 会出现"同一个 appraisal 同时判出 joy 与 relief"这种自相矛盾的结果。
 * 因此这里只保留**判据互斥**的那些，输出按强度排序取前 3。
 */
export function classifyEmotion(a: Appraisal): EmotionHit[] {
  const con = clamp(a.goalCon, -1, 1)
  const rel = clamp(a.goalRel, -1, 1)
  const cert = clamp01(a.certainty)
  const agency = clamp(a.agency, -1, 1)
  const norm = clamp(a.norm, -1, 1)
  const nov = clamp01(a.novelty)
  const charge = clamp(a.charge ?? 0, -1, 1)
  const out: EmotionHit[] = []
  const add = (label: EmotionLabel, raw: number) => {
    const v = clamp01(raw)
    if (v > 0.08) out.push({ label, intensity: round3(v) })
  }

  // ── 事件类：结果 × 确定性 ──
  if (con > 0.25) {
    if (cert > 0.4) add('satisfaction', con)
    else add('hope', con * (1 - cert))
  }
  if (con < -0.25) {
    if (cert > 0.4) add('distress', -con)
    else add('fear', -con * (1 - cert))
  }
  // 预期不好但结果不错 → 宽慰；预期不错但结果不好 → 失望
  if (con > 0.2 && rel < -0.2) add('relief', con * -rel)
  if (con < -0.2 && rel > 0.2) add('disappointment', -con * rel)

  // ── 主体类：谁做的 × 该不该 ──
  if (agency > 0.4) {
    if (con > 0.2) add('pride', con * agency)
    if (con < -0.2 && norm < 0) add('shame', -con * -norm)
  }
  if (agency < -0.4) {
    if (con > 0.2) {
      add('gratitude', con * -agency)
      add('admiration', con * -agency * 0.8)
    }
    if (con < -0.2) {
      add('reproach', -con * -agency)
      if (norm < -0.3) add('anger', -con * -agency * -norm)
    }
  }

  // ── 对象类：新颖性 × 效价 ──
  if (nov > 0.6 && con >= -0.1) add('interest', nov)
  if (nov < 0.2 && Math.abs(con) < 0.2 && Math.abs(charge) < 0.2) add('boredom', (0.2 - nov) * 2)

  // ── 关系类：这句话本身有多"带电" ──
  if (charge < -0.45) add('hurt', -charge)
  if (charge > 0.45) add('warmth', charge)
  if (charge > 0.3 && Math.abs(con) < 0.2) add('attunement', charge * 0.8)

  // 同标签取最大强度，再按强度排序
  const byLabel = new Map<EmotionLabel, number>()
  for (const h of out) byLabel.set(h.label, Math.max(byLabel.get(h.label) ?? 0, h.intensity))
  return [...byLabel.entries()]
    .map(([label, intensity]) => ({ label, intensity }))
    .sort((x, y) => y.intensity - x.intensity)
    .slice(0, 3)
}

export type EpisodeStatus = 'open' | 'acknowledged' | 'attended' | 'resolved' | 'dormant'

export interface EmotionEpisode {
  id: string
  /** 触发它的原话（截断） */
  trigger: string
  /** 首次出现的时刻 */
  onset: number
  /** 供旧接口兼容的轮次 */
  turn: number
  valence: number
  arousal: number
  /** 峰值强度 0..1 */
  peak: number
  /** 生命周期：open → acknowledged → attended → resolved | dormant */
  status: EpisodeStatus
  /** 我第一次回应它的时刻 */
  acknowledgedAt?: number
  lastMentionedAt?: number
  /** 强度轨迹（最多 40 点） */
  intensityTrace: Array<{ t: number; v: number; a: number; strength: number }>
  /** 衰减阻力：0=随时间自然消退，1=绝不消退 */
  decayResistance: number
  /** 0..1，用户是否表示"过去了" */
  closure: number
  /** 累积的未修复债 */
  repairDebt: number
  linkedCellIds: string[]
  /** 这一轮判出的 OCC 标签（面板展示用） */
  labels?: EmotionHit[]
}

/** 各状态下的衰减时间常数（小时）。open 不衰减，见 decayEpisode。 */
const TAU_HOURS: Record<Exclude<EpisodeStatus, 'open'>, number> = {
  acknowledged: 8,
  attended: 4,
  resolved: 1.5,
  dormant: 36,
}

export interface OpenEpisodeInput {
  id?: string
  trigger: string
  at: number
  turn?: number
  valence: number
  arousal: number
  peak?: number
  labels?: EmotionHit[]
}

export function openEpisode(input: OpenEpisodeInput): EmotionEpisode {
  const v = clamp(input.valence, -1, 1)
  const a = clamp01(input.arousal)
  const peak = clamp01(input.peak ?? Math.max(Math.abs(v), a))
  return {
    id: input.id ?? `ep-${input.at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    trigger: input.trigger.slice(0, 60),
    onset: input.at,
    turn: input.turn ?? 0,
    valence: v,
    arousal: a,
    peak,
    status: 'open',
    intensityTrace: [{ t: input.at, v, a, strength: peak }],
    // 负效价事件更难消退：这是"哄不好"的机制形态，不是 bug
    decayResistance: clamp01(0.35 + 0.5 * Math.max(0, -v)),
    closure: 0,
    repairDebt: 0,
    linkedCellIds: [],
    labels: input.labels,
  }
}

/** 我回应了它（第一句接住）。**这是唯一让强度开始下降的操作。** */
export function acknowledge(e: EmotionEpisode, at: number): EmotionEpisode {
  if (e.status !== 'open') return e
  return { ...e, status: 'acknowledged', acknowledgedAt: at, lastMentionedAt: at }
}

/** 我不仅接住，还做了点什么（追问、给建议、陪着）。 */
export function attend(e: EmotionEpisode, at: number): EmotionEpisode {
  if (e.status === 'resolved' || e.status === 'dormant') return e
  return { ...e, status: 'attended', acknowledgedAt: e.acknowledgedAt ?? at, lastMentionedAt: at }
}

/** 用户表示"过去了" → 结案。closure 记录结得有多干净。 */
export function resolve(e: EmotionEpisode, at: number, closure = 0.8): EmotionEpisode {
  return { ...e, status: 'resolved', closure: clamp01(closure), lastMentionedAt: at }
}

/** 长期无人提及 → 休眠。它不消失，只是不再占高优先槽。 */
export function dormant(e: EmotionEpisode): EmotionEpisode {
  return e.status === 'resolved' ? e : { ...e, status: 'dormant' }
}

/**
 * 强度随时间的变化（规则 1）。
 *
 * **open 状态只增不减**：`peak + 0.05·ln(1+dt/H)`。
 * 这一行就是"不会遗忘"的机制保证——没被接住的情绪，其强度随时间上升。
 * 其余状态按各自 τ 指数衰减，且 `decayResistance` 提供一个 0.85 的地板，
 * 保证"重要的事不会因为过了很久就归零"。
 */
export function decayEpisode(e: EmotionEpisode, now: number): number {
  const dt = Math.max(0, now - (e.lastMentionedAt ?? e.onset))
  if (e.status === 'open') {
    return clamp01(Math.min(1, e.peak + 0.05 * Math.log1p(dt / HOUR)))
  }
  const tau = TAU_HOURS[e.status] * HOUR
  const base = Math.exp(-dt / tau)
  return clamp01(e.peak * (1 - e.decayResistance) * base + e.peak * e.decayResistance * 0.85)
}

/** 事件当前的强度（不修改事件本身）。 */
export function episodeStrength(e: EmotionEpisode, now: number): number {
  return decayEpisode(e, now)
}

/**
 * 规则 2：强制关怀槽的候选。
 *
 * 只看 open / acknowledged，且强度 > 0.25。**不参与 4±1 竞争**——
 * 它占的是独立的一槽，因为"用户还在难过"不是可以排队等的事。
 */
export function neglectQueue(episodes: readonly EmotionEpisode[], now: number, minStrength = 0.25): EmotionEpisode[] {
  return episodes
    .filter((e) => (e.status === 'open' || e.status === 'acknowledged') && decayEpisode(e, now) > minStrength)
    .sort((a, b) => decayEpisode(b, now) - decayEpisode(a, now))
}

/** 渲染成注入行。措辞刻意具体：时间、原话、当时的效价、以及"我没问过"。 */
export function episodeLine(e: EmotionEpisode, now: number): string {
  const days = Math.floor((now - e.onset) / 86_400_000)
  const when = days <= 0 ? '今天' : days === 1 ? '昨天' : `${days} 天前`
  const v = e.valence >= 0 ? `+${e.valence.toFixed(2)}` : e.valence.toFixed(2)
  const asked = e.status === 'open' ? '你一直没问过后来怎样了。' : '你回应过一次，但还没结。'
  return `⚠ 未平复：${when}他说「${e.trigger}」，当时 v=${v}。${asked}`
}

/** 状态机允许的迁移（面板与测试共用，避免两处各写一份）。 */
export const EPISODE_TRANSITIONS: Record<EpisodeStatus, EpisodeStatus[]> = {
  open: ['acknowledged', 'dormant'],
  acknowledged: ['attended', 'resolved', 'dormant'],
  attended: ['resolved', 'dormant'],
  resolved: [],
  dormant: ['acknowledged'],
}

export function canTransition(from: EpisodeStatus, to: EpisodeStatus): boolean {
  return EPISODE_TRANSITIONS[from].includes(to)
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
