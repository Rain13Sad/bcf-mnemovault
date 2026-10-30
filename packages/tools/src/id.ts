/**
 * 短 id 解析（v0.5.2，修 D23）。
 *
 * ── 为什么要单独一个文件 ──────────────────────────────────────────
 * v0.5.1 里有两份几乎相同的实现：`tools/src/index.ts` 的 `resolveShort`
 * 与 `commands/src` 的 `resolveId`。两份都在**撞车时静默取第一个**：
 *
 * ```ts
 * mem.store.forEachCell((c) => {
 *   if (found) return          // 找到一个就不再找
 *   if (hex.endsWith(clean)) found = hex
 * })
 * ```
 *
 * 短 id 是 16 位 hex 的末 4 位——16⁴ = 65536 种取值。按生日问题，
 * 一个 300 条的库撞车概率约 **50%**；而 `/mnemo forget <id> --hard` 是**不可撤销**的。
 * "静默取第一个"在这个上下文里等价于"我以为删的是 A，删的是 B"。
 *
 * 现在：收集**全部**匹配，多于一条就抛 `AmbiguousCellIdError` 并要求更长前缀。
 * 未命中仍返回补零的 id（调用方原有的"查不到"分支靠它工作），不抛错——
 * 把"没找到"和"有歧义"分开，是这里唯一重要的语义区分。
 */

import { toHex, type MemoryService } from '@rain13sad/dsh-mnemo-core'

/** 短 id 有歧义。消息里直接给出候选，用户复制一个更长的前缀即可。 */
export class AmbiguousCellIdError extends Error {
  constructor(
    readonly short: string,
    readonly matches: string[],
  ) {
    super(
      `短 id "${short}" 命中 ${matches.length} 条记忆，无法确定是哪一条：\n` +
        matches.map((m) => `  · ${m}`).join('\n') +
        `\n请用更长（至少再多一位）的前缀重试。`,
    )
    this.name = 'AmbiguousCellIdError'
  }
}

/** 撞车时最多列几个候选（够用户挑就行，不要把整库打出来） */
const MAX_MATCHES = 8

/**
 * 把 `#a1b2` / `0x…a1b2` / 完整 16 位 hex 解析成规范 id。
 *
 * @throws {AmbiguousCellIdError} 后缀命中多条时
 */
export function resolveCellId(mem: MemoryService, short: string): string {
  const clean = short.trim().replace(/^#/, '').replace(/^0x/, '').toLowerCase()
  if (!/^[0-9a-f]+$/.test(clean)) {
    throw new Error(`"${short}" 不是合法的 id 片段（只接受 0-9a-f）`)
  }
  if (clean.length >= 16) return clean.slice(-16).padStart(16, '0')

  const hits = mem.store.findBySuffix(clean, MAX_MATCHES).map((id) => toHex(id, 16))
  if (hits.length === 0) return clean.padStart(16, '0')
  if (hits.length === 1) return hits[0]
  throw new AmbiguousCellIdError(clean, hits)
}

/** 不抛错的版本：解析失败时把原因当字符串返回（工具面用它，因为工具要回结构化错误）。 */
export function tryResolveCellId(mem: MemoryService, short: string): { ok: true; id: string } | { ok: false; message: string } {
  try {
    return { ok: true, id: resolveCellId(mem, short) }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
