/**
 * @rain13sad/dsh-mnemo-devkit —— 无宿主运行器
 *
 * 存在的理由：这套插件的行为（注入、门控、巩固、遗忘）全是**时序**相关的，
 * 单测纯函数只能覆盖数学，覆盖不了"第三轮到底注入了什么"。
 * 这里用真实的 Cordis 运行时（@deepseek-ai/cordis 的 Context）装载全部插件，
 * 只把 `sessions` / `tools` 换成最小桩，其余走真实代码路径。
 *
 * 因此 demo、集成测试、面板预览拿到的是**同一份行为**，不是两套模拟。
 */

import { Context } from '@deepseek-ai/cordis'
import { defaultConfig, type MnemoConfig, type PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import * as core from '@rain13sad/dsh-mnemo-core'
import * as affectPkg from '@rain13sad/dsh-mnemo-affect'
import * as encoderPkg from '@rain13sad/dsh-mnemo-encoder'
import * as recallPkg from '@rain13sad/dsh-mnemo-recall'
import * as consolidatorPkg from '@rain13sad/dsh-mnemo-consolidator'
import * as proactivePkg from '@rain13sad/dsh-mnemo-proactive'
import * as toolsPkg from '@rain13sad/dsh-mnemo-tools'
import * as settingsPkg from '@rain13sad/dsh-mnemo-settings'

export interface HarnessOptions {
  config?: Partial<MnemoConfig>
  /** 装载哪些包；默认除 ui 外全装 */
  plugins?: Array<'core' | 'affect' | 'encoder' | 'recall' | 'consolidator' | 'proactive' | 'tools' | 'settings'>
  sessionId?: string
  /** 固定时钟，便于测试（默认 Date.now） */
  now?: () => number
  /** 覆盖 encoder 的配置（bench 用不同切分预算做对照实验） */
  encoder?: Record<string, unknown>
  quiet?: boolean
}

export interface TurnOptions {
  /** 覆盖会话 id（跨会话隔离测试用） */
  session?: string
  assistant?: string
  tools?: Array<{ name: string; text: string; fromWeb?: boolean }>
  /** 额外推进多少毫秒（模拟时间流逝） */
  advanceMs?: number
}

export interface InjectedMessage {
  role: string
  content: Array<{ type: string; text: string }>
  source?: Record<string, unknown>
}

export interface Harness {
  ctx: Context
  memory: core.MemoryService
  affect?: affectPkg.AffectService
  tools: Map<string, { name: string; execute(args: unknown, exec?: unknown): Promise<unknown> }>
  invokeTool(name: string, args: unknown): Promise<unknown>
  /** 单独跑一遍 egress 守卫（不执行工具），返回拒绝理由或 null */
  guard(name: string, args: unknown): string | null
  /**
   * 当前（可推进的）时钟。
   * 事件时间用的是这个时钟而不是 Date.now()，调用方构造 asOf 时也必须用它，
   * 否则会得到"查询时刻早于所有事件"的假阴性——这是实测踩过的坑。
   */
  now(): number
  /** 模拟一轮对话：发 turn/start → user/message → assistant/message → tool/result → turn/end */
  turn(user: string, opts?: TurnOptions): Promise<{ cells: number }>
  /** 手动跑一次 pre-step，返回被注入的消息（没有注入则为 null） */
  preStep(user: string, opts?: { turn?: number }): Promise<InjectedMessage | null>
  /** 跑一次巩固 pass */
  consolidate(): consolidatorPkg.PassResult
  /** 从会话日志重建晶格（§14.11） */
  rebuild(): Promise<{ turns: number; cells: number }>
  /** 主动开口：拿一个候选（不发送） */
  proactive(now?: number, opts?: { ignoreSchedule?: boolean }): proactivePkg.ProactiveCandidate | null
  /** 主动服务实例（测试静音/频率用） */
  proactiveService(): proactivePkg.ProactiveService | undefined
  panel(): PanelSnapshot
  stats(): core.StatsSnapshot
  dispose(): Promise<void>
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const sessionId = opts.sessionId ?? 'sess-demo'
  let clock = opts.now ? opts.now() : Date.now()
  const now = () => (opts.now ? opts.now() : clock)
  const now0 = () => now()

  // ── 桩服务 ────────────────────────────────────────────────────
  const tools = new Map<string, { name: string; execute(args: unknown): Promise<unknown> }>()
  const guards: Array<(exec: { name?: string; args?: unknown }) => string | undefined> = []
  ctx.provide('sessions', {
    list: { getSnapshot: () => ({ byId: { [sessionId]: { id: sessionId } } }), subscribe: () => () => {} },
    binding: () => ({ sessionId }),
  })
  ctx.provide('tools', {
    register(def: { name: string; execute(args: unknown): Promise<unknown> }) {
      tools.set(def.name, def)
      return () => tools.delete(def.name)
    },
    guard(g: (exec: { name?: string; args?: unknown }) => string | undefined) {
      guards.push(g)
      return () => {
        const i = guards.indexOf(g)
        if (i >= 0) guards.splice(i, 1)
      }
    },
  })

  const config: MnemoConfig = defaultConfig({
    dbPath: ':memory:',
    ...opts.config,
  })

  const want = new Set(opts.plugins ?? ['core', 'affect', 'encoder', 'recall', 'consolidator', 'proactive', 'tools', 'settings'])

  const fibers: Array<{ dispose(): Promise<void> }> = []
  const load = async (mod: { name: string; inject: readonly string[]; apply: unknown }, cfg: unknown) => {
    const fiber = (await ctx.plugin({ name: mod.name, inject: mod.inject as never, apply: mod.apply as never }, cfg)) as unknown as { dispose(): Promise<void> }
    fibers.push(fiber)
  }

  // ── 装载插件（真实 Cordis fiber，effect 生效） ──────────────────
  if (want.has('core')) await load(core, config)
  if (want.has('affect')) await load(affectPkg, { moodTau: 20, personaDriftEpsilon: 0.25, negativeWeight: 3, enabled: true })
  if (want.has('encoder'))
    await load(encoderPkg, {
      encodeAssistant: true,
      encodeTools: true,
      maxCellsPerTurn: 8,
      cellsPerTurnChars: 600,
      maxResidualBytes: 8192,
      l1: { enabled: false, probe: false, timeoutMs: 4000 },
      ...(opts.encoder ?? {}),
    })
  if (want.has('recall')) await load(recallPkg, { enabled: true, injectOnFirstTurn: true, topicDriftThreshold: 0.6, minTurnsBetweenInjections: 1, budgetGuard: 0.8, applyTemperature: false })
  if (want.has('proactive')) await load(proactivePkg, { enabled: true, minIntervalMin: 45, maxPerDay: 3, quietStart: 23, quietEnd: 8, idleMin: 90, requireReason: true, minUrgency: 0.3 })
  if (want.has('consolidator')) await load(consolidatorPkg, { enabled: true, gamma: 0.95, pruneBelow: 8, pruneAfterDays: 90, divergenceTemp: 0.7, maxSeeds: 60 })
  if (want.has('tools')) await load(toolsPkg, { piiRedaction: true, blockMemoryInEgress: true, requireApprovalFor: ['memory_forget', 'memory_assert'], commandToolFallback: true })
  if (want.has('settings')) await load(settingsPkg, { panelPageSize: 50, graphMaxNodes: 200, lockSafetyGroup: true })

  const memory = ctx.get('memory') as core.MemoryService
  // v0.5.1：把 harness 的时钟传导给服务层，否则 createHarness({ now }) 是假的
  // （事件时间戳跟着走、demoteDue 却读 Date.now()，时间旅行测试静默失效）
  if (opts.now) memory.setClock(now)
  if (!memory) throw new Error('core 未装载成功：ctx.memory 缺失')
  const affect = ctx.get('affect') as affectPkg.AffectService | undefined
  const consolidator = ctx.get('mnemoConsolidator') as unknown as consolidatorPkg.Consolidator | undefined

  // 情感状态由 mnemo-affect 在每轮 turn/end 推送，这里不再额外建定时器

  let turnNo = 0
  let seq = 0
  const emit = (type: string, extra: Record<string, unknown> = {}) => {
    seq++
    ;(ctx as unknown as { emit(n: string, ...a: unknown[]): void }).emit('session/event', { id: sessionId }, { type, seq, time: now(), turn: turnNo, ...extra })
  }

  const harness: Harness = {
    ctx,
    memory,
    affect,
    tools,
    async invokeTool(name, args) {
      const def = tools.get(name)
      if (!def) throw new Error(`工具不存在: ${name}（已注册: ${[...tools.keys()].join(',')}）`)
      // 先过守卫，模拟真实调用链
      for (const g of guards) {
        const reason = g({ name, args })
        if (reason) throw new Error(reason)
      }
      // 传 exec：审批（§17.1）与 session 作用域都依赖 exec.agent
      return (def.execute as (a: unknown, e: unknown) => Promise<unknown>)(args, {
        agent: { id: sessionId, session: { id: sessionId } },
        callId: `call-${++seq}`,
        signal: new AbortController().signal,
      })
    },
    now() {
      return now()
    },
    guard(name, args) {
      for (const g of guards) {
        const reason = g({ name, args })
        if (reason) return reason
      }
      return null
    },
    async turn(user, o = {}) {
      turnNo++
      if (o.advanceMs) clock += o.advanceMs
      const sid = o.session ?? sessionId
      const emitIn = (type: string, extra: Record<string, unknown> = {}) => {
        seq++
        ;(ctx as unknown as { emit(n: string, ...a: unknown[]): void }).emit('session/event', { id: sid }, { type, seq, time: now(), turn: turnNo, ...extra })
      }
      emitIn('turn/start')
      emitIn('user/message', { content: [{ type: 'text', text: user }] })
      if (o.assistant) emitIn('assistant/message', { content: [{ type: 'text', text: o.assistant }] })
      for (const t of o.tools ?? []) emitIn('tool/result', { name: t.name, content: [{ type: 'text', text: t.text }] })
      const before = memory.store.countCells()
      emitIn('turn/end')
      // 编码是同步的（turn/end 监听器里完成），等一拍确保 effect 调度落地
      await Promise.resolve()
      return { cells: memory.store.countCells() - before }
    },
    async preStep(user, o = {}) {
      const messages: Array<Record<string, unknown>> = [
        { id: 'm-system', role: 'system', content: [{ type: 'text', text: 'you are a helpful assistant' }] },
        { id: 'm-user', role: 'user', content: [{ type: 'text', text: user }] },
      ]
      const payload = {
        agent: { id: sessionId, session: { id: sessionId } },
        messages,
        turn: o.turn ?? turnNo + 1,
        step: 0,
        signal: new AbortController().signal,
      }
      await (ctx as unknown as { waterfall(n: string, ...a: unknown[]): Promise<unknown> }).waterfall(
        'agent/pre-step',
        payload,
        async () => ({ kind: 'enter', messages }),
      )
      const injected = messages.find((m) => (m.source as { kind?: string } | undefined)?.kind === 'plugin')
      if (!injected) return null
      return {
        role: String(injected.role),
        content: injected.content as Array<{ type: string; text: string }>,
        source: injected.source as Record<string, unknown>,
      }
    },
    async rebuild() {
      return memory.rebuildFromLog()
    },
    proactive(now, o) {
      const svc = ctx.get('mnemoProactive') as proactivePkg.ProactiveService | undefined
      return svc ? svc.candidate(now ?? now0(), o) : null
    },
    proactiveService() {
      return ctx.get('mnemoProactive') as proactivePkg.ProactiveService | undefined
    },
    consolidate() {
      const c = consolidator ?? new consolidatorPkg.Consolidator(memory, { enabled: true, gamma: 0.95, pruneBelow: 8, pruneAfterDays: 90, divergenceTemp: 0.7, maxSeeds: 60 })
      return c.run(`pass-${turnNo}`)
    },
    panel() {
      if (affect) memory.setAffectState(affect.snapshot())
      return memory.panelSnapshot()
    },
    stats() {
      return memory.stats()
    },
    async dispose() {
      for (const f of [...fibers].reverse()) await f.dispose()
    },
  }

  return harness
}

export { core, affectPkg, encoderPkg, recallPkg, consolidatorPkg, toolsPkg, settingsPkg }
