/**
 * @rain13sad/dsh-mnemo-recall —— 读侧（§14.5）
 *
 * 在 `agent/pre-step` 的 waterfall 阶段注入记忆块，并写 `memory/recall` 事件。
 * 门控是省 token 的第一道闸：不是"每轮都查"，而是"该查才查"。
 *
 * ⚠ 与实机的接缝：`payload.messages` 是否可变、注入位置约定，在 rc 间调整过。
 * 这里按 rc.3 的 `UserMessage[]` 可变数组实现，并在 push 前做一次形状校验；
 * 若宿主改为不可变，需要改到 `agent/request` 阶段插入（文档 §14.5 的 ⚠ 已标注）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  referencesPast,
  topicFingerprint,
  type MemoryService,
  type RecallQuery,
  type RecallResult,
  type SurfaceMode,
} from '@rain13sad/dsh-mnemo-core'

export const name = 'mnemo-recall'
export const inject = ['memory', 'sessions']

export interface Config {
  enabled: boolean
  injectOnFirstTurn: boolean
  topicDriftThreshold: number
  minTurnsBetweenInjections: number
  budgetGuard: number
  applyTemperature: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('总开关：关掉后只保留工具与命令的主动检索'),
  injectOnFirstTurn: z.boolean().default(true).description('会话首轮全量注入（建立画像）'),
  topicDriftThreshold: z.number().min(0).max(1).default(0.6).description('话题漂移阈值：cos 低于此值视为换话题，需要重新注入'),
  minTurnsBetweenInjections: z.number().min(0).max(10).default(1).description('两次注入之间至少间隔的轮数'),
  budgetGuard: z.number().min(0).max(1).default(0.8).description('预算已用超过此比例时停止注入'),
  applyTemperature: z.boolean().default(false).description('按 affect.policy 微调 temperature（宿主不支持时自动跳过）'),
})

interface SessionGateState {
  turn: number
  topic?: string
  lastInjectTurn: number
  lastTopic?: string
  manualRecallThisTurn: boolean
  budgetSpent: number
}

export interface InjectionPayload {
  messages: Array<Record<string, unknown>>
  turn?: number
  step?: number
}

/** 门控规则表（§14.5）。返回 true 表示本轮需要注入。 */
export function shouldInject(
  input: { text: string; turn: number; isFirstTurn: boolean; isToolOnly: boolean; topic: string },
  state: SessionGateState,
  config: Config,
): { inject: boolean; reason: string } {
  if (!config.enabled) return { inject: false, reason: '总开关关闭' }
  if (state.manualRecallThisTurn) return { inject: false, reason: '模型已调 memory_recall' }
  if (state.budgetSpent > config.budgetGuard) return { inject: false, reason: `预算已用 ${(state.budgetSpent * 100).toFixed(0)}%` }
  if (input.isToolOnly) return { inject: false, reason: '纯工具调用轮' }
  if (input.isFirstTurn && config.injectOnFirstTurn) return { inject: true, reason: '会话首轮，建立画像' }
  if (referencesPast(input.text)) return { inject: true, reason: '用户显式指代过去' }
  if (state.lastTopic && input.topic !== state.lastTopic) return { inject: true, reason: '话题漂移' }
  if (input.turn - state.lastInjectTurn >= Math.max(2, config.minTurnsBetweenInjections + 1)) {
    return { inject: true, reason: '间隔已达阈值' }
  }
  return { inject: false, reason: '上轮刚注入且话题未变' }
}

export function apply(ctx: Context, config: Config) {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) throw new Error('[mnemo-recall] 需要 ctx.memory')
  const gates = new Map<string, SessionGateState>()

  const stateOf = (sid: string): SessionGateState => {
    let s = gates.get(sid)
    if (!s) {
      s = { turn: 0, lastInjectTurn: -99, manualRecallThisTurn: false, budgetSpent: 0 }
      gates.set(sid, s)
    }
    return s
  }

  /** 供 tools 调用：模型主动检索后，本轮不再自动注入（避免重复付费）。 */
  const markManualRecall = (sid: string) => {
    stateOf(sid).manualRecallThisTurn = true
  }
  // Cordis 的 ctx 是 proxy，禁止任意赋值；要用 provide 暴露服务
  ;(ctx as unknown as { provide(n: string, v: unknown): unknown }).provide('mnemoRecallGate', { markManualRecall, stateOf })

  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      const sid = String(payload.agent?.session?.id ?? 'default')
      const state = stateOf(sid)
      const turn = Number(payload.turn ?? state.turn)
      state.turn = turn
      state.manualRecallThisTurn = false

      const last = lastUserText(payload.messages)
      const topic = topicFingerprint(last)
      const gate = shouldInject(
        { text: last, turn, isFirstTurn: turn <= 1, isToolOnly: last.trim().length === 0, topic },
        state,
        config,
      )
      if (!gate.inject) {
        state.lastTopic = topic
        return next()
      }

      const affect = ctx.get('affect') as
        | { current(): { v: number; a: number; d: number; s: number }; policy(): { disableDivergence: boolean } }
        | undefined

      const q: RecallQuery = {
        text: last,
        pad: affect?.current(),
        relational: (affect as { relationalSnapshot?: () => { trust: number; familiarity: number } } | undefined)?.relationalSnapshot?.(),
        topic,
        budget: memory.config.maxSurfaceTokens,
        sessionId: sid,
      }
      const r: RecallResult = memory.recall(q)
      if (r.hits.length === 0) {
        state.lastTopic = topic
        return next()
      }

      // surfaceMode 可被策略临时下调（budget < 0.2 时切列式，§11.6）
      let rendered = r.rendered
      let tokens = r.tokens
      if (affect?.policy().disableDivergence && memory.config.surfaceMode !== 'compact') {
        const compact = memory.recall({ ...q, manual: true })
        if (compact.tokens < tokens) {
          rendered = compact.rendered
          tokens = compact.tokens
        }
      }

      const msg = buildInjectionMessage(rendered, r.queryId)
      if (!Array.isArray(payload.messages)) {
        ctx.logger('mnemo-recall').warn('payload.messages 不是数组，跳过注入（宿主 API 变更？见 §14.5 ⚠）')
        return next()
      }
      payload.messages.splice(insertAt(payload.messages), 0, msg as unknown as UserMessage)

      state.lastInjectTurn = turn
      state.lastTopic = topic
      state.budgetSpent = Math.min(1, state.budgetSpent + tokens / 2000)
      memory.emit('memory/recall', {
        queryId: r.queryId,
        strategy: r.strategy,
        hits: r.hits,
        renderedTokens: tokens,
        surfaceMode: memory.config.surfaceMode as SurfaceMode,
        snapshotId: r.snapshotId,
        reason: gate.reason,
      })
      return next()
    })
    return () => off()
  }, 'mnemo-recall: pre-step injection')

  if (config.applyTemperature) {
    ctx.effect(() => {
      const off = ctx.on('agent/request', async (_payload, next) => {
        const cfg = await next()
        const affect = ctx.get('affect') as { policy(): { temperatureDelta: number } } | undefined
        const delta = affect?.policy().temperatureDelta ?? 0
        if (delta === 0 || typeof cfg?.temperature !== 'number') return cfg
        const base = cfg.temperature as number
        return { ...cfg, temperature: Math.min(1.5, Math.max(0, base + delta)) }
      })
      return () => off()
    }, 'mnemo-recall: temperature modulation')
  }

  ctx.logger('mnemo-recall').info(`recall ready (drift=${config.topicDriftThreshold}, budgetGuard=${config.budgetGuard})`)
}

/** 注入位置：system 之后、最后一条 user 之前。插错位置会让模型把记忆当成用户刚说的话。 */
export function insertAt(messages: readonly unknown[]): number {
  let idx = messages.length
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string } | undefined)?.role === 'user') {
      idx = i
      break
    }
  }
  return idx
}

export function lastUserText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown } | undefined
    if (m?.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((b) => (b && typeof b === 'object' && typeof (b as { text?: string }).text === 'string' ? (b as { text: string }).text : ''))
        .join('\n')
    }
  }
  return ''
}

/**
 * 注入消息：用 `source.kind='plugin'` + `form='recall'`。
 * 这两个字段不是装饰——它们让"这段内容从哪来"在日志里可查，
 * 也让 UI 能把它与用户真实发言区分开（§19.3 透明性要求）。
 */
export function buildInjectionMessage(rendered: string, queryId: string): Record<string, unknown> {
  return {
    id: `mnemo-${queryId}`,
    role: 'user',
    content: [{ type: 'text', text: rendered }],
    source: { kind: 'plugin', plugin: '@rain13sad/dsh-mnemo-recall', form: 'recall' },
  }
}
