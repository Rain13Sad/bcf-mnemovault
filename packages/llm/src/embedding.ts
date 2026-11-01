/**
 * HTTP Embedding 端口（v0.6）
 *
 * 把"任意 OpenAI 兼容 / Gemini / Ollama 的向量端点"适配成内核认的
 * `EmbeddingPort`。三件事决定了它的形态：
 *
 * ① **必须同步可读**（`peek`）
 *    内核的 `recall()` 是同步的（确定性重放依赖它），所以向量由异步侧预热、
 *    同步侧从缓存取。取不到就退回哈希——**降级而不阻塞**。
 *
 * ② **必须 L2 归一化**
 *    不同厂商返回的向量模长差 3 个数量级（OpenAI 已归一，BGE 没有）。
 *    内核用余弦相似度，归一化之后 int8 量化才不会把小模长向量压成全 0。
 *
 * ③ **必须标空间**（`space`）
 *    `provider:openai:text-embedding-3-small` 与 `provider:ollama:nomic-embed-text`
 *    是两个**不可比**的向量空间。换模型 = 全库重算，这不是缺陷，是 dense 路线的
 *    固有成本。把空间写进端口，`engine.status()` 才能拦住混用。
 */

import type { EmbeddingPort } from '@rain13sad/dsh-mnemo-core'
import { HttpError, postJson, type HttpOptions } from './http.js'
import { authHeaders, endpointOf, resolveProvider, withQueryKey, type ProviderSpec } from './providers.js'

export interface HttpEmbeddingOptions extends HttpOptions {
  /** provider id 或完整 spec */
  provider: string | ProviderSpec
  model?: string
  apiKey?: string
  /** 缓存条目上限。默认 2048 条 ≈ 2048 × 1536 × 4 B ≈ 12 MB，够一整轮会话 */
  cacheSize?: number
}

export class HttpEmbeddingProvider implements EmbeddingPort {
  readonly name: string
  readonly space: string
  readonly dim?: number
  private readonly spec: ProviderSpec
  private readonly model: string
  private readonly apiKey: string
  private readonly opts: HttpOptions
  private readonly cacheSize: number
  private readonly cache = new Map<string, Float32Array>()
  private lastError: string | null = null

  constructor(o: HttpEmbeddingOptions) {
    this.spec = typeof o.provider === 'string' ? resolveProvider(o.provider) : o.provider
    this.model = o.model?.trim() || this.spec.defaultEmbeddingModel || 'text-embedding-3-small'
    this.apiKey = o.apiKey ?? ''
    this.dim = this.spec.embeddingDim
    this.cacheSize = o.cacheSize ?? 2048
    this.opts = { timeoutMs: o.timeoutMs, retries: o.retries, fetchImpl: o.fetchImpl }
    this.name = `${this.spec.id}:${this.model}`
    // 空间里带模型名：换模型必须重算全库，这一点不能靠记忆
    this.space = `provider:${this.spec.id}:${this.model}`
  }

  async embed(text: string): Promise<Float32Array> {
    const key = cacheKey(text)
    const hit = this.cache.get(key)
    if (hit) {
      // LRU：命中即移到队尾
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const url = endpointOf(this.spec, 'embed', this.model)
    if (!url) throw new HttpError(`${this.spec.label} 没有 embedding 端点`, 0, '', '')
    const finalUrl = withQueryKey(url, this.spec, this.apiKey)
    const body = this.bodyOf(text)
    const json = await postJson<unknown>(finalUrl, body, { ...this.opts, headers: authHeaders(this.spec, this.apiKey) })
    const vec = parseEmbedding(json, this.spec.id)
    if (!vec || vec.length === 0) {
      this.lastError = `响应里没有向量：${JSON.stringify(json).slice(0, 160)}`
      throw new HttpError(this.lastError, 0, finalUrl, '')
    }
    const norm = l2(vec)
    this.remember(key, norm)
    return norm
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // 逐条走缓存 + 并发（小批量）：批量端点的响应顺序在个别兼容实现里不保证，
    // 逐条虽然多几个 RTT，但**不会把向量配错记忆**。这里选择正确性。
    return Promise.all(texts.map((t) => this.embed(t)))
  }

  peek(text: string): Float32Array | null {
    return this.cache.get(cacheKey(text)) ?? null
  }

  async prime(texts: string[]): Promise<number> {
    let n = 0
    for (const t of texts) {
      if (!t.trim()) continue
      if (this.cache.has(cacheKey(t))) continue
      try {
        await this.embed(t)
        n++
      } catch {
        // 预热失败不算错：同步侧会退回哈希
        break
      }
    }
    return n
  }

  get error(): string | null {
    return this.lastError
  }

  /** 面板"连通性探测"用：发一次最小请求，返回维度。 */
  async health(): Promise<{ ok: boolean; message: string; dim: number }> {
    try {
      const v = await this.embed('健康检查')
      return { ok: true, message: `${this.spec.label} · ${this.model} · ${v.length} 维`, dim: v.length }
    } catch (err) {
      this.lastError = String((err as Error)?.message ?? err)
      return { ok: false, message: this.lastError, dim: 0 }
    }
  }

  private bodyOf(text: string): Record<string, unknown> {
    if (this.spec.id === 'ollama') return { model: this.model, prompt: text }
    if (this.spec.id === 'google') return { model: `models/${this.model}`, content: { parts: [{ text }] } }
    return { model: this.model, input: text }
  }

  private remember(key: string, vec: Float32Array): void {
    this.cache.set(key, vec)
    while (this.cache.size > this.cacheSize) {
      const first = this.cache.keys().next()
      if (first.done) break
      this.cache.delete(first.value)
    }
  }
}

/** 缓存键：原文太长时截断（超过 2000 字符的段落语义已饱和）。 */
function cacheKey(text: string): string {
  const t = text.trim().slice(0, 2000)
  let h = 0x811c9dc5
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${t.length}:${h.toString(16)}`
}

/** 三种响应形态：OpenAI `data[].embedding` / Ollama `embedding` / Gemini `embedding.values`。 */
export function parseEmbedding(json: unknown, providerId = 'openai'): Float32Array | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const asVec = (x: unknown): Float32Array | null => {
    if (!Array.isArray(x) || x.length === 0) return null
    const out = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) {
      const n = typeof x[i] === 'number' ? (x[i] as number) : Number(x[i])
      if (!Number.isFinite(n)) return null
      out[i] = n
    }
    return out
  }
  // OpenAI 兼容
  const data = o.data
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown> | undefined
    const v = asVec(first?.embedding)
    if (v) return v
  }
  // Ollama /api/embeddings
  const direct = asVec(o.embedding)
  if (direct) return direct
  // Gemini
  const emb = o.embedding as Record<string, unknown> | undefined
  const values = asVec(emb?.values)
  if (values) return values
  // 有些兼容端点返回 {embeddings: [[...]]}
  const list = o.embeddings
  if (Array.isArray(list) && list.length > 0) {
    const v = asVec((list[0] as Record<string, unknown>)?.embedding ?? list[0])
    if (v) return v
  }
  void providerId
  return null
}

/** L2 归一化。零向量原样返回（由调用方判空）。 */
export function l2(v: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  if (s === 0) return v
  const inv = 1 / Math.sqrt(s)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}
