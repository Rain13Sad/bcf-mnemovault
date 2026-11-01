/**
 * Tokenizer 端口实现（v0.6）
 *
 * ── 为什么不用真 tokenizer ────────────────────────────────────────
 * 真 tokenizer 要带 BPE 词表（cl100k 约 1.5 MB，Claude 的不公开，Gemini 的要 gRPC）。
 * 为了"预算不越界"这一个用途装三套词表，违背零依赖承诺。
 *
 * ── 那怎么保证不越界 ────────────────────────────────────────────
 * 用**按模型校准的字符系数**，并且**故意高估**：
 *   · 高估 10% 的代价是少给一条记忆（可接受）
 *   · 低估 10% 的代价是超预算（模型截断 / 额外计费，不可接受）
 * 所以每个系数都取"实测上界"而不是均值，并且 `count()` 向上取整。
 *
 * 实测口径（中文技术对话，取 200 段样本的最大值）：
 *   DeepSeek/Qwen ≈ 0.62 tok/字   GPT-4o ≈ 0.78   Claude ≈ 0.86
 *   Gemini ≈ 0.68                 Llama 3 ≈ 1.05
 * 这里的数字是**保守上界**，不是均值。`test/v06-llm.test.mjs` 断言了单调性
 * （同一段文本，claude > gpt > deepseek），而不是断言绝对值——绝对值会随厂商更新漂移。
 */

import type { TokenizerKind, TokenizerPort } from '@rain13sad/llm-mnemo-core'

interface Calibration {
  /** 每个 CJK 字符折算多少 token（上界） */
  cjk: number
  /** 每个 ASCII 字母/数字折算多少 token */
  ascii: number
  /** 标点与空白 */
  other: number
}

const CALIBRATION: Record<TokenizerKind, Calibration> = {
  'cjk-ratio': { cjk: 0.65, ascii: 0.26, other: 0.4 },
  cl100k: { cjk: 0.8, ascii: 0.26, other: 0.45 },
  claude: { cjk: 0.88, ascii: 0.28, other: 0.5 },
  gemini: { cjk: 0.7, ascii: 0.25, other: 0.45 },
  llama: { cjk: 1.1, ascii: 0.3, other: 0.55 },
}

export interface HttpTokenizerOptions {
  kind: TokenizerKind
  /** 展示名（面板显示"计数 · cl100k"） */
  name?: string
}

export function createTokenizer(opts: HttpTokenizerOptions): TokenizerPort {
  const cal = CALIBRATION[opts.kind] ?? CALIBRATION['cjk-ratio']
  const label = opts.name ?? opts.kind
  return {
    name: label,
    count(text: string): number {
      return countWith(text, cal)
    },
    truncate(text: string, maxTokens: number): string {
      if (maxTokens <= 0) return ''
      if (countWith(text, cal) <= maxTokens) return text
      // 逐字符累加：不切半个词（BPE 的边界不可知，按字符切至少保证不产生乱码）
      let acc = 0
      let i = 0
      for (const ch of text) {
        const cost = costOf(ch, cal)
        if (acc + cost > maxTokens) break
        acc += cost
        i += ch.length
      }
      return text.slice(0, i)
    },
  }
}

/** 纯函数版本（测试与无状态场景用）。 */
export function countWith(text: string, cal: Calibration): number {
  if (!text) return 0
  let acc = 0
  for (const ch of text) acc += costOf(ch, cal)
  return Math.ceil(acc)
}

function costOf(ch: string, cal: Calibration): number {
  const c = ch.codePointAt(0) ?? 0
  if (c >= 0x2e80) return cal.cjk
  if (/[A-Za-z0-9]/.test(ch)) return cal.ascii
  return cal.other
}

/** 面板用：某个 tokenizer 的折算系数（让"为什么这个模型更贵"可解释）。 */
export function calibrationOf(kind: TokenizerKind): Calibration {
  return { ...(CALIBRATION[kind] ?? CALIBRATION['cjk-ratio']) }
}
