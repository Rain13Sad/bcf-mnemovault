/**
 * 极简 HTTP 客户端（v0.6）
 *
 * 只用内置 `fetch` + `AbortController`：**零第三方依赖**是 v0.1 起的承诺，
 * 换 embedding 模型不该把它换成"要装 200 MB 的 SDK"。
 *
 * 三条纪律：
 *   1. **一定有超时**。没有超时的 HTTP 调用会把整轮对话挂住——
 *      而记忆注入是"锦上添花"，不是"没有就不行"，所以宁可不给也不能卡。
 *   2. **只重试幂等请求**。embedding / 抽取都是幂等的，重试安全；
 *      重试 4xx 没有意义（密钥错就是错）。
 *   3. **错误要带上下文**。`HttpError` 里有 status / 端点 / 响应片段，
 *      这样面板上的"最近一次失败"能直接指向原因，而不是一句 `fetch failed`。
 */

export interface HttpOptions {
  timeoutMs?: number
  retries?: number
  headers?: Record<string, string>
  /** 测试注入点。默认用全局 fetch */
  fetchImpl?: typeof fetch
}

export class HttpError extends Error {
  readonly status: number
  readonly url: string
  readonly body: string

  constructor(message: string, status: number, url: string, body: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
  }
}

const DEFAULT_TIMEOUT = 15_000

export async function postJson<T = unknown>(url: string, body: unknown, opts: HttpOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
  const retries = Math.max(0, opts.retries ?? 1)
  const doFetch = opts.fetchImpl ?? fetch
  let lastErr: unknown = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok) {
        const err = new HttpError(`HTTP ${res.status} @ ${shortUrl(url)}：${snippet(text)}`, res.status, url, text)
        // 4xx 是"你的请求不对"，重试不会变对
        if (res.status >= 400 && res.status < 500) throw err
        lastErr = err
      } else {
        return parseJson<T>(text, url)
      }
    } catch (err) {
      lastErr = err
      if (err instanceof HttpError && err.status >= 400 && err.status < 500) throw err
      // 最后一次不再退避，直接抛
      if (attempt === retries) break
      await sleep(120 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  if (lastErr instanceof Error) throw lastErr
  throw new HttpError('请求失败（未知原因）', 0, url, '')
}

function parseJson<T>(text: string, url: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(`响应不是 JSON @ ${shortUrl(url)}：${snippet(text)}`, 0, url, text)
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url.slice(0, 60)
  }
}

function snippet(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > 180 ? t.slice(0, 180) + '…' : t
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
