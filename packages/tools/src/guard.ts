/**
 * egress 守卫（对应 §17.3，修 D-10）
 *
 * v0.1 用全库子串匹配：100 万 cell 上每次工具调用扫一遍，延迟不可接受。
 * 这里改成 3-gram Bloom + 敏感实体指纹集，扫描成本 O(len(args))。
 *
 * 守卫必须 fail-closed（不确定就拒绝），不是 fail-open。
 */

import type { MemoryService } from '@rain13sad/dsh-mnemo-core'
import { FLAG } from '@rain13sad/dsh-mnemo-core'

/**
 * 允许携带记忆内容的工具（白名单）。
 *
 * ── v0.3.1 把守卫从 fail-open 改成 fail-closed ──────────────────
 * 旧实现是一条正则：
 *   /(^|_)(web|fetch|http|search|mail|upload|post|publish|browser|curl)(_|$)/i
 * 它只认下划线分词，于是 `webSearch`、`WebSearch`、`execute_shell`、`write_file`、
 * `send_email` 全部放行——注释写着"fail-closed"，行为是 fail-open。
 *
 * 现在反过来：**只有明确安全的工具不扫，其余一律扫**。
 * 这是有代价的（一次误报会挡住一次正常调用），但外发是不可撤销的，
 * 而误报最多是让用户重说一句。这条权衡与 §19.1 的隔离要求一致。
 */
const SAFE_TOOLS = new Set([
  'memory_recall',
  'memory_expand',
  'memory_assert',
  'memory_forget',
  'memory_stats',
  'affect_report',
  'mnemo_command',
  // 纯本地、不回传的只读工具（宿主通常有同名工具）
  'todo_write',
  'todo_read',
  'ask_user',
  'ask_user_question',
])

/** 拆词：同时支持 snake_case / kebab-case / camelCase / PascalCase。 */
export function toolSegments(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.:/]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean)
}

/** 用于面板/诊断展示的"外发类别"，不参与放行判定。 */
const EGRESS_HINTS: Array<[string, RegExp]> = [
  ['web', /^(web|fetch|http|https|request|curl|wget|browser|crawl|scrape|search|url)$/],
  ['mail', /^(mail|email|smtp|imap|send|message|notify|tweet|post|publish|upload|share)$/],
  ['shell', /^(shell|exec|execute|terminal|bash|sh|cmd|powershell|run|spawn|process)$/],
  ['fs', /^(write|edit|patch|file|fs|save|delete|rm|move|copy)$/],
  ['net', /^(net|socket|rpc|grpc|webhook|hook)$/],
]

export function egressKind(name: string): string | null {
  if (!name || SAFE_TOOLS.has(name)) return null
  for (const seg of toolSegments(name)) {
    for (const [kind, re] of EGRESS_HINTS) if (re.test(seg)) return kind
  }
  return 'unknown'
}

/**
 * 是否需要在调用前扫描参数。
 * **白名单之外一律返回 true**——包括不认识的工具名。
 */
export function isEgressTool(name: string): boolean {
  if (!name) return false
  return !SAFE_TOOLS.has(name)
}

/**
 * 会**阻断**的 PII 指纹。
 *
 * 刻意不收 IP / Bearer / URL token：
 *   · IP 在 URL 里完全正常，收进来会把 `web_fetch('http://10.0.0.5/health')` 也拦掉
 *   · Bearer 与 URL token 是**合法外发的凭据**（调 API 就得带），拦掉等于禁掉所有鉴权请求
 * 这三类由 `redact()` 在**入库**时处理，而不是在出口处误伤正常调用。
 */
const PII_PATTERNS: RegExp[] = [
  /\b1[3-9]\d{9}\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b\d{17}[\dXx]\b/,
  /\b(sk|pk|rk)-[A-Za-z0-9]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // 银行卡：13–19 位且过 Luhn（避免把订单号当卡号）
  /\b(?:\d[ -]?){12,18}\d\b/,
]

function luhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

/** 返回命中的 PII 类型名，没有则 null。 */
export function piiKind(text: string): string | null {
  for (const re of PII_PATTERNS) {
    const m = text.match(re)
    if (!m) continue
    if (re.source.includes('12,18')) {
      if (!luhn(m[0].replace(/[ -]/g, ''))) continue
      return 'bank_card'
    }
    if (/1\[3-9\]/.test(re.source)) return 'phone'
    if (/@/.test(re.source)) return 'email'
    if (/17/.test(re.source)) return 'id_card'
    if (/PRIVATE KEY/.test(re.source)) return 'pem'
    return 'secret'
  }
  return null
}

/** 3-gram Bloom：位数组 + 两个哈希。误报率随容量上升，宁可误报（fail-closed）。 */
export class NgramBloom {
  private bits: Uint32Array
  private readonly m: number
  count = 0

  constructor(bits = 1 << 20) {
    this.m = bits
    this.bits = new Uint32Array(Math.ceil(bits / 32))
  }

  private hash(s: string, seed: number): number {
    let h = seed
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h % this.m
  }

  add(s: string): void {
    if (s.length < 3) return
    for (let i = 0; i + 3 <= s.length; i++) {
      const g = s.slice(i, i + 3)
      for (const seed of [0x9e3779b9, 0x85ebca6b]) {
        const b = this.hash(g, seed)
        this.bits[b >>> 5] |= 1 << (b & 31)
      }
    }
    this.count++
  }

  has(g: string): boolean {
    for (const seed of [0x9e3779b9, 0x85ebca6b]) {
      const b = this.hash(g, seed)
      if ((this.bits[b >>> 5] & (1 << (b & 31))) === 0) return false
    }
    return true
  }

  /** 返回命中的 gram 数（不是布尔）：连续命中越多，越可能是真片段而不是巧合。 */
  scan(text: string): number {
    if (text.length < 3) return 0
    let hits = 0
    for (let i = 0; i + 3 <= text.length; i++) if (this.has(text.slice(i, i + 3))) hits++
    return hits
  }
}

export interface EgressGuard {
  scan(args: unknown): { blocked: boolean; reason?: string }
  rebuild(): void
  dispose(): void
}

/** 敏感 cell：含 PII，或用户来源且 importance 高。不扫全库——只扫这一小撮。 */
export function sensitiveTexts(memory: MemoryService, limit = 5000): string[] {
  const out: string[] = []
  memory.store.forEachCell((c) => {
    if (out.length >= limit) return
    // 用户自己说过的话默认就该被保护：不设 importance 门槛，
    // 否则一条普通偏好（importance≈0.5）能大摇大摆走出网。
    const sensitive = (c.flags & FLAG.pii) !== 0 || c.provenance === 0
    if (!sensitive) return
    if (c.digest) out.push(c.digest)
    for (const s of c.slots) if (s.type === 'LIT' && s.value.length >= 3) out.push(s.value)
  })
  return out
}

export function buildGuard(memory: MemoryService, opts: { minGrams?: number } = {}): EgressGuard {
  const minGrams = opts.minGrams ?? 6
  let bloom = new NgramBloom()
  let builtAt = -1

  const rebuild = () => {
    bloom = new NgramBloom()
    for (const t of sensitiveTexts(memory)) bloom.add(t.toLowerCase())
    builtAt = memory.store.countCells()
  }
  rebuild()

  return {
    scan(args: unknown) {
      // 惰性重建：守卫在插件装载时建立，那时库还是空的。
      // 用 cell 数做脏标记，比每次全量重建便宜得多，也比"只在装载时建一次"正确。
      const n = memory.store.countCells()
      if (n !== builtAt) rebuild()
      const text = typeof args === 'string' ? args : JSON.stringify(args ?? '')
      const lower = text.toLowerCase()
      const pii = piiKind(text)
      if (pii) return { blocked: true, reason: `Blocked: 参数中含敏感实体（${pii}）` }
      const hits = bloom.scan(lower)
      if (hits >= minGrams) {
        return { blocked: true, reason: `Blocked: 参数疑似包含记忆内容（${hits} 个 3-gram 命中）` }
      }
      return { blocked: false }
    },
    rebuild,
    dispose() {
      bloom = new NgramBloom(32)
    },
  }
}
