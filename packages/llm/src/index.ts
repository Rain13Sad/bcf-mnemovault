/**
 * @rain13sad/llm-mnemo —— LLM 适配层（v0.6）
 *
 * ── 它在架构里的位置 ────────────────────────────────────────────
 *   core（同步内核，零依赖）
 *     ↑ 只认端口
 *   llm（本包：把 HTTP 模型适配成端口）
 *     ↑ 只认宿主
 *   DSH / MCP / REST / 你的 Agent
 *
 * 于是"适配常用大模型"这件事只剩三步：
 *   1. 选 provider（7 家预设）
 *   2. 选模型（画像表里查 tokenizer / 窗口 / 价格）
 *   3. 决定要不要开 embedding 与 LLM 抽取（默认都关，零依赖优先）
 *
 * ── 两个默认关闭的开关 ──────────────────────────────────────────
 * `embeddingEnabled` 与 `extractEnabled` 默认 **false**。理由不是保守，是诚实：
 * 打开它们会打破"零第三方依赖、离线可跑"的承诺（要联网、要密钥、要花钱）。
 * 这个交换必须由用户显式做出。面板的"引擎"卡片会一直显示当前跑的是哪条路。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  createMemoryAudit,
  EmotionMemoryEngine,
  resolveModel,
  systemClock,
  type EnginePorts,
  type MemoryService,
} from '@rain13sad/llm-mnemo-core'
import { HttpEmbeddingProvider } from './embedding.js'
import { LlmExtractor } from './extract.js'
import { PROVIDER_IDS, resolveProvider, PROVIDERS } from './providers.js'
import { createTokenizer } from './tokenizer.js'

export const name = 'mnemo-llm'
/**
 * 只依赖 memory：没有它这个包什么都不做。
 * 不依赖 sessions——引擎是宿主无关的，会话文本由调用方传入。
 */
export const inject = ['memory']

export interface Config {
  provider: string
  model: string
  baseUrl: string
  apiKeyEnv: string
  timeoutMs: number
  retries: number
  embeddingEnabled: boolean
  embeddingModel: string
  extractEnabled: boolean
  maxPricePerTurn: number
  /** 预热窗口：每轮把用户发言先送进 embedding 缓存，供下一轮同步读取 */
  prewarm: boolean
  /** 状态回填周期（ms）。面板的"引擎"卡片靠它刷新 */
  statusIntervalMs: number
}

export const Config: z<Config> = z.object({
  provider: z
    .string()
    .default('deepseek')
    .description(`provider 预设：${PROVIDER_IDS.join(' / ')}`),
  model: z.string().default('deepseek-chat').description('主对话模型 id（决定 tokenizer / 预算 / 价格闸）'),
  baseUrl: z.string().default('').description('自定义端点；空 = 用预设。openai-compatible 必须填'),
  apiKeyEnv: z.string().default('DEEPSEEK_API_KEY').description('密钥所在环境变量名（密钥不写进配置）'),
  timeoutMs: z.number().min(1000).max(120_000).default(15_000).description('单次调用超时；超时即降级'),
  retries: z.number().min(0).max(3).default(1).description('幂等请求重试次数'),
  embeddingEnabled: z.boolean().default(false).description('启用真 embedding（需联网 + 密钥）'),
  embeddingModel: z.string().default('').description('embedding 模型 id；空 = provider 默认'),
  extractEnabled: z.boolean().default(false).description('启用 LLM 抽取（需联网 + 密钥）'),
  maxPricePerTurn: z.number().min(0).default(0).description('单轮记忆注入价格上限（元）；0 = 不限'),
  prewarm: z.boolean().default(true).description('每轮预热查询向量（否则首轮走哈希、次轮起才用真向量）'),
  statusIntervalMs: z.number().min(5000).default(30_000).description('引擎状态回填周期'),
})

/**
 * 构建端口集合（纯函数，宿主无关）。
 *
 * 独立使用时（不装 DSH）直接调它：
 * ```ts
 * const ports = createEnginePorts({ provider: 'ollama', model: 'llama3.1:8b', embeddingEnabled: true })
 * const engine = new EmotionMemoryEngine({ memory, ports })
 * ```
 */
export function createEnginePorts(config: Partial<Config> = {}): {
  ports: EnginePorts
  notes: string[]
  embedding: HttpEmbeddingProvider | null
  extractor: LlmExtractor | null
} {
  const provider = config.provider ?? 'deepseek'
  const spec = resolveProvider(provider, config.baseUrl)
  const apiKey = config.apiKeyEnv ? (process.env[config.apiKeyEnv] ?? '') : ''
  const notes: string[] = []

  if (spec.baseUrl === '') notes.push(`${spec.label} 需要显式 baseUrl，否则无法发起请求`)
  if (spec.apiKeyEnv && !apiKey) notes.push(`环境变量 ${spec.apiKeyEnv} 未设置：只能走无鉴权端点`)

  let embedding: HttpEmbeddingProvider | null = null
  if (config.embeddingEnabled) {
    if (!spec.embedPath) {
      notes.push(`${spec.label} 没有 embedding 端点，真 embedding 不可用（已退回哈希）`)
    } else {
      embedding = new HttpEmbeddingProvider({
        provider: spec,
        model: config.embeddingModel,
        apiKey,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
      })
    }
  }

  let extractor: LlmExtractor | null = null
  if (config.extractEnabled) {
    if (!spec.chatPath) {
      notes.push(`${spec.label} 没有 chat 端点，LLM 抽取不可用（已退回规则）`)
    } else {
      extractor = new LlmExtractor({
        provider: spec,
        model: config.model,
        apiKey,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
      })
    }
  }

  const model = resolveModel(config.model)
  /**
   * tokenizer 口径必须跟**模型**走，不能跟 provider 走（v0.6.1 · 修 F7）。
   *
   * v0.6.0 是 `tokenizer = spec.tokenizer`（来自 provider 预设）+
   * `model = resolveModel(config.model)`（来自配置），两者没有任何一致性校验。
   * 于是 `provider: 'openai'` + `model: 'deepseek-chat'` 会拿 cl100k 的 token 数
   * 去乘 DeepSeek 的价格——同一段中文两个口径差 18%，叠加模型别名问题可差 40%+。
   *
   * 现在以模型画像为准（它才是"这段文字怎么被切成 token"的真凭据），
   * 不一致时纠正并留一条 note，让面板的限制清单能看见。
   */
  const kind = model.tokenizer ?? spec.tokenizer
  if (model.provider !== spec.provider && model.id !== 'unknown') {
    notes.push(
      `provider=${spec.id} 与 model=${model.id}（${model.provider}）不是同一家：` +
        `token 口径已按模型校正为 ${kind}，端点仍用 ${spec.id}`,
    )
  }
  const tokenizer = createTokenizer({ kind, name: `${model.provider}/${kind}` })
  if (model.fallback) notes.push(`模型 ${config.model} 不在画像表里：按保守档编译（prose + 小预算，价格按最贵估）`)

  return {
    ports: {
      embedding,
      extractor,
      tokenizer,
      clock: systemClock,
      audit: createMemoryAudit(),
      model,
    },
    notes,
    embedding,
    extractor,
  }
}

export function apply(ctx: Context, config: Config) {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) throw new Error('[mnemo-llm] 需要 ctx.memory（先启用 dsh-mnemo-core）')

  const { ports, notes, embedding, extractor } = createEnginePorts(config)
  const spec = resolveProvider(config.provider, config.baseUrl)

  // 端口注册：core 可能已经先激活（拿到的是空集合），所以两条路都走
  try {
    ctx.provide('mnemoPorts', ports)
  } catch {
    /* 已存在（热重载）：下面 usePorts 会覆盖 */
  }
  memory.usePorts(ports)

  const engine = new EmotionMemoryEngine({ memory, ports, model: config.model })
  try {
    ctx.provide('mnemoEngine', engine)
  } catch {
    /* 热重载 */
  }

  /**
   * 预热：把本轮用户发言先送进 embedding 缓存。
   *
   * 为什么需要它：内核的 `recall()` 是同步的，而 HTTP embedding 是异步的。
   * 不预热的话，**首轮**永远拿不到真向量（缓存空），只有第二轮起才生效。
   * 代价是每轮多一次 embedding 调用；`prewarm=false` 可关掉。
   *
   * 注意：本钩子与 recall 的钩子同事件，注册顺序决定谁先跑。
   * 顺序不对时的行为是"本轮仍走哈希"，**不会出错**——这是可接受的降级。
   */
  ctx.effect(() => {
    if (!config.prewarm || !embedding) return () => {}
    type StepHook = (payload: unknown, next: () => unknown) => Promise<unknown>
    const on = (ctx as unknown as { on(n: string, f: StepHook): () => void }).on
    const off = on.call(ctx, 'agent/pre-step', async (payload: unknown, next: () => unknown) => {
      try {
        const text = lastUserText(payload)
        if (text.trim().length >= 2) await embedding.prime([text])
      } catch (err) {
        memory.counters.noteEmbedError(err)
      }
      return next()
    })
    return () => off()
  }, 'mnemo-llm: prewarm')

  // 状态回填：面板的"引擎"卡片、doctor、命令面都读同一份
  ctx.effect(() => {
    const publish = () => {
      try {
        memory.noteEngine(engine.status())
      } catch {
        /* 库未就绪时静默跳过，下一轮再来 */
      }
    }
    publish()
    const timer = setInterval(publish, config.statusIntervalMs)
    return () => clearInterval(timer)
  }, 'mnemo-llm: status')

  const limits = notes.length ? `；${notes.join('；')}` : ''
  ctx.logger('mnemo-llm').info(
    `engine ready (${spec.label} · ${config.model} · embedding=${embedding ? 'provider' : 'hash'} · extract=${extractor ? 'llm' : 'rule'}${limits})`,
  )
}

/** 取最后一条用户发言（与 recall 包同口径，但不引入它的依赖）。 */
export function lastUserText(payload: unknown): string {
  const msgs = (payload as { messages?: unknown })?.messages
  if (!Array.isArray(msgs)) return ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; content?: unknown } | undefined
    if (m?.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c.map((b) => (b && typeof b === 'object' && typeof (b as { text?: string }).text === 'string' ? (b as { text: string }).text : '')).join('\n')
    }
  }
  return ''
}

export { PROVIDERS, PROVIDER_IDS, resolveProvider, authHeaders, endpointOf, withQueryKey } from './providers.js'
export { HttpEmbeddingProvider, parseEmbedding, l2 } from './embedding.js'
export { LlmExtractor, extractText, parseFacts } from './extract.js'
export { createTokenizer, countWith, calibrationOf } from './tokenizer.js'
export { HttpError, postJson } from './http.js'
export type { ProviderSpec } from './providers.js'
