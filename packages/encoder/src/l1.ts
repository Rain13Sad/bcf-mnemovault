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
 * ── 为什么这里要"宽进"而不是"猜" ─────────────────────────────────
 * 宿主的 llm 服务在 rc 之间改过三次调用形状：`complete(prompt)`、
 * `generate({prompt})`、`chat({messages})`。v0.2 只认前两种字符串入参，
 * 认不出就静默降级——于是"L1 就绪"这句话实际上从没被验证过。
 *
 * 现在的策略是：**枚举已知入口 → 逐个探测 → 把命中的形状写进运行时状态**。
 * 三条硬约束不变：
 *   1. 不做猜测性调用。探测失败就返回 null，编码器降级到 lite，不抛错。
 *   2. 不假设返回结构。字符串 / {text} / {content} / {choices[0].message.content}
 *      / 异步迭代器（流式）五种形态都归一成字符串。
 *   3. 探测结果可读。`entry` 会被面板与 doctor 显示——"接上了没有"是运行时事实，
 *      不该靠 README 里的一句话。
 */
export interface HostLlmPort extends LlmPort {
  /** 识别到的入口名（complete / chat / generate / invoke / run / …） */
  readonly entry: string
  /** 该入口期望的入参形状 */
  readonly shape: 'prompt' | 'messages' | 'object'
}

const ENTRY_ORDER = ['complete', 'chat', 'generate', 'invoke', 'run', 'call', 'respond', 'createCompletion'] as const

type Shape = 'prompt' | 'messages' | 'object'

function shapeOf(entry: string): Shape {
  if (entry === 'chat') return 'messages'
  if (entry === 'complete' || entry === 'createCompletion') return 'prompt'
  return 'object'
}

/** 把任意返回结构归一成文本。拿不到就返回空串（调用方据此降级）。 */
export async function normalizeLlmOutput(r: unknown): Promise<string> {
  if (r == null) return ''
  if (typeof r === 'string') return r
  if (typeof r === 'object') {
    const o = r as Record<string, unknown>
    // 流式：async iterable of chunks
    if (typeof (o as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
      let acc = ''
      for await (const chunk of r as AsyncIterable<unknown>) {
        if (typeof chunk === 'string') acc += chunk
        else if (chunk && typeof chunk === 'object') {
          const c = chunk as Record<string, unknown>
          acc += typeof c.text === 'string' ? c.text : typeof c.delta === 'string' ? c.delta : ''
        }
      }
      return acc
    }
    if (typeof o.text === 'string') return o.text
    if (typeof o.output_text === 'string') return o.output_text
    if (typeof o.content === 'string') return o.content
    if (Array.isArray(o.content)) {
      return o.content
        .map((b) => (typeof b === 'string' ? b : String((b as { text?: string })?.text ?? '')))
        .join('\n')
    }
    // OpenAI 风格
    const choices = o.choices
    if (Array.isArray(choices) && choices.length > 0) {
      const c0 = choices[0] as Record<string, unknown>
      const msg = c0.message as Record<string, unknown> | undefined
      if (msg && typeof msg.content === 'string') return msg.content
      if (typeof c0.text === 'string') return c0.text
    }
    if (typeof o.output === 'string') return o.output
  }
  return ''
}

export function fromHostLlm(llm: unknown): HostLlmPort | null {
  if (!llm || typeof llm !== 'object') return null
  const o = llm as Record<string, unknown>

  // 有些宿主把 llm 包在 client / provider 下面
  const candidates: Array<{ holder: Record<string, unknown>; path: string }> = [{ holder: o, path: '' }]
  for (const key of ['client', 'provider', 'model', 'models']) {
    const sub = o[key]
    if (sub && typeof sub === 'object') candidates.push({ holder: sub as Record<string, unknown>, path: key + '.' })
  }

  for (const entry of ENTRY_ORDER) {
    for (const c of candidates) {
      const fn = c.holder[entry]
      if (typeof fn !== 'function') continue
      const shape = shapeOf(entry)
      return {
        entry: c.path + entry,
        shape,
        available: () => true,
        async complete(prompt: string, opts?: { maxTokens?: number }) {
          const args: unknown[] =
            shape === 'messages'
              ? [{ messages: [{ role: 'user', content: prompt }], maxTokens: opts?.maxTokens }]
              : shape === 'prompt'
                ? [prompt, { maxTokens: opts?.maxTokens }]
                : [{ prompt, messages: [{ role: 'user', content: prompt }], maxTokens: opts?.maxTokens }]
          const r = await (fn as (...a: unknown[]) => Promise<unknown>).apply(c.holder, args)
          return normalizeLlmOutput(r)
        },
      }
    }
  }
  return null
}

/**
 * 启动自检：真打一次最小调用。
 *
 * 为什么必须真打：入口存在不代表能跑通（鉴权、模型名、配额都会让它在第一次调用时失败）。
 * 自检失败时**不抛错**——编码器降级到 lite，但状态会记成 ok=false，
 * 面板上"L1：端口失败（401）"比"L1：已就绪"的谎言有用得多。
 */
export async function probeLlmPort(port: LlmPort | null, timeoutMs = 4000): Promise<{ ok: boolean; ms: number; note: string; sample: string }> {
  if (!port) return { ok: false, ms: 0, note: '未找到宿主 llm 服务', sample: '' }
  if (!port.available()) return { ok: false, ms: 0, note: '端口报告不可用', sample: '' }
  const t0 = Date.now()
  try {
    const raw = await Promise.race([
      port.complete('只输出一个 JSON 数组：[{"text":"探针"}]', { maxTokens: 32 }),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)),
    ])
    const ms = Date.now() - t0
    const text = String(raw ?? '').trim()
    if (!text) return { ok: false, ms, note: '返回空文本（形状不被识别）', sample: '' }
    const props = parseLlmPropositions(text)
    return {
      ok: true,
      ms,
      note: props ? `自检通过，解析出 ${props.length} 条命题` : '自检通过，但返回不是合法 JSON（L1 会降级到 lite）',
      sample: text.slice(0, 80),
    }
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, note: `自检失败：${String((err as Error)?.message ?? err).slice(0, 120)}`, sample: '' }
  }
}
