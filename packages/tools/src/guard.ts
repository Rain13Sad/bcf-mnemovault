/**
 * egress 守卫（对应 §17.3，修 D-10）
 *
 * v0.1 用全库子串匹配：100 万 cell 上每次工具调用扫一遍，延迟不可接受。
 * 这里改成 3-gram Bloom + 敏感实体指纹集，扫描成本 O(len(args))。
 *
 * 守卫必须 fail-closed（不确定就拒绝），不是 fail-open。
 */

import type { MemoryService } from '@bcf/dsh-mnemo-core'
import { FLAG } from '@bcf/dsh-mnemo-core'

const EGRESS_TOOL = /(^|_)(web|fetch|http|search|mail|upload|post|publish|browser|curl|http_request)(_|$)/i

export function isEgressTool(name: string): boolean {
  return EGRESS_TOOL.test(name)
}

const PII_PATTERNS: RegExp[] = [
  /\b1[3-9]\d{9}\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /\b\d{17}[\dXx]\b/,
  /\b(sk|pk|rk)-[A-Za-z0-9]{12,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
]

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
      for (const re of PII_PATTERNS) {
        if (re.test(text)) return { blocked: true, reason: `Blocked: 参数中含敏感实体（${re.source.slice(0, 24)}…）` }
      }
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
