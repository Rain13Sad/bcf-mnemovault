/**
 * 端口层（v0.6「脱钩」）
 *
 * ── 为什么要有这一层 ────────────────────────────────────────────
 * v0.5 之前，内核与"谁来提供语义/时间/token 计数"是混在一起的：
 * 哈希 embedding 写死在 `recall.ts`，`Date.now()` 写死在服务里，
 * token 预算靠一个字符启发式估。这让三件事无法成立：
 *   · 换一个真 embedding 模型（要 await）
 *   · 换一个 tokenizer（不同模型的计费口径不同）
 *   · 重放测试（时钟不可注入就无法断言"30 天后会怎样"）
 *
 * 端口层把这些"外部世界"收敛成 5 个窄接口。内核只认接口，不认实现；
 * 实现由 `@rain13sad/llm-mnemo`（HTTP 模型）或 `devkit`（测试替身）提供。
 *
 * ── 一条硬约束：内核是同步的 ──────────────────────────────────
 * `recall()` / `ingest()` 必须保持同步——这是 v0.1 起就有的性质，
 * 编码路径靠它做确定性重放。而 HTTP 模型是异步的。解法是**预热缓存**：
 *
 *   异步侧先 `embed()` 把结果放进缓存 → 同步侧 `peek()` 取用 → 没预热到就退回哈希
 *
 * 于是"有没有真模型"变成一个可观测的降级，而不是一个 await 泄漏到内核里。
 * 这条设计写进了 `EmbeddingPort.peek` 的契约，也是 `engine.status()` 能如实
 * 上报 `hash | provider | mixed` 的原因。
 */

/** 语义向量端口。`embed` 异步、`peek` 同步（读预热缓存，miss 返回 null）。 */
export interface EmbeddingPort {
  readonly name: string
  /** 模型输出维度。未知时省略，调用方按 `config.embDim` 折叠。 */
  readonly dim?: number
  /** 这个端口写入的是哪个向量空间。换空间 = 全库重算，见 `reembed()`。 */
  readonly space: string
  embed(text: string): Promise<Float32Array | number[]>
  embedBatch?(texts: string[]): Promise<Array<Float32Array | number[]>>
  /** 同步读预热结果。未预热返回 null——内核据此退回哈希并记账，绝不阻塞。 */
  peek?(text: string): Float32Array | number[] | null
  /** 预热（异步侧调用）。返回是否真的写入了缓存。 */
  prime?(texts: string[]): Promise<number>
}

/** 抽取端口：把一段自然语言变成结构化命题。失败返回 null（调用方回落规则）。 */
export interface ExtractorPort {
  readonly name: string
  extract(input: ExtractorInput): Promise<ExtractedFact[] | null>
}

export interface ExtractorInput {
  text: string
  /** 说话人：'user' | 'assistant' | 'tool'，影响 provenance 与情感归属 */
  speaker?: 'user' | 'assistant' | 'tool'
  turn?: number
  /** 已有话题，供模型判断"这是不是新信息" */
  topics?: string[]
  /** 超时（ms）。端口实现必须遵守，否则一次慢调用会拖住整轮 */
  timeoutMs?: number
}

/**
 * 抽取结果。字段刻意与 `MemCell` 的槽位同名，
 * 这样"模型给的"与"规则给的"能走同一条落库路径，不需要两套校验。
 */
export interface ExtractedFact {
  subject?: string
  predicate: string
  object?: string
  manner?: string
  quantity?: string
  time?: string
  /** 语义类别：事件 / 事实 / 偏好 / 流程 / 关系 */
  category?: 'event' | 'fact' | 'preference' | 'procedure' | 'relation'
  /** 效价 −1..1（用户对这件事的感受） */
  valence?: number
  /** 唤醒度 0..1（有多"带电"） */
  arousal?: number
  salience?: number
  confidence?: number
  /** 原文片段，用于残差与可追溯 */
  quote?: string
}

/** token 计数端口。不同模型的计费口径差 30%+，预算必须按目标模型算。 */
export interface TokenizerPort {
  readonly name: string
  count(text: string): number
  /** 按 token 上限截断（保持字节稳定，不切半个词）。 */
  truncate(text: string, maxTokens: number): string
}

/** 时钟端口。注入它只为一件事：重放测试。 */
export interface ClockPort {
  now(): number
}

/** 审计端口（L4 治理的最小实现）。删除回执与访问记录都走它。 */
export interface AuditPort {
  record(e: AuditEvent): void
  list(limit?: number): AuditEvent[]
}

export interface AuditEvent {
  at: number
  /** 动作：recall / ingest / forget / restore / pin / config / reembed */
  action: string
  /** 作用对象（cellId 或配置键） */
  target: string
  actor: 'user' | 'agent' | 'system' | 'panel'
  /** 结果摘要，进审计日志后不可改 */
  detail: string
}

/**
 * 模型画像。这是"适配常用大模型"的全部内容——不是 if/else 分支，
 * 而是一张**可被覆盖的数据表**：上下文窗口、价格、tokenizer 口径、能力位。
 *
 * 新增一家模型 = 加一行数据，不改一行逻辑。
 */
export interface ModelProfile {
  /** 模型 id，与 provider 的 API 字段一致 */
  id: string
  provider: ModelProvider
  /** 展示名 */
  label: string
  /** 上下文窗口（token） */
  contextWindow: number
  /** 单次输出上限 */
  maxOutput: number
  /** 输入价格（¥ / 百万 token），用于预算闸 */
  inputPricePerMTok: number
  /** 输出价格（¥ / 百万 token） */
  outputPricePerMTok: number
  /** tokenizer 口径：决定 `count()` 的系数 */
  tokenizer: TokenizerKind
  /** 能否吃 MRS 行式（弱模型解析不了，要降级 prose） */
  strongSchema: boolean
  /** 是否支持 JSON 模式（抽取用） */
  jsonMode: boolean
  /** 该模型家族可用的 embedding 模型（没有则只能用别的 provider 或哈希） */
  embeddingModel?: string
  embeddingDim?: number
  /**
   * 别名（v0.6.1）。
   *
   * 厂商的模型名比版本号变得快：`deepseek-chat` / `deepseek-v3` / `DeepSeek-V3`
   * 指的是同一个东西。没有别名表时，最常见的那个写法会落到保守档 →
   * 被强制降级成 prose → token 涨 2.5×，而**不会报错**。
   */
  aliases?: string[]
  /** 是否是"什么都不认识"时的兜底档（v0.6.1）。面板与端口装配据此告警。 */
  fallback?: boolean
}

export type ModelProvider = 'deepseek' | 'openai' | 'anthropic' | 'google' | 'ollama' | 'openai-compatible' | 'local'

export type TokenizerKind = 'cjk-ratio' | 'cl100k' | 'claude' | 'gemini' | 'llama'

/** 端口集合。全部可选——缺哪一项就走哪一项的降级路径，不报错。 */
export interface EnginePorts {
  embedding?: EmbeddingPort | null
  extractor?: ExtractorPort | null
  tokenizer?: TokenizerPort | null
  clock?: ClockPort | null
  audit?: AuditPort | null
  model?: ModelProfile | null
}

export const systemClock: ClockPort = { now: () => Date.now() }

/**
 * 内存审计环。默认实现只留最近 500 条：它是"可查"而不是"可归档"，
 * 归档交给宿主的 append-only 日志（我们不该复制一份会漂移的真相）。
 */
export function createMemoryAudit(limit = 500): AuditPort {
  const ring: AuditEvent[] = []
  return {
    record(e) {
      ring.push(e)
      if (ring.length > limit) ring.shift()
    },
    list(n = 50) {
      return ring.slice(-n).reverse()
    },
  }
}

export function resolvePorts(p: EnginePorts = {}): Required<Pick<EnginePorts, 'clock' | 'audit'>> & EnginePorts {
  return {
    ...p,
    clock: p.clock ?? systemClock,
    audit: p.audit ?? createMemoryAudit(),
  }
}

/**
 * 端口健康度。面板的"引擎"卡片直接读它——
 * 存在的意义是让"当前用的是真模型还是降级实现"这件事**一眼可见**，
 * 而不是藏在 README 的一句话里（v0.5 定下的规矩，v0.6 继续执行）。
 */
export interface PortHealth {
  embedding: { mode: 'hash' | 'provider'; name: string; space: string; primed: number; misses: number }
  extractor: { mode: 'rule' | 'provider'; name: string; ok: number; failed: number }
  tokenizer: { name: string; calibrated: boolean }
  model: { id: string; provider: string; contextWindow: number; inputPricePerMTok: number } | null
}

/** 降级计数器：端口实现与引擎共用一份，避免"面板说没降级、日志说降了"。 */
export class PortCounters {
  embedPrimed = 0
  embedMiss = 0
  embedError = 0
  extractOk = 0
  extractFail = 0
  private lastError: string | null = null

  noteEmbed(hit: boolean): void {
    if (hit) this.embedPrimed++
    else this.embedMiss++
  }

  noteEmbedError(err: unknown): void {
    this.embedError++
    this.lastError = String((err as Error)?.message ?? err)
  }

  noteExtract(ok: boolean): void {
    if (ok) this.extractOk++
    else this.extractFail++
  }

  get error(): string | null {
    return this.lastError
  }

  /** 抽取降级率。> 5% 时面板要明确告警（不做静默退化）。 */
  get extractFailRate(): number {
    const n = this.extractOk + this.extractFail
    return n === 0 ? 0 : this.extractFail / n
  }
}
