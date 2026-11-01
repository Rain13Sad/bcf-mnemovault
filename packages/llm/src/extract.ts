/**
 * LLM 抽取端口（v0.6）
 *
 * 把"一段自然语言"变成"结构化命题"。这是 v0.5 之前最大的质量天花板：
 * 规则抽取的谓词表是封闭的，用户说"我们改主意了，不用 pnpm 了"时，
 * 只有 `changes` 一个家族能命中，而"改主意"这件事本身没有谓词。
 *
 * ── 三条设计约束 ────────────────────────────────────────────────
 * ① **必须能失败**。返回 `null` 而不是抛错——调用方（encoder）据此回落到规则路径。
 *    抽取是增强，不是前置依赖；它挂了不该让整轮对话失败。
 * ② **必须校验**。模型会给多余字段、字符串数字、越界值、markdown 包裹。
 *    一律过 `sanitizeFacts()`，宁少不多。
 * ③ **必须可计量**。每次成功/失败都进计数器，面板显示降级率。
 *    降级率 > 5% 时明确告警——**不做静默退化**是本项目从 v0.5 起的规矩。
 */

import { EXTRACTION_SYSTEM_PROMPT, sanitizeFacts, type ExtractedFact, type ExtractorPort } from '@rain13sad/dsh-mnemo-core'
import { HttpError, postJson, type HttpOptions } from './http.js'
import { authHeaders, endpointOf, resolveProvider, withQueryKey, type ProviderSpec } from './providers.js'

export interface HttpExtractorOptions extends HttpOptions {
  provider: string | ProviderSpec
  model?: string
  apiKey?: string
  /** 单次抽取的 max_tokens。512 足够 12 条命题 */
  maxTokens?: number
}

export class LlmExtractor implements ExtractorPort {
  readonly name: string
  private readonly spec: ProviderSpec
  private readonly model: string
  private readonly apiKey: string
  private readonly maxTokens: number
  private readonly opts: HttpOptions
  private lastError: string | null = null

  constructor(o: HttpExtractorOptions) {
    this.spec = typeof o.provider === 'string' ? resolveProvider(o.provider) : o.provider
    this.model = o.model?.trim() || this.spec.defaultModel
    this.apiKey = o.apiKey ?? ''
    this.maxTokens = o.maxTokens ?? 512
    this.opts = { timeoutMs: o.timeoutMs, retries: o.retries, fetchImpl: o.fetchImpl }
    this.name = `${this.spec.id}:${this.model}`
  }

  async extract(input: { text: string; timeoutMs?: number; speaker?: string; turn?: number }): Promise<ExtractedFact[] | null> {
    const text = input.text.trim()
    // 太短的输入不值得一次调用（"好的" / "嗯"），也避免烧钱
    if (text.length < 4) return null
    const url = endpointOf(this.spec, 'chat', this.model)
    if (!url) {
      this.lastError = `${this.spec.label} 没有 chat 端点`
      return null
    }
    try {
      const json = await postJson<unknown>(withQueryKey(url, this.spec, this.apiKey), this.bodyOf(text, input.speaker), {
        ...this.opts,
        timeoutMs: input.timeoutMs ?? this.opts.timeoutMs,
        headers: authHeaders(this.spec, this.apiKey),
      })
      const content = extractText(json, this.spec.id)
      if (!content) {
        this.lastError = '响应里没有文本内容'
        return null
      }
      const facts = parseFacts(content)
      if (facts === null) {
        this.lastError = `JSON 解析失败：${content.slice(0, 120)}`
        return null
      }
      return facts
    } catch (err) {
      this.lastError = err instanceof HttpError ? err.message : String((err as Error)?.message ?? err)
      return null
    }
  }

  get error(): string | null {
    return this.lastError
  }

  private bodyOf(text: string, speaker?: string): Record<string, unknown> {
    const user = speaker ? `[${speaker}] ${text}` : text
    if (this.spec.id === 'anthropic') {
      return {
        model: this.model,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: user }],
        max_tokens: this.maxTokens,
        temperature: 0,
      }
    }
    if (this.spec.id === 'google') {
      return {
        contents: [{ role: 'user', parts: [{ text: `${EXTRACTION_SYSTEM_PROMPT}\n\n---\n${user}` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: this.maxTokens, responseMimeType: 'application/json' },
      }
    }
    if (this.spec.id === 'ollama') {
      return {
        model: this.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      }
    }
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    }
    if (this.spec.jsonMode === 'response_format') body.response_format = { type: 'json_object' }
    return body
  }
}

/** 从各家响应里挖出文本。四条路径，全是实测形状。 */
export function extractText(json: unknown, providerId = 'openai'): string | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  if (providerId === 'anthropic') {
    const content = o.content
    if (Array.isArray(content)) {
      const t = content.map((b) => (b && typeof b === 'object' ? String((b as { text?: string }).text ?? '') : '')).join('')
      if (t.trim()) return t
    }
  }
  if (providerId === 'google') {
    const cands = o.candidates
    if (Array.isArray(cands) && cands.length > 0) {
      const parts = (cands[0] as { content?: { parts?: Array<{ text?: string }> } })?.content?.parts
      const t = (parts ?? []).map((p) => String(p?.text ?? '')).join('')
      if (t.trim()) return t
    }
  }
  if (providerId === 'ollama') {
    const msg = o.message as { content?: string } | undefined
    if (typeof msg?.content === 'string' && msg.content.trim()) return msg.content
  }
  const choices = o.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0] as { message?: { content?: unknown }; text?: unknown }
    const content = c?.message?.content ?? c?.text
    if (typeof content === 'string' && content.trim()) return content
  }
  return null
}

/**
 * 解析模型输出。三种常见形态都要吃：
 *   1. 纯 JSON 数组
 *   2. `{ "facts": [...] }`（json_object 模式下模型会把数组包一层）
 *   3. ```json ... ``` 包裹（Claude / 小模型常见）
 * 返回 null 表示"这不是可用的 JSON"，调用方据此降级。
 */
export function parseFacts(content: string): ExtractedFact[] | null {
  const cleaned = content
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const candidates = [cleaned]
  // 兜底：从第一个 [ 到最后一个 ]
  const lb = cleaned.indexOf('[')
  const rb = cleaned.lastIndexOf(']')
  if (lb >= 0 && rb > lb) candidates.push(cleaned.slice(lb, rb + 1))
  const lo = cleaned.indexOf('{')
  const ro = cleaned.lastIndexOf('}')
  if (lo >= 0 && ro > lo) candidates.push(cleaned.slice(lo, ro + 1))

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown
      if (Array.isArray(parsed)) return sanitizeFacts(parsed)
      if (parsed && typeof parsed === 'object') {
        const o = parsed as Record<string, unknown>
        for (const key of ['facts', 'items', 'results', 'memories', 'data']) {
          if (Array.isArray(o[key])) return sanitizeFacts(o[key])
        }
      }
    } catch {
      // 试下一个候选
    }
  }
  return null
}
