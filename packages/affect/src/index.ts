/**
 * @rain13sad/dsh-mnemo-affect —— 情感内核（§11 / §14.2 / §15）
 *
 * 四段管线：interocept → core affect → appraisal×context → label（仅渲染时）
 * 对应 Barrett 四步：身体变化 → 感知 → 结合经验解释 → 情绪出现。
 *
 * 边界（代码注释与对外表述都要守住）：
 *   · 这满足"有需要维持的内部状态"，**不满足**"有主观体验"
 *   · `report()` 返回数值，不返回感受
 *   · 任何"我感到…"的措辞都不在此产生
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { Appraisal, Intero, MemoryService, Pad, RelationalSnapshot } from '@rain13sad/dsh-mnemo-core'
import { neutralIntero } from './appraisal.js'
import { appraise, clampPersona, coreAffect, DEFAULT_COEFF, integrateMood, label, neutralPad, type AffectCoefficients } from './appraisal.js'
import { derivePolicy, interocept, type InteroSignals } from './policy.js'
import { initialRelational, personaFromAttunement, updateRelational, type RelationalModel } from './relational.js'
import {
  acknowledge,
  attend,
  classifyEmotion,
  decayEpisode,
  episodeLine,
  neglectQueue,
  openEpisode,
  resolve as resolveEpisode,
  type EmotionEpisode,
  type EmotionHit,
} from './episode.js'
import {
  deriveUserSchema,
  personaCell,
  readPersisted,
  relationalCell,
  schemaCell,
  type PersonaState,
  type SchemaPattern,
} from './persist.js'

export const name = 'mnemo-affect'
export const inject = ['sessions']

export interface Config {
  moodTau: number
  personaDriftEpsilon: number
  negativeWeight: number
  enabled: boolean
  coeff: AffectCoefficients
}

export const Config: z<Config> = z.object({
  moodTau: z.number().min(5).max(60).default(20).description('心境惯性：τ 越大越稳，越小越跳变'),
  personaDriftEpsilon: z.number().min(0).max(0.5).default(0.25).description('人格漂移上限。只在超界时收缩，绝不放大（修 D-13）'),
  negativeWeight: z.number().min(1).max(6).default(3).description('关系负面权重。调高更保守，是反谄媚手段'),
  enabled: z.boolean().default(true).description('关闭后走降级路径：不做情感门控，也不注入情感状态行'),
  coeff: z.object({
    v1: z.number().default(DEFAULT_COEFF.v1),
    v4: z.number().default(DEFAULT_COEFF.v4),
    v2: z.number().default(DEFAULT_COEFF.v2),
    v3: z.number().default(DEFAULT_COEFF.v3),
    a1: z.number().default(DEFAULT_COEFF.a1),
    a2: z.number().default(DEFAULT_COEFF.a2),
    a3: z.number().default(DEFAULT_COEFF.a3),
    d1: z.number().default(DEFAULT_COEFF.d1),
    d2: z.number().default(DEFAULT_COEFF.d2),
    d3: z.number().default(DEFAULT_COEFF.d3),
    s1: z.number().default(DEFAULT_COEFF.s1),
    s2: z.number().default(DEFAULT_COEFF.s2),
    s3: z.number().default(DEFAULT_COEFF.s3),
  }),
})

export interface TurnInput {
  text: string
  turn: number
  topic?: string
  goalEntities?: string[]
  seenTopics?: Set<string>
  lastAssistantRejected?: boolean
  repeated?: boolean
  promise?: 'kept' | 'broken'
  signals?: InteroSignals
}

export interface TurnOutput {
  appraisal: Appraisal
  pad: Pad
  mood: Pad
  relational: RelationalSnapshot
  policy: ReturnType<typeof derivePolicy>
  intero: Intero
  label: string
}

export class AffectService extends Service {
  config: Config
  private intero: Intero = neutralIntero()
  private pad: Pad = neutralPad()
  private mood: Pad = neutralPad()
  private relational: RelationalModel = initialRelational()
  private persona: number[] = [0.5, 0.5, 0.5, 0.5]
  private persona0: number[] = [0.5, 0.5, 0.5, 0.5]
  private lastTurn: TurnOutput | null = null
  /** 人格版本链（§11.8 可回滚） */
  private personaRev = 0
  private personaHistory: Array<{ rev: number; vector: number[] }> = []
  /** 离线环的原始样本：每轮的 PAD / 张力 / 是否被纠正 */
  private history: Array<{ turn: number; topic: string; pad: Pad; strain: number; corrected: boolean }> = []
  private lastPersistTurn = -99
  private lastSchemaTurn = 0
  private lastSchema: SchemaPattern[] = []
  private seenTopics = new Set<string>()
  /** 情绪事件（一次显著的起伏），带生命周期状态机；供面板画轨迹、供主动聊天挑话题 */
  private episodes: EmotionEpisode[] = []
  /** PAD 轨迹（每轮一个点，上限 240，够画 40 分钟的连续情绪） */
  private trajectory: Array<{ turn: number; v: number; a: number; d: number }> = []
  /** 有情绪波动的轮数，用于依恋度 */
  private emotionalTurns = 0
  private negativeAccum = 0
  private repeats = 0

  constructor(ctx: Context, config: Config) {
    super(ctx, 'affect')
    this.config = config
  }

  /** 当前情绪（本轮），供 recall 做门控与打分。 */
  current(): Pad {
    return this.pad
  }

  currentMood(): Pad {
    return this.mood
  }

  currentIntero(): Intero {
    return this.intero
  }

  relationalSnapshot(): RelationalSnapshot {
    const { trust, familiarity, attunement, boundaries, repairDebt, turns } = this.relational
    return { trust, familiarity, attunement, boundaries: [...boundaries], repairDebt, turns }
  }

  /** 六变量可手动注入（调试用，`/mnemo affect set`）。 */
  setIntero(patch: Partial<Intero>): Intero {
    this.intero = { ...this.intero, ...patch }
    return this.intero
  }

  /** 一轮的完整评价（快环）。 */
  observe(input: TurnInput): TurnOutput {
    if (!this.config.enabled) {
      return {
        appraisal: { goalRel: 0, goalCon: 0, agency: 0, certainty: 0, novelty: 0, norm: 0 },
        pad: neutralPad(),
        mood: this.mood,
        relational: this.relationalSnapshot(),
        policy: derivePolicy({ pad: this.pad, mood: this.mood, intero: this.intero, relational: this.relationalSnapshot(), turns: this.relational.turns, neglect: this.neglectCount() }),
        intero: this.intero,
        label: '已关闭',
      }
    }
    const a = appraise({
      text: input.text,
      goalEntities: input.goalEntities,
      seenTopics: this.seenTopics,
      topic: input.topic,
      lastAssistantRejected: input.lastAssistantRejected,
    })
    this.intero = interocept(
      {
        ...input.signals,
        negativeAccum: this.negativeAccum,
        repeatRate: this.repeats,
      },
      this.intero,
    )
    const e = coreAffect(a, this.intero, this.config.coeff)
    this.pad = e
    this.mood = integrateMood(this.mood, e, this.config.moodTau)
    this.negativeAccum = Math.max(0, this.negativeAccum * 0.85 + (e.v < -0.2 ? 0.15 : 0))
    if (input.repeated) this.repeats = Math.min(1, this.repeats + 0.2)
    else this.repeats = Math.max(0, this.repeats * 0.9)

    const rel = updateRelational(this.relational, {
      text: input.text,
      turn: input.turn,
      repeated: input.repeated,
      promise: input.promise,
      negativeWeight: this.config.negativeWeight,
    })
    this.relational = rel.model

    // persona 微调 + 有界漂移（§11.8）
    const tune = personaFromAttunement(this.relational.attunement)
    this.persona = clampPersona(
      [0.5 + tune.hedging * 0.5, 0.5, 0.5 + (tune.clarification ? 0.1 : 0), 0.5 - tune.hedging * 0.3],
      this.persona0,
      this.config.personaDriftEpsilon,
    )

    if (input.topic) this.seenTopics.add(input.topic)

    const policy = derivePolicy({
      pad: this.pad,
      mood: this.mood,
      intero: this.intero,
      relational: this.relationalSnapshot(),
      turns: this.relational.turns,
      hasGoal: (input.goalEntities?.length ?? 0) > 0,
      neglect: this.neglectCount(),
    })

    this.lastTurn = {
      appraisal: a,
      pad: this.pad,
      mood: this.mood,
      relational: this.relationalSnapshot(),
      policy,
      intero: this.intero,
      label: label(this.pad),
    }

    // 情绪轨迹与事件：这是"情感是动态的"最直接的证据——
    // 面板上那条折线就是它，主动聊天判断"该不该说话"也看它。
    const prev = this.trajectory[this.trajectory.length - 1]
    this.trajectory.push({ turn: input.turn, v: this.pad.v, a: this.pad.a, d: this.pad.d })
    if (this.trajectory.length > 240) this.trajectory.shift()
    if (Math.abs(this.pad.v) >= 0.45) this.emotionalTurns++
    const swing = prev ? Math.abs(this.pad.v - prev.v) : 0
    if (swing > 0.3 || this.pad.a > 0.7) {
      // v0.4：事件带状态机。旧版只是一个带半衰期的记录，无法区分"接住了"与"没接住"。
      this.episodes.push(
        openEpisode({
          trigger: input.text.slice(0, 40),
          at: Date.now(),
          turn: input.turn,
          valence: this.pad.v,
          arousal: this.pad.a,
          labels: classifyEmotion(a),
        }),
      )
      if (this.episodes.length > 40) this.episodes.shift()
    }

    // 离线环的样本：只记"这一轮发生了什么"，不做解释
    if (input.topic) {
      this.history.push({
        turn: input.turn,
        topic: input.topic,
        pad: this.pad,
        strain: this.intero.strain,
        corrected: /不对|错了|不是这个|我说的是/.test(input.text),
      })
      if (this.history.length > 500) this.history.shift()
    }

    // 慢环落盘：每 5 轮写一次关系模型与人格锚（每轮都写会把库刷成日志）
    if (input.turn - this.lastPersistTurn >= 5) {
      this.lastPersistTurn = input.turn
      this.persist()
    }

    // 离线环：每 40 轮抽一次用户图式
    if (input.turn - this.lastSchemaTurn >= 40 && this.history.length >= 12) {
      this.lastSchemaTurn = input.turn
      this.refreshSchema()
    }
    return this.lastTurn
  }

  /** 人格快照（面板与命令用）。 */
  personaState(): PersonaState & { baseline: number[]; history: Array<{ rev: number; vector: number[] }> } {
    return { rev: this.personaRev, vector: [...this.persona], baseline: [...this.persona0], history: this.personaHistory.slice(-10) }
  }

  /** 人格回滚（§11.8）：回滚也算一次新版本，不做原地改写。 */
  rollbackPersona(rev: number): { ok: boolean; message: string } {
    const target = rev === 0 ? { rev: 0, vector: [...this.persona0] } : this.personaHistory.find((h) => h.rev === rev)
    if (!target) return { ok: false, message: `找不到 rev ${rev}` }
    this.persona = [...target.vector]
    this.personaRev += 1
    this.personaHistory.push({ rev: this.personaRev, vector: [...this.persona] })
    this.persist()
    return { ok: true, message: `已回滚到 rev ${rev}（新版本 rev ${this.personaRev}）` }
  }

  /**
   * 依恋度（0..1）：熟悉度 40% + 信任 30% + 共同情绪事件 30%。
   * 刻意不包含"轮数"——刷轮数涨上来的不是依恋，是时长。
   */
  attachment(): number {
    const rel = this.relational
    const shared = Math.min(1, this.emotionalTurns / 20)
    const a = 0.4 * rel.familiarity + 0.3 * Math.max(0, rel.trust) + 0.3 * shared
    return Math.round(a * 1000) / 1000
  }

  /** 关系阶段：陌生 → 熟悉 → 亲密 → 依赖（阈值与面板文案绑定，改要一起改） */
  stage(): { key: 'stranger' | 'familiar' | 'close' | 'attached'; label: string; progress: number } {
    const a = this.attachment()
    if (a < 0.2) return { key: 'stranger', label: '陌生', progress: a / 0.2 }
    if (a < 0.45) return { key: 'familiar', label: '熟悉', progress: (a - 0.2) / 0.25 }
    if (a < 0.7) return { key: 'close', label: '亲密', progress: (a - 0.45) / 0.25 }
    return { key: 'attached', label: '依赖', progress: Math.min(1, (a - 0.7) / 0.3) }
  }

  /** 情绪轨迹（面板画折线用） */
  trajectorySeries(): Array<{ turn: number; v: number; a: number; d: number }> {
    return this.trajectory.slice(-120)
  }

  /** 未平复的情绪事件（峰值 × 状态机强度），供主动聊天判断"他还在气头上吗" */
  activeEpisodes(now = Date.now()): Array<{ turn: number; v: number; a: number; strength: number; trigger: string }> {
    return this.episodes
      .map((e) => ({
        turn: e.turn,
        v: e.valence,
        a: e.arousal,
        strength: decayEpisode(e, now),
        trigger: e.trigger,
      }))
      .filter((e) => e.strength > 0.15)
      .sort((x, y) => y.strength - x.strength)
  }

  /**
   * 完整事件状态（面板"情感状态 → 情绪事件"用）。
   *
   * 与 `activeEpisodes()` 的区别：那个是给主动聊天挑话题的**排序摘要**，
   * 这个是给面板看的**全量状态**——包括 resolved 与 dormant，否则"我处理过它"
   * 这件事在界面上不可见，用户会以为系统忘了。
   */
  episodeStates(now = Date.now()): Array<{
    id: string
    trigger: string
    status: EmotionEpisode['status']
    onset: number
    turn: number
    valence: number
    arousal: number
    peak: number
    strength: number
    decayResistance: number
    closure: number
    repairDebt: number
    labels: EmotionHit[]
  }> {
    return this.episodes
      .map((e) => ({
        id: e.id,
        trigger: e.trigger,
        status: e.status,
        onset: e.onset,
        turn: e.turn,
        valence: e.valence,
        arousal: e.arousal,
        peak: e.peak,
        strength: decayEpisode(e, now),
        decayResistance: e.decayResistance,
        closure: e.closure,
        repairDebt: e.repairDebt,
        labels: e.labels ?? [],
      }))
      .sort((a, b) => b.strength - a.strength)
  }

  /** 规则 2：强制关怀槽的注入行。空数组表示"没有欠着的情绪"。 */
  neglectLines(now = Date.now()): string[] {
    return neglectQueue(this.episodes, now)
      .slice(0, 3)
      .map((e) => episodeLine(e, now))
  }

  /** 我接住了当前最强的那条未平复事件（供宿主/面板调用）。 */
  acknowledgeTop(now = Date.now()): string | null {
    const top = neglectQueue(this.episodes, now)[0]
    if (!top) return null
    const i = this.episodes.findIndex((x) => x.id === top.id)
    if (i < 0) return null
    this.episodes[i] = acknowledge(this.episodes[i], now)
    return top.id
  }

  /** 继续跟进（追问 / 给建议 / 陪着）。 */
  attendTop(now = Date.now()): string | null {
    const top = neglectQueue(this.episodes, now)[0]
    if (!top) return null
    const i = this.episodes.findIndex((x) => x.id === top.id)
    if (i < 0) return null
    this.episodes[i] = attend(this.episodes[i], now)
    return top.id
  }

  /** 用户表示"过去了" → 结案。 */
  resolveEpisode(id: string, now = Date.now()): boolean {
    const i = this.episodes.findIndex((x) => x.id === id)
    if (i < 0) return false
    this.episodes[i] = resolveEpisode(this.episodes[i], now)
    return true
  }

  /**
   * 情感再评估（reappraisal）：用**当前心境**重估一条记忆的效价。
   * 记忆是建构性的——同一件事，心情好的时候想起来没那么糟。
   * 只调 valence（情感维度），不动内容、不动 support（证据数不是情绪）。
   */
  reappraise(cellId: string): { ok: boolean; before: number; after: number; message: string } {
    const memory = this.ctx.get('memory') as MemoryService | undefined
    if (!memory) return { ok: false, before: 0, after: 0, message: '记忆服务未就绪' }
    const id = BigInt('0x' + cellId.replace(/^0x/, '').padStart(16, '0'))
    const cell = memory.store.getCell(id)
    if (!cell) return { ok: false, before: 0, after: 0, message: 'cell 不存在' }
    const before = cell.valence
    // 0.6 保留原值 + 0.4 受当前心境影响：一次重估不会翻脸
    cell.valence = Math.max(-1, Math.min(1, before * 0.6 + this.mood.v * 0.4))
    cell.salience = Math.min(1, cell.salience * 0.95 + 0.05)
    memory.store.putCell(cell)
    memory.publishPanel()
    return {
      ok: true,
      before,
      after: cell.valence,
      message: `效价 ${before.toFixed(2)} → ${cell.valence.toFixed(2)}（心境 ${this.mood.v.toFixed(2)}）`,
    }
  }

  /** 当前用户图式（离线环产物）。 */
  schema(): SchemaPattern[] {
    return this.lastSchema.slice()
  }

  /** 慢环落盘：关系模型 + 人格锚。失败不影响情感计算。 */
  persist(): void {
    const memory = this.ctx.get('memory') as MemoryService | undefined
    if (!memory) return
    const now = Date.now()
    try {
      this.personaRev += 1
      this.personaHistory.push({ rev: this.personaRev, vector: [...this.persona] })
      if (this.personaHistory.length > 50) this.personaHistory.shift()
      // 元数据用 upsert 而不是 ingest：人格锚/关系模型是可变状态，
      // 每轮数值在变但"用户是谁"没有第二个版本，不该产出 CONTRADICTS 边或新行。
      memory.upsertMeta('relational', relationalCell(memory, this.relationalSnapshot(), { rev: this.personaRev, vector: this.persona }, now))
      memory.upsertMeta('persona', personaCell(memory, { rev: this.personaRev, vector: this.persona }, now))
    } catch {
      // 落盘失败不能影响本轮情感输出：这是"降级"而不是"故障"
    }
  }

  /** 离线环：抽图式并写 kind=3 cell。 */
  refreshSchema(): SchemaPattern[] {
    const patterns = deriveUserSchema(this.history)
    this.lastSchema = patterns
    const memory = this.ctx.get('memory') as MemoryService | undefined
    if (!memory) return patterns
    for (const p of patterns) {
      try {
        memory.upsertMeta('schema:' + p.topic, schemaCell(memory, p, Date.now()))
      } catch {
        /* 单条失败不影响其它 */
      }
    }
    return patterns
  }

  /** 热重载 / 重启后从库恢复（§14.7 可重建内存缓存）。 */
  restoreFromMemory(): boolean {
    const memory = this.ctx.get('memory') as MemoryService | undefined
    if (!memory) return false
    const saved = readPersisted(memory)
    if (saved.relational) this.relational = { ...this.relational, ...saved.relational, lastAttuneTurn: -1 }
    if (saved.persona) {
      this.persona = saved.persona.vector.slice(0, 4)
      this.personaRev = saved.persona.rev
    }
    return Boolean(saved.relational || saved.persona)
  }

  /** 未平复事件数（策略与面板共用同一口径，避免两处各算一遍）。 */
  neglectCount(now = Date.now()): number {
    return neglectQueue(this.episodes, now).length
  }

  policy(): TurnOutput['policy'] {
    return derivePolicy({
      pad: this.pad,
      mood: this.mood,
      intero: this.intero,
      relational: this.relationalSnapshot(),
      turns: this.relational.turns,
      neglect: this.neglectCount(),
    })
  }

  /** affect_report 的数据源：**只有数值**，没有感受。 */
  report(): Record<string, number | string> {
    const p = this.pad
    return {
      intero_load: round(this.intero.load),
      intero_uncert: round(this.intero.uncert),
      intero_conflict: round(this.intero.conflict),
      intero_strain: round(this.intero.strain),
      intero_progress: round(this.intero.progress),
      intero_budget: round(this.intero.budget),
      pad_valence: round(p.v),
      pad_arousal: round(p.a),
      pad_dominance: round(p.d),
      pad_salience: round(p.s),
      mood_valence: round(this.mood.v),
      trust: round(this.relational.trust),
      familiarity: round(this.relational.familiarity),
      attunement: round(this.relational.attunement),
      repair_debt: this.relational.repairDebt,
      boundaries: this.relational.boundaries.join(';'),
      label: label(p),
      disclaimer: '这些是内部状态数值，不是主观体验，也不代表拥有情绪。',
    }
  }

  /** 面板需要、但不属于"本轮评价结果"的部分。 */
  snapshotExtras(): {
    persona: { rev: number; vector: number[]; baseline: number[] }
    schema: SchemaPattern[]
    attachment: number
    stage: { key: string; label: string; progress: number }
    trajectory: Array<{ turn: number; v: number; a: number; d: number }>
    episodes: Array<{ turn: number; v: number; a: number; strength: number; trigger: string }>
    /** v0.4：事件状态机全量（含已结案/休眠） */
    episodeDetail: ReturnType<AffectService['episodeStates']>
    /** v0.4：强制关怀槽的注入行 */
    neglect: string[]
    /** v0.4：本轮 OCC 标签 */
    labels: EmotionHit[]
  } {
    return {
      persona: { rev: this.personaRev, vector: [...this.persona], baseline: [...this.persona0] },
      schema: this.lastSchema.slice(),
      attachment: this.attachment(),
      stage: this.stage(),
      trajectory: this.trajectorySeries(),
      episodes: this.activeEpisodes(),
      episodeDetail: this.episodeStates(),
      neglect: this.neglectLines(),
      labels: this.lastTurn ? classifyEmotion(this.lastTurn.appraisal) : [],
    }
  }

  /** 供面板消费的快照。 */
  snapshot() {
    return {
      enabled: this.config.enabled,
      intero: this.intero,
      pad: this.pad,
      mood: this.mood,
      relational: this.relationalSnapshot(),
      policy: this.policy(),
      ...this.snapshotExtras(),
    }
  }

  last(): TurnOutput | null {
    return this.lastTurn
  }

  /** 恢复（热重载后从 kind=5 / kind=4 cell 重建，§14.7 可重建内存缓存）。 */
  restore(rel: Partial<RelationalSnapshot>, mood?: Pad): void {
    this.relational = { ...this.relational, ...rel, boundaries: rel.boundaries ? [...rel.boundaries] : this.relational.boundaries }
    if (mood) this.mood = mood
  }
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}

export function apply(ctx: Context, config: Config) {
  const affect = new AffectService(ctx, config)
  // 启动即尝试恢复：热重载后不该从"陌生人"重新开始
  try {
    affect.restoreFromMemory()
  } catch {
    /* 库还没准备好时忽略，下一轮会再写 */
  }
  /** 按会话累积本轮用户文本，在 turn/end 一次性评价——逐条评价会让 mood 抖成噪声。 */
  const pending = new Map<string, { text: string[]; turn: number; lastText?: string }>()

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const sid = String((session as { id?: string })?.id ?? 'default')
      const type = String((event as { type?: string }).type ?? '')
      const turn = Number((event as { turn?: number }).turn ?? 0)
      if (type === 'user/message') {
        const cur = pending.get(sid) ?? { text: [], turn }
        const content = (event as { content?: unknown }).content
        const txt = Array.isArray(content)
          ? content.map((b) => String((b as { text?: string })?.text ?? '')).join(' / ')
          : String(content ?? '')
        if (txt.trim()) cur.text.push(txt)
        cur.turn = turn
        pending.set(sid, cur)
      }
      if (type === 'turn/end') {
        const cur = pending.get(sid)
        pending.delete(sid)
        if (!cur || cur.text.length === 0) return
        const text = cur.text.join(' / ')
        const repeated = cur.lastText === text
        const out = affect.observe({ text, turn: cur.turn || turn, repeated, topic: text.slice(0, 24) })
        const memory = ctx.get('memory') as { setAffectState?: (s: unknown) => void } | undefined
        memory?.setAffectState?.({
          enabled: config.enabled,
          intero: out.intero,
          pad: out.pad,
          mood: out.mood,
          relational: out.relational,
          policy: out.policy,
          // persona/schema 从服务实例取（这里在闭包里，this 不是服务实例）
          ...affect.snapshotExtras(),
        })
        pending.set(sid, { text: [], turn: cur.turn, lastText: text })
      }
    })
    return () => {
      off()
      pending.clear()
    }
  }, 'mnemo-affect: turn evaluation')
  ctx.logger('mnemo-affect').info(`affect ready (enabled=${config.enabled}, tau=${config.moodTau})`)
  // 情感服务本身无副作用资源；定时器与持久化由 core/consolidator 持有，
  // 这样卸载 affect 时不会留下孤儿 timer（§14.7）。
  return affect
}

export { appraise, coreAffect, integrateMood, label, clampPersona } from './appraisal.js'
export { deriveUserSchema, readPersisted, relationalCell, personaCell, schemaCell } from './persist.js'
export type { PersonaState, SchemaPattern } from './persist.js'
export { derivePolicy, interocept } from './policy.js'
export * from './episode.js'
export { updateRelational, personaFromAttunement, initialRelational } from './relational.js'
