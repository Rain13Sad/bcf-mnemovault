/**
 * L1 切分（对应 §7.2 的 L1 层：小模型单次调用 + 结构化输出）
 *
 * 两条路径，同一份输出形状：
 *   1. `LlmPort` —— 宿主提供的小模型。**输出必须是 JSON 数组的槽位填充结果，不是散文**
 *      （§7.2 的关键约束：编码器从第一步起就不产生散文）。
 *   2. `segmentLite` —— 没有模型时的规则增强版：按逗号/分号切并列小句。
 *      L0 只在句末标点与连词处切，所以"我们用 pnpm 构建，用 vitest 跑测试" 会被当成
 *      一条命题；L1-lite 会切成两条，因为两个小句各有自己的谓词。
 *
 * 为什么 L1 不是"更聪明的 L0"：L0 的错误是**漏切**（一条 cell 塞两件事），
 * L1 的价值在于把复合句拆成可独立检索的原子断言。拆得对不对，bench 的 Recall@8 会说话。
 */

export interface Proposition {
  /** 原子断言的原文片段（用于生成 digest 与残差） */
  text: string
  agent?: string
  patient?: string
  pred?: string
  polarity?: 'pos' | 'neg'
}

export interface LlmPort {
  available(): boolean
  /** 单次补全。实现方负责超时与重试；本模块只解析返回文本。 */
  complete(prompt: string, opts?: { maxTokens?: number }): Promise<string>
}

export const L1_PROMPT = `把下面这段话拆成原子断言，每条必须"单一主语 + 单一谓词 + 可判真假"。
只输出 JSON 数组，不要解释、不要 markdown 代码块。每个元素形如：
{"text":"原文片段","agent":"施事","patient":"受事","pred":"谓词","polarity":"pos|neg"}
规则：
- 一条断言只讲一件事；并列的两件事必须拆开
- 疑问句、寒暄、语气词不要输出
- 保留原文用词，不要改写、不要总结
待拆分的文本：
`

/**
 * 宽容解析：模型经常返回 ```json 包裹、前后带解释、或尾随逗号。
 * 这里不追求"完美 JSON"，只求"能拿到数组"——拿不到就返回 null，让调用方降级到 L0。
 */
export function parseLlmPropositions(raw: string): Proposition[] | null {
  if (!raw) return null
  const cleaned = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  const body = cleaned.slice(start, end + 1).replace(/,\s*([\]}])/g, '$1')
  try {
    const arr = JSON.parse(body) as unknown
    if (!Array.isArray(arr)) return null
    const out: Proposition[] = []
    for (const item of arr) {
      if (typeof item === 'string') {
        if (item.trim().length >= 2) out.push({ text: item.trim() })
        continue
      }
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const text = String(o.text ?? o.proposition ?? '').trim()
      if (text.length < 2) continue
      out.push({
        text,
        agent: o.agent ? String(o.agent) : undefined,
        patient: o.patient ? String(o.patient) : undefined,
        pred: o.pred ? String(o.pred) : undefined,
        polarity: o.polarity === 'neg' ? 'neg' : o.polarity === 'pos' ? 'pos' : undefined,
      })
    }
    return out.length ? out : null
  } catch {
    return null
  }
}

/** 有端口就用端口；端口缺席或返回不可解析时返回 null（调用方降级到 lite/L0）。 */
export async function segmentWithPort(text: string, port: LlmPort): Promise<Proposition[] | null> {
  if (!port.available()) return null
  try {
    const raw = await port.complete(L1_PROMPT + text, { maxTokens: 512 })
    return parseLlmPropositions(raw)
  } catch {
    return null
  }
}

/**
 * L1-lite：无模型时的规则增强。
 *
 * 与 L0 的差别只有一条，但很关键：**逗号也是切分点**，只要两个小句各自带谓词。
 * 中文口语里"我用 A 做 X，用 B 做 Y"极常见，L0 会把它压成一条不可分的 cell。
 */
export function segmentLite(text: string): Proposition[] {
  const clauses = text
    .split(/[，,；;。！？!?\n]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)

  // 谓词识别宁宽勿窄：漏判的后果是"两条独立事实被粘成一条"，
  // 而误判的后果只是一条无谓词的片段单独成条（可被后续去重合并）。
  const hasPred = (s: string) =>
    /用|是|有|要|会|能|喜欢|偏好|讨厌|决定|改|修|跑|写|放|存|走|进|上线|交付|保留|支持|包含|依赖|报错|失败|需要|应该|必须|得|deploy|use|prefer|fix|run|is|are|build|test/i.test(s)

  const out: Proposition[] = []
  for (const c of clauses) {
    if (c.length < 4) continue
    // 疑问句不是断言。切分已经吃掉了问号，所以认"吗/呢/好不好/是否"这类**句末**标记，
    // 不能只看疑问词——'感觉自己什么都做不好' 里也有'什么'，但它是陈述。
    if (/[?？]$/.test(c) || /(吗|呢|么|好不好|是不是|有没有|对不对)$/.test(c)) continue
    if (!hasPred(c)) {
      // 没有谓词的片段并回上一条（"深色主题，浅色看久了眼睛疼" 的前半句）
      if (out.length > 0) out[out.length - 1].text += '，' + c
      continue
    }
    out.push({ text: c, polarity: /不|没|别|never|not/i.test(c) ? 'neg' : 'pos' })
  }
  return out.slice(0, 12)
}

/**
 * 把宿主 LLM 服务适配成 LlmPort。
 *
 * ⚠ 宿主 llm 服务的调用形状在 rc 间会变，这里只认三种最常见的入口，
 * 一个都没有就返回 null（编码器自动降级），不做猜测性调用。
 */
export function fromHostLlm(llm: unknown): LlmPort | null {
  if (!llm || typeof llm !== 'object') return null
  const o = llm as Record<string, unknown>
  const call =
    (typeof o.complete === 'function' && (o.complete as (...a: unknown[]) => unknown)) ||
    (typeof o.generate === 'function' && (o.generate as (...a: unknown[]) => unknown)) ||
    (typeof o.chat === 'function' && (o.chat as (...a: unknown[]) => unknown)) ||
    null
  if (!call) return null
  return {
    available: () => true,
    async complete(prompt: string) {
      const r = await (call as (p: string) => Promise<unknown>).call(o, prompt)
      if (typeof r === 'string') return r
      if (r && typeof r === 'object') {
        const rr = r as Record<string, unknown>
        if (typeof rr.text === 'string') return rr.text
        if (typeof rr.content === 'string') return rr.content
        if (Array.isArray(rr.content)) {
          return rr.content.map((b) => String((b as { text?: string })?.text ?? '')).join('\n')
        }
      }
      return ''
    },
  }
}
