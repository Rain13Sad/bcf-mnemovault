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
    id: 'claude-3-5-sonnet',
    provider: 'anthropic',
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
  inputPricePerMTok: 0,
  outputPricePerMTok: 0,
  tokenizer: 'cjk-ratio',
  strongSchema: false,
  jsonMode: false,
}

/**
 * 按 id 找画像。支持前缀匹配（`gpt-4o-2024-11-20` → `gpt-4o`），
 * 因为厂商的版本后缀天天变，而能力与价格几乎不变。
 */
export function resolveModel(id?: string | null): ModelProfile {
  if (!id) return FALLBACK_PROFILE
  const key = id.toLowerCase()
  const exact = MODEL_PROFILES.find((m) => m.id === key)
  if (exact) return exact
  // 最长前缀优先，避免 'gpt-4o-mini' 被 'gpt-4o' 抢走
  const prefix = MODEL_PROFILES.filter((m) => key.startsWith(m.id) || m.id.startsWith(key)).sort(
    (a, b) => b.id.length - a.id.length,
  )[0]
  return prefix ?? { ...FALLBACK_PROFILE, id }
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

  // ② token 闸：先换更省的格式，再丢条目
  let out = renderWith(mode, input)
  if (out.tokens > input.maxTokens && mode === 'rows') {
    const compact = renderWith('compact', input)
    if (compact.tokens < out.tokens) {
      reasons.push(`行式 ${out.tokens} > 预算 ${input.maxTokens}，切列式 ${compact.tokens}`)
      mode = 'compact'
      out = compact
    }
  }

  // ③ 价格闸：预算之内仍可能太贵（贵模型的 320 token ≈ ¥0.006）
  if (input.maxPrice !== undefined && estimateCost(out.tokens, model) > input.maxPrice) {
    reasons.push(`成本 ${fmtCost(estimateCost(out.tokens, model))} > 上限 ${fmtCost(input.maxPrice)}，按价格裁剪`)
  }

  return {
    ...out,
    model: model.id,
    cost: estimateCost(out.tokens, model),
    reasons,
    fits: out.tokens <= input.maxTokens && (input.maxPrice === undefined || estimateCost(out.tokens, model) <= input.maxPrice),
    droppedByBudget: input.cells.length - out.rows,
  }
}

function renderWith(mode: SurfaceMode, input: CompileInput): RenderOutput {
  const maxTokens = input.maxTokens
  if (!input.tokenizer) {
    return renderSurface({
      cells: input.cells,
      mode,
      includeLegend: input.includeLegend ?? true,
      maxTokens,
      affectLine: input.affectLine,
    })
  }
  // 有精确 tokenizer 时：先按启发式裁剪，再用精确口径复核一次，
  // 差多少补裁多少。这样既保持字节稳定，又不会因口径差异超预算。
  let out = renderSurface({
    cells: input.cells,
    mode,
    includeLegend: input.includeLegend ?? true,
    maxTokens,
    affectLine: input.affectLine,
  })
  let guard = 0
  while (input.tokenizer.count(out.text) > maxTokens && out.rows > 0 && guard++ < 64) {
    const keep = out.rows - 1
    out = renderSurface({
      cells: input.cells.slice(0, keep),
      mode,
      includeLegend: input.includeLegend ?? true,
      maxTokens,
      affectLine: input.affectLine,
    })
  }
  return { ...out, tokens: input.tokenizer.count(out.text) }
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
