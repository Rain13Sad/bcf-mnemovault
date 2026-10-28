/**
 * @bcf/dsh-mnemo-proactive —— 主动开口
 *
 * 陪伴类产品最缺的不是"记得住"，是"会先开口"。但主动说话是最容易变成骚扰的功能，
 * 所以这个包的一半代码在处理**不该说话的时候不说话**：
 *
 *   静默时段（默认 23:00–08:00）
 *   最小间隔（默认 45 分钟）
 *   每日上限（默认 3 次）
 *   用户划的边界（关系模型里的 boundaries 命中"别烦/安静/不要打扰" → 永久静音，需手动解除）
 *   情绪未平复时不打扰（负向 episode 强度 > 0.5 时只允许"轻问一句"）
 *
 * 另一半才是"说什么"：从情感记忆、里程碑、联想链里挑一个**具体的**由头，
 * 生成给模型的提示（不是台词）。台词由模型自己说，才有它的口气——
 * 这一点是参考 dsh-remembers 的做法后确认的：注入提示让模型自己开口，
 * 比插件拼一句模板话术自然得多。
 *
 * ⚠ 接缝：真正的"模型先说话"需要宿主提供 steering / inbox 接口。
 * 本包负责决策与内容，把候选通过 `mnemo/proactive` 事件与 `ctx.mnemoProactive` 服务暴露；
 * 宿主拿到后调用自己的开口通道。没有该通道时，候选会在用户下次说话时以 notice 形式注入
 * （降级，不是静默失败）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  FLAG,
  KIND,
  toHex,
  type MemoryService,
  type Pad,
} from '@bcf/dsh-mnemo-core'

export const name = 'mnemo-proactive'
export const inject = ['memory', 'sessions']

export interface Config {
  enabled: boolean
  /** 两次主动之间的最小间隔（分钟） */
  minIntervalMin: number
  /** 每日上限 */
  maxPerDay: number
  /** 静默时段（本地小时，含 start 不含 end；start > end 表示跨夜） */
  quietStart: number
  quietEnd: number
  /** 用户空闲多少分钟后才考虑开口 */
  idleMin: number
  /** 是否需要情感/记忆由头（false = 允许单纯"好久没聊了"） */
  requireReason: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('总开关。关掉后只在面板里手动触发'),
  minIntervalMin: z.number().min(10).max(720).default(45).description('两次主动之间的最小间隔（分钟）'),
  maxPerDay: z.number().min(1).max(12).default(3).description('每日上限。超过就不再主动'),
  quietStart: z.number().min(0).max(23).default(23).description('静默开始（小时）'),
  quietEnd: z.number().min(0).max(23).default(8).description('静默结束（小时）'),
  idleMin: z.number().min(5).max(1440).default(90).description('用户空闲多久后才考虑开口'),
  requireReason: z.boolean().default(true).description('必须有情感/记忆由头，否则只允许"好久没聊"'),
})

export type ProactiveKind = 'emotion' | 'milestone' | 'associate' | 'memory' | 'silence'

export interface ProactiveCandidate {
  /** 给模型的提示（不是台词） */
  text: string
  /** 一句话说明为什么是现在 */
  reason: string
  kind: ProactiveKind
  /** 相关记忆（面板可点开） */
  cellIds: string[]
  /** 0..1，越高越"该说" */
  urgency: number
}

export interface ProactiveState {
  lastAt: number
  lastDay: string
  todayCount: number
  mutedUntil: number
  lastUserAt: number
  /** 最近一次候选，供面板预览 */
  lastCandidate: ProactiveCandidate | null
  /** 最近 N 次为什么没说 */
  skipped: Array<{ at: number; reason: string }>
}

const DAY = 86_400_000

export class ProactiveService {
  config: Config
  private state: ProactiveState = {
    lastAt: 0,
    lastDay: '',
    todayCount: 0,
    mutedUntil: 0,
    lastUserAt: 0,
    lastCandidate: null,
    skipped: [],
  }

  constructor(
    private readonly ctx: Context,
    private readonly memory: MemoryService,
    config: Config,
  ) {
    this.config = config
  }

  /** 记一次用户发言：空闲时长与"刚聊完别插嘴"都靠它 */
  noteUserActivity(now = Date.now()): void {
    this.state.lastUserAt = now
  }

  /** 用户划的边界命中静音词 → 立即静音（需手动解除，符合"boundaries 只增不减"） */
  muteFor(ms: number, now = Date.now()): void {
    this.state.mutedUntil = now + ms
  }
  unmute(): void {
    this.state.mutedUntil = 0
  }

  private dayKey(now: number): string {
    return new Date(now).toISOString().slice(0, 10)
  }

  /** 现在能不能说话。返回 null 表示可以，否则返回原因。 */
  private blockedBy(now: number): string | null {
    if (!this.config.enabled) return '总开关关闭'
    if (now < this.state.mutedUntil) return `已静音至 ${new Date(this.state.mutedUntil).toLocaleTimeString()}`
    const h = new Date(now).getHours()
    const { quietStart: qs, quietEnd: qe } = this.config
    const inQuiet = qs <= qe ? h >= qs && h < qe : h >= qs || h < qe
    if (inQuiet) return `静默时段 ${qs}:00–${qe}:00`
    if (this.state.lastDay !== this.dayKey(now)) {
      this.state.lastDay = this.dayKey(now)
      this.state.todayCount = 0
    }
    if (this.state.todayCount >= this.config.maxPerDay) return `今日已达上限 ${this.config.maxPerDay} 次`
    if (this.state.lastAt && now - this.state.lastAt < this.config.minIntervalMin * 60_000) {
      const left = Math.ceil((this.config.minIntervalMin * 60_000 - (now - this.state.lastAt)) / 60_000)
      return `距上次主动还有 ${left} 分钟`
    }
    if (this.state.lastUserAt && now - this.state.lastUserAt < this.config.idleMin * 60_000) {
      const left = Math.ceil((this.config.idleMin * 60_000 - (now - this.state.lastUserAt)) / 60_000)
      return `用户刚说过话，再等 ${left} 分钟`
    }
    return null
  }

  /**
   * 挑一个由头。优先级：未平复的情绪 > 里程碑 > 联想链 > 高显著度旧记忆 > 单纯问候。
   * 每条都带"具体的锚点"——泛泛的"最近怎么样"是骚扰，提到具体的事才是关心。
   */
  candidate(now = Date.now(), opts: { ignoreSchedule?: boolean } = {}): ProactiveCandidate | null {
    const block = opts.ignoreSchedule ? null : this.blockedBy(now)
    if (block) {
      this.state.skipped.push({ at: now, reason: block })
      if (this.state.skipped.length > 20) this.state.skipped.shift()
      return null
    }

    const affect = this.ctx.get('affect') as
      | {
          activeEpisodes?(t?: number): Array<{ turn: number; v: number; a: number; strength: number; trigger: string }>
          stage?(): { label: string }
          attachment?(): number
        }
      | undefined

    const out = this.pickByEmotion(affect, now) ?? this.pickMilestone(now) ?? this.pickAssociate(now) ?? this.pickMemory(now)
    const final = out ?? (this.config.requireReason ? null : this.pickSilence(now))
    if (!final) {
      this.state.skipped.push({ at: now, reason: '没有值得提的由头' })
      if (this.state.skipped.length > 20) this.state.skipped.shift()
      return null
    }
    this.state.lastCandidate = final
    return final
  }

  /** 真正"说出口"：记账 + 发事件。宿主负责把 text 变成一次模型开口。 */
  fire(c: ProactiveCandidate, now = Date.now()): void {
    this.state.lastAt = now
    this.state.todayCount++
    this.state.lastCandidate = c
    this.memory.emit('mnemo/proactive', {
      kind: c.kind,
      text: c.text,
      reason: c.reason,
      cellIds: c.cellIds,
      urgency: c.urgency,
      at: now,
    })
  }

  /** 定时器每分钟问一次"现在能不能说"；能说就发事件（由宿主决定是否真的开口）。 */
  tick(now = Date.now()): ProactiveCandidate | null {
    const c = this.candidate(now)
    if (c && c.urgency >= 0.45) {
      this.fire(c, now)
      return c
    }
    return null
  }

  snapshot(): ProactiveState & { blocked: string | null; nextEligibleAt: number } {
    const now = Date.now()
    const block = this.blockedBy(now)
    return {
      ...this.state,
      blocked: block,
      nextEligibleAt: Math.max(this.state.lastAt + this.config.minIntervalMin * 60_000, this.state.mutedUntil),
    }
  }

  // ── 由头 ────────────────────────────────────────────────────────

  /** 未平复的情绪：他上次很烦，隔了一阵还没提过 → 轻轻问一句 */
  private pickByEmotion(affect: Parameters<typeof this.ctx.get>[0] extends never ? never : any, now: number): ProactiveCandidate | null {
    const eps = affect?.activeEpisodes?.(now) as
      | Array<{ turn: number; v: number; a: number; strength: number; trigger: string }>
      | undefined
    if (!eps || eps.length === 0) return null
    const top = eps[0]
    if (top.strength < 0.35) return null
    const negative = top.v < 0
    const ageH = Math.round((now - this.state.lastUserAt) / 3600_000)
    return {
      text: negative
        ? `（主动）他上次的情绪还没完全过去（约 ${ageH} 小时前：「${top.trigger}」）。可以轻轻问一句那件事后来怎么样了，一两句就够，别说教、别追问细节。`
        : `（主动）他上次聊得很起劲（约 ${ageH} 小时前：「${top.trigger}」）。可以顺着那件事问一句进展，语气轻松些。`,
      reason: `未平复的情绪事件（强度 ${top.strength.toFixed(2)}）`,
      kind: 'emotion',
      cellIds: [],
      urgency: Math.min(1, 0.4 + top.strength * 0.6),
    }
  }

  /** 里程碑：7 天内的叙事节点，且用户还没提过 */
  private pickMilestone(now: number): ProactiveCandidate | null {
    const cells = this.memory.store.listCells({ kind: KIND.narrative, limit: 5, order: 'recent' })
    const fresh = cells.find((c) => now - Number(c.tFrom) < 7 * DAY && (c.flags & FLAG.milestone) !== 0)
    if (!fresh) return null
    return {
      text: `（主动）你们之间有一段值得回看的日子：「${fresh.digest ?? ''}」。可以提一句那时候的事，看他还记不记得。`,
      reason: '近期的关系里程碑',
      kind: 'milestone',
      cellIds: [toHex(fresh.cellId, 16)],
      urgency: 0.6,
    }
  }

  /** 联想链：从最重要的一条记忆出发，挑一个"你可能会想到"的邻居 */
  private pickAssociate(now: number): ProactiveCandidate | null {
    const top = this.memory.store.listCells({ limit: 1, order: 'recent' })
    const seed = top[0]
    if (!seed) return null
    const chain = this.memory.associate(seed.cellId, { depth: 2, limit: 6 })
    const pick = chain.find((x) => x.score > 0.2 && x.digest)
    if (!pick) return null
    return {
      text: `（主动）你想起了「${seed.digest ?? ''}」，它和「${pick.digest}」有关。可以自然地带一句这个联想，像人聊天时突然想起来那样。`,
      reason: '联想链',
      kind: 'associate',
      cellIds: [toHex(seed.cellId, 16), pick.cellId],
      urgency: 0.5,
    }
  }

  /** 高显著度的旧记忆：3 天以上没提过，但当时很重要 */
  private pickMemory(now: number): ProactiveCandidate | null {
    const cells = this.memory.store
      .listCells({ limit: 40, order: 'recent' })
      .filter((c) => c.kind !== KIND.narrative && c.salience >= 0.6 && now - Number(c.tFrom) > 3 * DAY)
    if (cells.length === 0) return null
    const pick = cells[Math.floor(Math.random() * Math.min(3, cells.length))]
    return {
      text: `（主动）有一件旧事你可能还记得：「${pick.digest ?? ''}」。可以问问后来怎么样了，或者提一句你一直记着。`,
      reason: '高显著度旧记忆',
      kind: 'memory',
      cellIds: [toHex(pick.cellId, 16)],
      urgency: 0.42,
    }
  }

  /** 没有由头时：只允许一句轻问候（requireReason=false 才走到这里） */
  private pickSilence(now: number): ProactiveCandidate {
    const h = Math.round((now - this.state.lastUserAt) / 3600_000)
    return {
      text: `（主动）他已经 ${h} 小时没说话了。可以简单打个招呼，不要追问、不要长篇。`,
      reason: '长时间无互动',
      kind: 'silence',
      cellIds: [],
      urgency: 0.3,
    }
  }
}

export function apply(ctx: Context, config: Config) {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) throw new Error('[mnemo-proactive] 需要 ctx.memory')
  const service = new ProactiveService(ctx, memory, config)
  ;(ctx as unknown as { provide(n: string, v: unknown): unknown }).provide?.('mnemoProactive', service)

  // 记录用户活动（空闲判定）
  ctx.effect(() => {
    const off = ctx.on('session/event', (_session, event) => {
      const type = String((event as { type?: string })?.type ?? '')
      if (type === 'user/message') service.noteUserActivity()
    })
    return () => off()
  }, 'mnemo-proactive: activity tracking')

  // 每分钟问一次"现在能不能说"
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        service.tick()
      } catch {
        /* 主动发言失败不能影响主链路 */
      }
    }, 60_000)
    return () => clearInterval(timer)
  }, 'mnemo-proactive: scheduler')

  ctx.logger('mnemo-proactive').info(
    `proactive ready (interval=${config.minIntervalMin}min, cap=${config.maxPerDay}/day, quiet=${config.quietStart}-${config.quietEnd})`,
  )
  return service
}

export { ProactiveService as MnemoProactive }
export type { Pad }
