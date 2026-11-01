/**
 * 跨模型上下文编译器（v0.6 · 创新 I5）
 *
 * ── 问题 ────────────────────────────────────────────────────────
 * v0.5 之前，注入格式只有一个旋钮 `surfaceMode`，预算只有一个数字 `maxSurfaceTokens`。
 * 这在单模型时代够用，但在"适配常用大模型"之后立刻失效：
 *
 *   · token 口径不同：同一段中文在 DeepSeek / GPT / Claude 的 tokenizer 下差 20–40%
 *   · 能力不同：弱模型解析不了 MRS 行式，必须降级 prose（2.5× token）
 *   · 计价不同：同样 320 token，贵模型比便宜模型贵 20 倍
 *
 * ── 方案 ────────────────────────────────────────────────────────
 * `compile()` 同时受三个闸门约束，并且**先降格式、再丢条目**：
 *
 *   1. 能力闸：模型 `strongSchema=false` → 直接 prose（不让弱模型看天书）
 *   2. token 闸：超预算 → 先尝试 compact（省 25%），仍超则从尾部丢条目
 *   3. 价格闸：超 `maxPrice` → 继续丢条目，直到成本达标或只剩图例
 *
 * ── 为什么价格闸要用"钱"而不是"token" ────────────────────────────
 * B 端采购看得懂"每轮记忆注入不超过 ¥0.0003"，看不懂"320 token"。
 * 这不是营销话术——它真的改变了行为：同一个预算下，便宜模型可以多给 3 条记忆。
 */

import type { MemCell } from './cell.js'
import { estimateTokens, renderSurface, type RenderOutput } from './render.js'
import type { ModelProfile, TokenizerPort } from './ports.js'
import type { SurfaceMode } from './types.js'

/**
 * 常用模型画像表。
 *
 * 价格是**默认值、可覆盖**：它是预算闸的输入，不是对外报价。
 * 任何声称"准确价格"的硬编码都会在厂商调价那天变成谎言，
 * 所以这里只保证"数量级正确"，并把覆盖入口留给配置。
 */
export const MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'deepseek-chat',
    provider: 'deepseek',
    aliases: ['deepseek-v3', 'deepseek-v3.1', 'deepseek-chat-v3', 'DeepSeek-V3', 'deepseek'],
    label: 'DeepSeek V3',
    contextWindow: 128_000,
    maxOutput: 8_192,
    inputPricePerMTok: 2,
    outputPricePerMTok: 8,
    tokenizer: 'cjk-ratio',
    strongSchema: true,
    jsonMode: true,
    embeddingModel: 'none',
  },
  {
    id: 'deepseek-reasoner',
    provider: 'deepseek',
    aliases: ['deepseek-r1', 'deepseek-reasoner-v3', 'DeepSeek-R1', 'r1'],
    label: 'DeepSeek R1',
    contextWindow: 128_000,
    maxOutput: 32_768,
    inputPricePerMTok: 4,
    outputPricePerMTok: 16,
    tokenizer: 'cjk-ratio',
    strongSchema: true,
    jsonMode: false,
  },
  {
    id: 'gpt-4o',
    provider: 'openai',
    aliases: ['gpt4o', 'gpt-4o-latest', 'gpt-4o-2024-11-20'],
    label: 'GPT-4o',
    contextWindow: 128_000,
    maxOutput: 16_384,
    inputPricePerMTok: 18,
    outputPricePerMTok: 72,
    tokenizer: 'cl100k',
    strongSchema: true,
    jsonMode: true,
    embeddingModel: 'text-embedding-3-small',
    embeddingDim: 1536,
  },
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    aliases: ['gpt4o-mini', 'gpt-4o-mini-2024-07-18'],
    label: 'GPT-4o mini',
    contextWindow: 128_000,
    maxOutput: 16_384,
    inputPricePerMTok: 1.1,
    outputPricePerMTok: 4.4,
    tokenizer: 'cl100k',
    strongSchema: true,
    jsonMode: true,
    embeddingModel: 'text-embedding-3-small',
    embeddingDim: 1536,
  },
  {
    id: 'gpt-5',
    provider: 'openai',
    label: 'GPT-5',
    contextWindow: 400_000,
    maxOutput: 32_768,
    inputPricePerMTok: 9,
    outputPricePerMTok: 36,
    tokenizer: 'cl100k',
    strongSchema: true,
    jsonMode: true,
    embeddingModel: 'text-embedding-3-small',
    embeddingDim: 1536,
    aliases: ['gpt5', 'gpt-5-mini', 'gpt-5-2025', 'o5'],
  },
  {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.5',
    contextWindow: 200_000,
    maxOutput: 16_384,
    inputPricePerMTok: 22,
    outputPricePerMTok: 108,
    tokenizer: 'claude',
    strongSchema: true,
    jsonMode: false,
    aliases: ['claude-sonnet-4-5-20250929', 'claude-4-5-sonnet'],
  },
  {
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    aliases: ['claude-3.5-sonnet', 'claude-3-5-sonnet-20241022', 'claude-sonnet'],
    label: 'Claude 3.5 Sonnet',
    contextWindow: 200_000,
    maxOutput: 8_192,
    inputPricePerMTok: 22,
    outputPricePerMTok: 108,
    tokenizer: 'claude',
    strongSchema: true,
    jsonMode: false,
  },
  {
    id: 'claude-3-5-haiku',
    provider: 'anthropic',
    aliases: ['claude-3.5-haiku', 'claude-haiku', 'claude-haiku-4', 'claude-3-haiku'],
    label: 'Claude 3.5 Haiku',
    contextWindow: 200_000,
    maxOutput: 8_192,
    inputPricePerMTok: 6,
    outputPricePerMTok: 30,
    tokenizer: 'claude',
    strongSchema: true,
    jsonMode: false,
  },
  {
    id: 'gemini-1.5-pro',
    provider: 'google',
    aliases: ['gemini-pro', 'gemini-1.5-pro-latest', 'gemini-2.5-pro', 'gemini-2.0-pro', 'gemini'],
    label: 'Gemini 1.5 Pro',
    contextWindow: 1_000_000,
    maxOutput: 8_192,
    inputPricePerMTok: 9,
    outputPricePerMTok: 36,
    tokenizer: 'gemini',
    strongSchema: true,
    jsonMode: true,
    embeddingModel: 'text-embedding-004',
    embeddingDim: 768,
  },
  {
    id: 'gemini-1.5-flash',
    provider: 'google',
    aliases: ['gemini-flash', 'gemini-1.5-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'],
    label: 'Gemini 1.5 Flash',
    contextWindow: 1_000_000,
    maxOutput: 8_192,
    inputPricePerMTok: 0.5,
    outputPricePerMTok: 2,
    tokenizer: 'gemini',
    strongSchema: true,
    jsonMode: true,
    embeddingModel: 'text-embedding-004',
    embeddingDim: 768,
  },
  {
    id: 'qwen2.5-72b',
    provider: 'openai-compatible',
    aliases: ['qwen', 'qwen2.5', 'qwen-max', 'qwen-plus', 'qwen2.5-72b-instruct', 'glm-4', 'glm4', 'yi-large'],
    label: 'Qwen2.5 72B（兼容端点）',
    contextWindow: 128_000,
    maxOutput: 8_192,
    inputPricePerMTok: 3,
    outputPricePerMTok: 12,
    tokenizer: 'cjk-ratio',
    strongSchema: true,
    jsonMode: true,
  },
  {
    id: 'llama3.1-8b',
    provider: 'ollama',
    aliases: ['llama3.1:8b', 'llama3.1', 'llama3', 'llama', 'mistral', 'phi3', 'phi-3'],
    label: 'Llama 3.1 8B（本地）',
    contextWindow: 128_000,
    maxOutput: 4_096,
    inputPricePerMTok: 0,
    outputPricePerMTok: 0,
    tokenizer: 'llama',
    strongSchema: false,
    jsonMode: true,
    embeddingModel: 'nomic-embed-text',
    embeddingDim: 768,
  },
  {
    id: 'local-weak',
    provider: 'local',
    aliases: ['local', 'tiny', 'smollm'],
    label: '本地小模型（≤7B）',
    contextWindow: 32_000,
    maxOutput: 2_048,
    inputPricePerMTok: 0,
    outputPricePerMTok: 0,
    tokenizer: 'llama',
    strongSchema: false,
    jsonMode: false,
  },
]

/** 未知模型的安全画像：宁可保守（prose + 小窗口），也不要让弱模型吃天书。 */
export const FALLBACK_PROFILE: ModelProfile = {
  id: 'unknown',
  provider: 'local',
  label: '未知模型（保守档）',
  contextWindow: 32_000,
  maxOutput: 2_048,
  /**
   * 未知模型按**最贵档**估：宁可高估成本触发价格闸，也不要把它当成免费。
   * v0.6.0 这里是 0，于是任何未知模型的价格闸永远不触发。
   */
  inputPricePerMTok: 30,
  outputPricePerMTok: 120,
  tokenizer: 'cjk-ratio',
  strongSchema: false,
  jsonMode: false,
  fallback: true,
}

/**
 * 按 id 找画像。支持前缀匹配（`gpt-4o-2024-11-20` → `gpt-4o`），
 * 因为厂商的版本后缀天天变，而能力与价格几乎不变。
 */
/**
 * 厂商家族 → 默认画像（v0.6.1）。
 *
 * 只写厂商名（`deepseek` / `gpt` / `claude`）时，v0.6.0 的双向前缀匹配会给出
 * 不可预测的结果：`gemini` 命中 flash（最弱），`claude` 命中 sonnet（最贵）。
 * 现在改成**显式家族表**：同一个厂商只落一个默认档，行为可解释。
 *
 * `deepseek` 家族特意保留 `strongSchema: true` —— 它家模型都吃得下行式，
 * 落到保守档会让最常见的 `deepseek-v3` 用户被强制 prose，token 涨 2.5×。
 */
const FAMILIES: Array<{ test: RegExp; profile: () => ModelProfile }> = [
  { test: /^deepseek/, profile: () => byId('deepseek-chat') },
  { test: /^(gpt|o1|o3|o4|chatgpt|davinci)/, profile: () => byId('gpt-4o') },
  { test: /^claude/, profile: () => byId('claude-3-5-sonnet') },
  { test: /^gemini/, profile: () => byId('gemini-1.5-pro') },
  { test: /^(qwen|glm|yi|baichuan|internlm|ernie)/, profile: () => byId('qwen2.5-72b') },
  { test: /^(llama|mistral|mixtral|phi|gemma|deepseek-coder)/, profile: () => byId('llama3.1-8b') },
]

function byId(id: string): ModelProfile {
  return MODEL_PROFILES.find((m) => m.id === id) ?? FALLBACK_PROFILE
}

/**
 * 解析模型画像（v0.6.1 重写）。
 *
 * 匹配顺序，每一级都比上一级更宽松，且**每一级都是可解释的**：
 *   1. id 精确相等
 *   2. 别名精确相等（大小写不敏感）—— 厂商改名的真正解法
 *   3. 输入以某个画像 id 开头（最长优先）—— 处理 `gpt-4o-2024-11-20` 这类日期后缀
 *   4. 厂商家族表 —— 只写厂商名时给一个**固定的**默认档
 *   5. 保守档（价格按最贵估）
 *
 * v0.6.0 的第 3 步是**双向**前缀（`m.id.startsWith(key)` 也算命中），
 * 于是 `gemini` → flash、`claude` → sonnet：同样是"只写厂商名"，一个给弱的、一个给贵的。
 * 这条现在被第 4 步的显式表取代。
 */
export function resolveModel(id?: string | null): ModelProfile {
  if (!id) return FALLBACK_PROFILE
  const key = id.trim().toLowerCase()
  if (!key) return FALLBACK_PROFILE

  const exact = MODEL_PROFILES.find((m) => m.id === key)
  if (exact) return exact

  const byAlias = MODEL_PROFILES.find((m) => m.aliases?.some((a) => a.toLowerCase() === key))
  if (byAlias) return byAlias

  const prefix = MODEL_PROFILES.filter((m) => key.startsWith(m.id)).sort((a, b) => b.id.length - a.id.length)[0]
  if (prefix) return prefix

  const fam = FAMILIES.find((f) => f.test.test(key))
  if (fam) {
    // 保留用户写的 id，能力与价格按家族默认档——面板上能看出"你写的是哪个、按谁算的"
    return { ...fam.profile(), id: id.trim() }
  }

  return { ...FALLBACK_PROFILE, id: id.trim(), fallback: true }
}

export interface CompileInput {
  cells: Array<{ cell: MemCell; shortId: string }>
  model?: ModelProfile | null
  /** token 硬预算 */
  maxTokens: number
  /** 单轮记忆注入的价格上限（¥）。undefined = 不限 */
  maxPrice?: number
  /** 请求的格式；实际格式可能因能力/预算降级 */
  mode?: SurfaceMode
  includeLegend?: boolean
  affectLine?: string
  /** 精确计数端口；缺省用启发式 */
  tokenizer?: TokenizerPort | null
}

export interface CompileOutput extends RenderOutput {
  /** 实际使用的模型 */
  model: string
  /** 估算成本（¥） */
  cost: number
  /** 降级原因（空数组 = 一次到位） */
  reasons: string[]
  /** 是否满足所有闸门 */
  fits: boolean
  /** 因预算被丢掉的条数 */
  droppedByBudget: number
  /**
   * 是否因为闸门而**一条都没发**（v0.6.1）。
   *
   * `fits` 只回答"输出在不在限制内"——空输出当然在限制内，所以它是 true。
   * 但调用方真正想知道的是"我这次是不是什么都没拿到、以及是不是预算害的"，
   * 那是 `suppressed`。v0.6.0 没有这个字段，测试只好用 `fits=false` 代替，
   * 于是断言的是报告字段而不是行为——正是审计稿点名的那种"测试绕过"。
   */
  suppressed: boolean
}

/** 成本估算：只算输入侧（记忆注入是纯输入）。 */
export function estimateCost(tokens: number, model: ModelProfile): number {
  return (tokens / 1_000_000) * model.inputPricePerMTok
}

/**
 * 编译上下文。
 *
 * 顺序是刻意的：**先按能力定格式，再按预算丢条目**。
 * 反过来（先丢再降格式）会得到"只剩 2 条但用了 2.5× token"的荒谬结果。
 */
export function compileContext(input: CompileInput): CompileOutput {
  const model = input.model ?? FALLBACK_PROFILE
  const reasons: string[] = []

  // ① 能力闸：弱模型直接 prose
  let mode: SurfaceMode = input.mode ?? 'rows'
  if (!model.strongSchema && mode !== 'prose') {
    reasons.push(`模型 ${model.id} 不支持结构化行式，降级 prose`)
    mode = 'prose'
  }

  const priceCap = input.maxPrice
  const over = (o: RenderOutput) =>
    o.tokens > input.maxTokens || (priceCap !== undefined && estimateCost(o.tokens, model) > priceCap)

  // ② 格式闸：token 超预算时先换更省的格式（价格超了换格式没用，直接进裁剪）
  let out = renderWith(mode, input, priceCap, model)
  if (out.tokens > input.maxTokens && mode === 'rows') {
    const compact = renderWith('compact', input, priceCap, model)
    if (compact.tokens < out.tokens) {
      reasons.push(`行式 ${out.tokens} > 预算 ${input.maxTokens}，切列式 ${compact.tokens}`)
      mode = 'compact'
      out = compact
    }
  }

  const legendDropped = (out as RenderOutput & { legendDropped?: boolean }).legendDropped === true
  if (legendDropped) {
    reasons.push('预算不足以承担图例，本轮不注入记忆（rows=0）')
  }

  // ③ token 闸：报告实际裁剪量（不只是"超了"）
  if (out.tokens > input.maxTokens) {
    reasons.push(`token ${out.tokens} > 预算 ${input.maxTokens}，裁剪到 ${out.rows} 条`)
  }

  // ④ 价格闸：**真的裁剪**（v0.6.0 这里只 push 了一条 reason，没有改 out）
  const cost = estimateCost(out.tokens, model)
  if (priceCap !== undefined && cost > priceCap) {
    reasons.push(`成本 ${fmtCost(cost)} > 上限 ${fmtCost(priceCap)}，裁剪到 ${out.rows} 条`)
  }

  return {
    ...out,
    model: model.id,
    cost: estimateCost(out.tokens, model),
    reasons,
    fits: !over(out),
    droppedByBudget: input.cells.length - out.rows,
    suppressed: out.rows === 0 && input.cells.length > 0,
  }
}

/**
 * 渲染 + 双闸裁剪（v0.6.1）。
 *
 * 这里同时受 **token 上限** 与 **价格上限** 约束，两者共用同一条裁剪路径：
 * 从尾部一条一条丢，直到两个闸都满足，或者只剩图例（rows = 0）。
 *
 * v0.6.0 的写法是"先按 token 裁完，再判断价格并 push 一条 reason"——
 * 于是 `maxPrice=0` 时仍然发 10 条 / 319 token / ¥0.0057，而 reasons 里写着"按价格裁剪"。
 * 承诺与实现背离，且测试只断言了 `fits=false`（字段），没断言 `rows` 变小（行为）。
 */
function renderWith(mode: SurfaceMode, input: CompileInput, priceCap: number | undefined, model: ModelProfile): RenderOutput {
  const maxTokens = input.maxTokens
  const count = (o: RenderOutput) => (input.tokenizer ? input.tokenizer.count(o.text) : o.tokens)
  const over = (o: RenderOutput) =>
    count(o) > maxTokens || (priceCap !== undefined && estimateCost(count(o), model) > priceCap)

  const build = (n: number): RenderOutput => {
    const raw = renderSurface({
      cells: input.cells.slice(0, n),
      mode,
      includeLegend: input.includeLegend ?? true,
      maxTokens,
      affectLine: input.affectLine,
    })
    // renderSurface 会按启发式再裁一次，用 rows 回读真实保留条数
    return { ...raw, tokens: count(raw) }
  }

  let out = build(input.cells.length)
  // 最多丢到 0 条；`cells.length + 2` 是宽松上界，避免死循环
  let guard = 0
  const limit = input.cells.length + 2
  while (over(out) && out.rows > 0 && guard++ < limit) {
    out = build(out.rows - 1)
  }
  /**
   * 连图例都承担不起时，**不发**（v0.6.1）。
   *
   * 图例本身约 140 token；gpt-4o 上那是 ¥0.0025。所以"每轮不超过 ¥0.0003"
   * 这种预算在贵模型上永远满足不了——不处理的话 `fits` 恒 false、
   * 而用户仍会收到一段只有图例的注入，白花钱。
   * 现在的语义是：预算不够就一条都不发（rows=0，text=''），如实报告。
   */
  if (out.rows === 0 && over(out)) {
    return { text: '', tokens: 0, rows: 0, dropped: input.cells.length, mode, legendDropped: true } as RenderOutput & { legendDropped: boolean }
  }
  return out
}

function fmtCost(x: number): string {
  if (x === 0) return '¥0'
  if (x < 0.0001) return `¥${(x * 1_000_000).toFixed(2)}/M`
  return `¥${x.toFixed(6)}`
}

/**
 * 面板"引擎"卡片的编译预览：同一批记忆在 5 个模型下分别要多少 token / 多少钱。
 * 这是 `compile()` 的产品化形态——用户不需要读文档就能看出"换模型会怎样"。
 */
export function previewAcrossModels(
  cells: Array<{ cell: MemCell; shortId: string }>,
  maxTokens: number,
  models: ModelProfile[] = MODEL_PROFILES.slice(0, 6),
): Array<{ id: string; label: string; tokens: number; cost: number; mode: SurfaceMode; fits: boolean }> {
  return models.map((m) => {
    const r = compileContext({ cells, model: m, maxTokens })
    return { id: m.id, label: m.label, tokens: r.tokens, cost: r.cost, mode: r.mode, fits: r.fits }
  })
}

/** 供 UI 直接显示的预算摘要。 */
export function budgetSummary(tokens: number, model: ModelProfile): string {
  return `${tokens} tok · ${estimateCost(tokens, model).toFixed(6)} 元/轮`
}

export { estimateTokens }
