/**
 * Provider 预设表（v0.6）
 *
 * ── 这张表是"适配常用大模型"的全部内容 ──────────────────────────
 * 不是 if/else 分支，而是数据。新增一家模型 = 加一行；改端点 = 改一行字符串。
 * 每条都写清三件事：**端点长什么样、鉴权怎么带、能力边界在哪**。
 *
 * ── 关于 embedding 的诚实说明 ────────────────────────────────────
 * 不是所有家都有 embedding 端点：
 *   · DeepSeek：截至本版，公开 API 只有 chat（`/chat/completions`），没有 embeddings
 *   · Anthropic：同样只有 messages，没有 embedding 端点
 *   · Google / OpenAI / Ollama：都有
 * 所以 `embedPath: null` 是**事实**，不是没做。要用真 embedding 时：
 * 选一个有端点的一家（openai / google / ollama），或者用 `openai-compatible`
 * 指向你自己的推理服务。这条写进了面板的"限制"清单，不做静默降级。
 */

import type { ModelProvider, TokenizerKind } from '@rain13sad/dsh-mnemo-core'

export type AuthStyle = 'bearer' | 'x-api-key' | 'query-key' | 'none'

export interface ProviderSpec {
  id: string
  label: string
  provider: ModelProvider
  /** 默认 base URL（不含末尾斜杠） */
  baseUrl: string
  /** chat 端点（相对 baseUrl）。null = 不支持 */
  chatPath: string | null
  /** embedding 端点。null = 这家没有公开端点 */
  embedPath: string | null
  auth: AuthStyle
  /** 鉴权头名称（bearer 时是 Authorization） */
  authHeader?: string
  /** query-key 时参数名 */
  authQuery?: string
  defaultModel: string
  defaultEmbeddingModel?: string
  embeddingDim?: number
  tokenizer: TokenizerKind
  /** 结构化输出方式：response_format / 靠提示词 / 不支持 */
  jsonMode: 'response_format' | 'prompt' | 'none'
  /** 默认读哪个环境变量 */
  apiKeyEnv: string
  /** 一句话边界说明（进面板"限制"清单） */
  note: string
}

export const PROVIDERS: Record<string, ProviderSpec> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    chatPath: '/chat/completions',
    embedPath: null,
    auth: 'bearer',
    defaultModel: 'deepseek-chat',
    tokenizer: 'cjk-ratio',
    jsonMode: 'response_format',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    note: '公开 API 只有 chat，没有 embedding 端点；要真 embedding 请用 openai-compatible 指到自建服务',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    embedPath: '/embeddings',
    auth: 'bearer',
    defaultModel: 'gpt-4o-mini',
    defaultEmbeddingModel: 'text-embedding-3-small',
    embeddingDim: 1536,
    tokenizer: 'cl100k',
    jsonMode: 'response_format',
    apiKeyEnv: 'OPENAI_API_KEY',
    note: 'embedding 端点可用；注意跨境网络与合规要求',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    chatPath: '/messages',
    embedPath: null,
    auth: 'x-api-key',
    authHeader: 'x-api-key',
    defaultModel: 'claude-3-5-haiku',
    tokenizer: 'claude',
    jsonMode: 'prompt',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    note: '没有 embedding 端点；JSON 输出靠提示词约束，解析失败率略高于 response_format',
  },
  google: {
    id: 'google',
    label: 'Google Gemini',
    provider: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    chatPath: '/models/{model}:generateContent',
    embedPath: '/models/{model}:embedContent',
    auth: 'query-key',
    authQuery: 'key',
    defaultModel: 'gemini-1.5-flash',
    defaultEmbeddingModel: 'text-embedding-004',
    embeddingDim: 768,
    tokenizer: 'gemini',
    jsonMode: 'response_format',
    apiKeyEnv: 'GEMINI_API_KEY',
    note: '鉴权走 query 参数；embedding 端点可用',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama（本地）',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    chatPath: '/api/chat',
    embedPath: '/api/embeddings',
    auth: 'none',
    defaultModel: 'llama3.1:8b',
    defaultEmbeddingModel: 'nomic-embed-text',
    embeddingDim: 768,
    tokenizer: 'llama',
    jsonMode: 'prompt',
    apiKeyEnv: '',
    note: '完全离线、零密钥；小模型建议 surfaceMode=prose',
  },
  'openai-compatible': {
    id: 'openai-compatible',
    label: 'OpenAI 兼容端点',
    provider: 'openai-compatible',
    baseUrl: '',
    chatPath: '/chat/completions',
    embedPath: '/embeddings',
    auth: 'bearer',
    defaultModel: 'qwen2.5-72b-instruct',
    defaultEmbeddingModel: 'bge-m3',
    embeddingDim: 1024,
    tokenizer: 'cjk-ratio',
    jsonMode: 'response_format',
    apiKeyEnv: 'OPENAI_API_KEY',
    note: '必须显式填 baseUrl（如 https://api.siliconflow.cn/v1）；embedding 是否可用取决于后端',
  },
}

export const PROVIDER_IDS = Object.keys(PROVIDERS)

/** 未知 id 时退回 openai-compatible（它是唯一"必须自己填端点"的形态，不会假装能用）。 */
export function resolveProvider(id?: string | null, baseUrl?: string): ProviderSpec {
  const spec = (id && PROVIDERS[id]) || PROVIDERS['openai-compatible']
  if (baseUrl && baseUrl.trim()) return { ...spec, baseUrl: baseUrl.replace(/\/+$/, '') }
  return spec
}

/** 端点模板：`{model}` 会被替换（Gemini 的路径里带模型名）。 */
export function endpointOf(spec: ProviderSpec, kind: 'chat' | 'embed', model: string): string | null {
  const path = kind === 'chat' ? spec.chatPath : spec.embedPath
  if (!path) return null
  return spec.baseUrl.replace(/\/+$/, '') + path.replace('{model}', encodeURIComponent(model))
}

/** 鉴权头。没有密钥时返回空对象——本地模型不需要密钥，这不是错误。 */
export function authHeaders(spec: ProviderSpec, apiKey: string): Record<string, string> {
  if (spec.auth === 'none' || !apiKey) return {}
  if (spec.auth === 'bearer') return { Authorization: `Bearer ${apiKey}` }
  if (spec.auth === 'x-api-key') return { [spec.authHeader ?? 'x-api-key']: apiKey }
  return {}
}

/** query-key 鉴权的 URL 拼装（Gemini）。 */
export function withQueryKey(url: string, spec: ProviderSpec, apiKey: string): string {
  if (spec.auth !== 'query-key' || !apiKey) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}${spec.authQuery ?? 'key'}=${encodeURIComponent(apiKey)}`
}
