/**
 * @rain13sad/dsh-mnemo-tools —— 工具面 + 命令面（§17）
 *
 * 六个模型可见工具。工具描述是模型唯一能看到的契约，含糊会误用，因此三条必须写进 description：
 *   1. memory_recall 不要滥用（自动注入已覆盖大部分场景）
 *   2. affect_report 返回状态变量，不是感受
 *   3. memory_forget 是删除，--hard 不可撤销
 *
 * 审批条件化：`memory_assert` 在用户明说"记住"时免审（v0.1 一律要审批，
 * 导致最自然的用法反而最卡）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  FLAG,
  KIND,
  REL,
  TRUST_BY_PROVENANCE,
  cellIdFor,
  hashEmbedding,
  isUserAskedToRemember,
  topicOf,
  toHex,
  type MemoryService,
  type Slot,
} from '@rain13sad/dsh-mnemo-core'
import { buildGuard, isEgressTool, type EgressGuard } from './guard.js'
import { runCommand, type CommandDeps } from './commands.js'
import { attachCommandFace, registerCommandBridge, registerRemoteFace, registerSnapshotBridge } from './bridge.js'
import type { RuntimeStatus } from '@rain13sad/dsh-mnemo-core'

export const name = 'mnemo-tools'
export const inject = ['memory', 'tools', 'sessions']

export interface Config {
  piiRedaction: boolean
  blockMemoryInEgress: boolean
  requireApprovalFor: string[]
  /** 无 cmdline 服务时，把命令面降级成一个工具（默认开，保证功能不丢） */
  commandToolFallback: boolean
}

export const Config: z<Config> = z.object({
  piiRedaction: z.boolean().default(true).description('编码期脱敏'),
  blockMemoryInEgress: z.boolean().default(true).description('记忆内容禁止出现在外发工具参数里（fail-closed）'),
  requireApprovalFor: z.array(z.string()).default(['memory_forget', 'memory_assert']).description('需审批的工具清单'),
  commandToolFallback: z.boolean().default(true).description('宿主无 cmdline 时，用 mnemo_command 工具承载命令面'),
})

const text = (t: string) => [{ type: 'text' as const, text: t }]

export function apply(ctx: Context, config: Config) {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) throw new Error('[mnemo-tools] 需要 ctx.memory')
  const tools = ctx.get('tools') as
    | { register(def: unknown): () => void; guard?(g: (exec: { name?: string; args?: unknown }) => string | undefined): () => void }
    | undefined
  if (!tools) throw new Error('[mnemo-tools] 需要 ctx.tools')

  const affect = ctx.get('affect') as
    | {
        report(): Record<string, number | string>
        current(): { v: number; a: number; d: number; s: number }
        currentIntero(): Record<string, number>
        setIntero(p: Record<string, number>): unknown
        snapshot(): unknown
      }
    | undefined

  const disposers: Array<() => void> = []
  const runtime = ctx.get('mnemoRuntime') as RuntimeStatus | undefined

  /** 注册工具并登记到运行时状态：面板"已注册工具"读的就是这一份。 */
  const register = (def: unknown): (() => void) => {
    const off = tools.register(def)
    const nm = (def as { name?: string }).name
    if (nm) runtime?.addTool(nm)
    return () => {
      off()
      if (nm) runtime?.removeTool(nm)
    }
  }

  /** 每个会话最后一条用户消息：memory_assert 的"用户是否明说要记住"判据（§17.1） */
  const lastUser = new Map<string, string>()

  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const e = event as { type?: string; content?: unknown }
      if (e?.type !== 'user/message') return
      const sid = String((session as { id?: string })?.id ?? 'default')
      const c = e.content
      const text = Array.isArray(c)
        ? c.map((b) => String((b as { text?: string })?.text ?? '')).join('\n')
        : String(c ?? '')
      if (text.trim()) lastUser.set(sid, text)
    })
    return () => off()
  }, 'mnemo-tools: last user message')

  /**
   * 审批条件化（§17.1）：用户明说"记住 X"时免审。
   * v0.1 一律要审批，导致最自然的用法反而最卡——这条规则是文档点名要改的。
   */
  const requireAssertApproval = (sessionId: string): boolean => {
    if (!config.requireApprovalFor.includes('memory_assert')) return false
    return !isUserAskedToRemember(lastUser.get(sessionId) ?? '')
  }

  // ── 1. memory_recall ────────────────────────────────────────────
  disposers.push(
    register({
      name: 'memory_recall',
      description:
        '主动检索长期记忆。**不要滥用**：自动注入已覆盖大部分场景，只在"需要查证"或"用户明确指向过去"时调用。返回 MRS 行式结果与命中的 cell id。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索语句（自然语言或标识符）' },
          kinds: {
            type: 'array',
            items: { type: 'integer', enum: [0, 1, 2, 3, 4, 5] },
            description: '限定类型：0 情景 / 1 语义 / 2 程序 / 3 图式 / 4 人格锚 / 5 关系',
          },
          time_range: {
            type: 'object',
            properties: { from: { type: 'integer' }, to: { type: 'integer' } },
            description: '时间范围（epoch ms）',
          },
          limit: { type: 'integer', minimum: 1, maximum: 16, description: '最多返回条数，默认按槽位' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            queryId: { type: 'string' },
            strategy: { type: 'string' },
            rendered: { type: 'string' },
            tokens: { type: 'integer' },
            candidates: { type: 'integer' },
            elapsedMs: { type: 'integer' },
            hits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  cellId: { type: 'string' },
                  shortId: { type: 'string' },
                  score: { type: 'number' },
                  slot: { type: 'integer' },
                  channel: { type: 'string' },
                },
              },
            },
          },
          required: ['queryId', 'rendered', 'hits'],
        },
        render: (_args: unknown, value: Record<string, unknown>) =>
          text(`记忆命中 ${(value.hits as unknown[]).length} 条（${value.strategy}，${value.tokens} token）\n${value.rendered}`),
      },
      // 对话流内卡片（§12.7）：默认折叠成一行摘要，展开才看完整 MRS。
      // 不做默认展开——那会变成另一种上下文污染（它只影响 UI，不进模型上下文）。
      presentCall(args: unknown) {
        const a = args as { query?: string } | undefined
        return { card: 'generic' as const, title: `检索记忆：${a?.query ?? ''}`, kind: 'search' as const }
      },
      presentResult(_args: unknown, value: unknown) {
        const v = value as { hits?: unknown[]; tokens?: number; strategy?: string; rendered?: string }
        const n = v.hits?.length ?? 0
        return {
          card: 'generic' as const,
          title: `记忆 · ${n} 条　${v.strategy ?? ''}　${v.tokens ?? 0} token`,
          content: v.rendered ? [{ type: 'text' as const, text: v.rendered }] : undefined,
        }
      },
      async execute(args: unknown) {
        const a = args as { query: string; kinds?: number[]; time_range?: { from: number; to: number }; limit?: number }
        const r = memory.recall({
          text: a.query,
          budget: 500,
          manual: true,
          kinds: a.kinds as never,
          timeRange: a.time_range,
        })
        const hits = a.limit ? r.hits.slice(0, a.limit) : r.hits
        return {
          queryId: r.queryId,
          strategy: r.strategy,
          rendered: r.rendered,
          tokens: r.tokens,
          candidates: r.candidates,
          elapsedMs: r.elapsedMs,
          hits,
        }
      },
    }),
  )

  // ── 2. memory_expand ────────────────────────────────────────────
  disposers.push(
    register({
      name: 'memory_expand',
      description:
        '展开一条记忆。level 0=摘要 / 1=全部槽位 / 2=原文残差（受 800 字上限与遮蔽检测约束）。只在确实需要细节时调用——展开会花 token。',
      parameters: {
        type: 'object',
        properties: {
          cell_id: { type: 'string', description: 'cell id（4 位短 id 或 16 位完整 hex）' },
          level: { type: 'integer', enum: [0, 1, 2], description: '展开层级' },
        },
        required: ['cell_id', 'level'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            cellId: { type: 'string' },
            level: { type: 'integer' },
            text: { type: 'string' },
            tokens: { type: 'integer' },
            shadowed: { type: 'boolean' },
            truncated: { type: 'boolean' },
          },
          required: ['cellId', 'text'],
        },
        render: (_a: unknown, v: Record<string, unknown>) =>
          text(`${v.shadowed ? '[已被压缩摘要覆盖] ' : ''}${v.text}${v.truncated ? '（已截断）' : ''}`),
      },
      presentCall(args: unknown) {
        const a = args as { cell_id?: string; level?: number } | undefined
        return { card: 'generic' as const, title: `展开记忆 ${a?.cell_id ?? ''}（level ${a?.level ?? 0}）`, kind: 'read' as const }
      },
      async execute(args: unknown) {
        const a = args as { cell_id: string; level: 0 | 1 | 2 }
        const id = a.cell_id.length >= 16 ? a.cell_id : resolveShort(memory, a.cell_id)
        return memory.expand(id, a.level)
      },
    }),
  )

  // ── 3. memory_assert ────────────────────────────────────────────
  disposers.push(
    register({
      name: 'memory_assert',
      description:
        '写入一条记忆断言。用户明说"记住 X"时直接调用；模型主动记录时需用户确认。返回是否新建/合并/与既有记忆冲突。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '主体（通常是"用户"）' },
          predicate: { type: 'string', description: '谓词（如 prefers / uses / decided）' },
          object: { type: 'string', description: '客体（如 ui.theme=dark）' },
          confidence: { type: 'number', minimum: 0, maximum: 1, description: '编码自评置信度' },
        },
        required: ['subject', 'predicate', 'object'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            cellId: { type: 'string' },
            action: { type: 'string' },
            support: { type: 'integer' },
            conflictWith: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['cellId', 'action'],
        },
        render: (_a: unknown, v: Record<string, unknown>) => {
          if (v.action === 'needs_approval' || v.action === 'denied') return text(String(v.message ?? '未写入'))
          return text(`已写入 ${v.cellId}（${v.action}${v.conflictWith ? `，与 ${v.conflictWith} 冲突` : ''}）`)
        },
      },
      async execute(args: unknown, exec?: { agent?: unknown; callId?: unknown; signal?: AbortSignal }) {
        const a = args as { subject: string; predicate: string; object: string; confidence?: number }
        const sid = String((exec?.agent as { session?: { id?: string } } | undefined)?.session?.id ?? 'default')
        if (requireAssertApproval(sid)) {
          const approval = ctx.get('approval') as
            | { request(req: Record<string, unknown>): Promise<string> }
            | undefined
          const agent = (exec?.agent as object | undefined) ?? undefined
          if (!approval || !agent) {
            return {
              cellId: '',
              action: 'needs_approval',
              message: '模型主动写入记忆需要用户确认；当前环境没有可用的审批面。请先向用户确认，或让用户明说"记住…"。',
            }
          }
          const outcome = await approval.request({
            agent,
            toolName: 'memory_assert',
            callId: exec?.callId,
            reason: `写入长期记忆：${a.subject} ${a.predicate} ${a.object}`,
            signal: exec?.signal,
          })
          if (outcome !== 'allowed-once') {
            return { cellId: '', action: 'denied', message: `用户未批准（${outcome}），未写入任何内容。` }
          }
        }
        const slots: Slot[] = [
          { role: 1, type: 'LIT', value: a.subject },
          { role: 3, type: 'LIT', value: a.predicate },
          { role: 2, type: 'LIT', value: a.object },
          { role: 9, type: 'LIT', value: 'pos' },
        ]
        const sdr = memory.space.bundle(
          slots.map((s) => memory.space.bind(memory.space.identity('V:' + s.value.toLowerCase()), memory.space.role(String(s.role)))),
        )
        const now = Date.now()
        const r = memory.ingest(
          {
            cellId: cellIdFor('assert', [now], sdr),
            kind: KIND.semantic,
            tier: 1,
            flags: 0,
            tFrom: BigInt(now),
            tTo: BigInt(now),
            tIngest: BigInt(now),
            tAccess: BigInt(now),
            accessCount: 0,
            stability: 7,
            importance: 0.6,
            valence: 0,
            arousal: 0,
            dominance: 0.5,
            salience: 0.5,
            provenance: 0,
            trust: TRUST_BY_PROVENANCE[0],
            sdr,
            emb: hashEmbedding(`${a.subject} ${a.predicate} ${a.object}`, memory.config.embDim),
            slots,
            edges: [],
            residual: null,
            confidence: a.confidence ?? 0.8,
            support: 1,
            topic: topicOf(a.object),
            digest: `${a.subject} ${a.predicate} ${a.object}`,
          },
          [],
        )
        return {
          cellId: toHex(r.cell.cellId, 16),
          action: r.action,
          support: r.cell.support,
          conflictWith: r.conflictWith,
        }
      },
    }),
  )

  // ── 4. memory_forget ────────────────────────────────────────────
  disposers.push(
    register({
      name: 'memory_forget',
      description:
        '删除记忆。默认软删（可唤醒），mode="hard" 为物理删除且**不可撤销**。调用前必须先向用户确认，并说明将删除什么。',
      parameters: {
        type: 'object',
        properties: {
          cell_id: { type: 'string', description: '目标 cell id' },
          mode: { type: 'string', enum: ['soft', 'hard'], description: '软删 / 物理删除' },
          reason: { type: 'string', description: '删除理由（写入审计）' },
        },
        required: ['cell_id', 'mode'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { cellId: { type: 'string' }, mode: { type: 'string' }, ok: { type: 'boolean' } },
          required: ['cellId', 'mode', 'ok'],
        },
        render: (_a: unknown, v: Record<string, unknown>) => text(`已${v.mode === 'hard' ? '物理删除' : '软删除'} ${v.cellId}`),
      },
      async execute(args: unknown) {
        const a = args as { cell_id: string; mode: 'soft' | 'hard'; reason?: string }
        const id = a.cell_id.length >= 16 ? a.cell_id : resolveShort(memory, a.cell_id)
        memory.forget(id, a.mode, 'user', a.reason ?? 'tool call')
        return { cellId: a.cell_id, mode: a.mode, ok: true }
      },
    }),
  )

  // ── 5. affect_report ────────────────────────────────────────────
  disposers.push(
    register({
      name: 'affect_report',
      description:
        '返回内部状态**数值**（负荷/不确定性/冲突/张力/进度/预算）与 PAD。这些不是主观体验，也不代表拥有情绪——不要把它们描述成"感受"。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_a: unknown, v: Record<string, unknown>) =>
          text(
            Object.entries(v)
              .filter(([k]) => k !== 'disclaimer')
              .map(([k, x]) => `${k}=${x}`)
              .join('  ') + `\n（${v.disclaimer ?? ''}）`,
          ),
      },
      async execute() {
        if (!affect) {
          return { enabled: false, disclaimer: '情感内核未安装，记忆功能不受影响。' }
        }
        return affect.report()
      },
    }),
  )

  // ── 6. memory_stats ─────────────────────────────────────────────
  disposers.push(
    register({
      name: 'memory_stats',
      description: '返回记忆库统计：cell 数、分层、命中率、token 账、存储比。只读，用于回答"你现在记得多少"这类问题。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_a: unknown, v: Record<string, unknown>) =>
          text(
            `cell ${v.cells} · edge ${v.edges} · 命中率 ${((v.hitRate as number) * 100).toFixed(0)}% · ${(v.tokensPerTurn as number).toFixed(0)} token/轮`,
          ),
      },
      async execute() {
        return memory.stats() as unknown as Record<string, unknown>
      },
    }),
  )

  // ── egress 守卫（§17.3，fail-closed） ───────────────────────────
  let guard: EgressGuard | undefined
  if (config.blockMemoryInEgress && tools.guard) {
    ctx.effect(() => {
      guard = buildGuard(memory)
      const off = tools.guard!((exec) => {
        if (!exec?.name || !isEgressTool(exec.name)) return undefined
        const hit = guard!.scan(exec.args)
        return hit.blocked ? hit.reason : undefined
      })
      return () => {
        off()
        guard?.dispose()
      }
    }, 'mnemo-tools: egress guard')
  }

  // ── 命令面（§12.6） ─────────────────────────────────────────────
  const deps: CommandDeps = {
    memory,
    affect,
    setPreset: (p) => memory.setConfig({ preset: p }),
    setSurfaceMode: (m) => memory.setConfig({ surfaceMode: m }),
    proactive: ctx.get('mnemoProactive') as never,
    rebuild: async () => {
      const r = await memory.rebuildFromLog()
      return `重建完成：重放 ${r.turns} 轮，生成 ${r.cells} 条 cell（当前库 ${memory.store.countCells()} 条）`
    },
    openPanel: () => (ctx as unknown as { emit(n: string, p: unknown): void }).emit('mnemo/open-panel', { panel: 'mnemo' }),
  }

  // ── 数据面与命令面接线（§12.6 / §20.2） ──────────────────────────
  // 顺序有讲究：先把 remote / snapshot / 命令桥提供给面板，再尝试挂命令面。
  // 这样即使宿主既没有 remote 也没有 cmdline，面板仍然能读写与执行命令。
  const remoteNotes = registerRemoteFace(ctx, memory, runtime).notes
  registerSnapshotBridge(ctx, memory)
  registerCommandBridge(ctx, (argv) => runCommand(argv, deps), runtime)

  const face = attachCommandFace(ctx, (argv) => runCommand(argv, deps), runtime)
  if (face === 'none') {
    if (config.commandToolFallback) {
      // 降级：宿主没有命令面时，把同一套命令做成工具，保证功能不丢
      disposers.push(
        register({
          name: 'mnemo_command',
          description: '运行 /mnemo 命令（宿主未提供命令面时的降级入口）。等价于 /mnemo <command> <args...>。',
          parameters: {
            type: 'object',
            properties: { line: { type: 'string', description: '命令与参数，如 "stats" 或 "forget 7f3a --hard --yes"' } },
            required: ['line'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_a: unknown, v: Record<string, unknown>) => text(String(v.text)),
          },
          async execute(args: unknown) {
            const line = String((args as { line: string }).line ?? '')
            const argv = line.trim().split(/\s+/).filter(Boolean)
            return { text: await runCommand(argv, deps) }
          },
        }),
      )
      if (runtime) runtime.commandFace = 'tool'
      ctx.logger('mnemo-tools').warn('未识别到命令面，命令面降级为 mnemo_command 工具')
    } else if (runtime) {
      runtime.commandFace = 'none'
    }
  }

  // 能力清单：面板"后端能力"区块的 chip 来源。写在这里是因为只有 tools 知道
  // "模型可见工具到底注册了哪几个"。
  if (runtime) {
    runtime.capabilities = [
      ...runtime.capabilities.filter((c) => c.startsWith('L1') || c.startsWith('remote') || c.startsWith('命令')),
      '文件系统',
      'HTTP 服务',
      '模型工具',
      '主动事件',
      '面板事件',
    ]
    runtime.limits = [
      ...runtime.limits.filter((x) => !x.startsWith('embedding')),
      'embedding：默认走本地哈希 + 同义词族（不是语义模型），接宿主 embedding 服务需实现 EmbeddingPort',
    ]
    ctx.logger('mnemo-tools').info(`bridges ready（${remoteNotes.join('；')}）`)
  }

  ctx.effect(() => () => {
    for (const d of disposers) d()
  }, 'mnemo-tools: tool disposers')

  ctx.logger('mnemo-tools').info(`tools ready (egress guard=${config.blockMemoryInEgress})`)
  return { runCommand: (argv: string[]) => runCommand(argv, deps), deps }
}

function resolveShort(memory: MemoryService, short: string): string {
  const clean = short.replace(/^#/, '').replace(/^0x/, '').toLowerCase()
  let found = ''
  memory.store.forEachCell((c) => {
    if (found) return
    if (toHex(c.cellId, 16).endsWith(clean)) found = toHex(c.cellId, 16)
  })
  return found || clean.padStart(16, '0')
}

export { runCommand, isEgressTool, buildGuard }
export type { CommandDeps }
