/**
 * 文本侧工具：切分、实体抽取、时间解析、脱敏。
 *
 * 这一层的存在是为了守住一条边界：**编码器从第一步起就不产生散文**（§7.2）。
 * 这里输出的是槽位与实体，不是摘要句子。任何"顺手写一句话"的实现都会把
 * 文本记忆偷渡回来。
 */

import { topicOf } from './cell.js'

const STOP = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '我们', '你们', '他们', '这', '那', '就', '也', '都', '和',
  '与', '而', '但', '然后', '所以', '因为', '如果', '可以', '一个', '一下', '这个', '那个', 'the', 'a', 'an', 'is',
  'are', 'to', 'of', 'and', 'or', 'it', 'that', 'this', 'for', 'on', 'in', 'with', 'we', 'you', 'i',
])

/** 同义词归一（§7.4 实体归一化）。只做低风险的等价折叠，不做语义扩展。 */
const SYNONYM: Record<string, string> = {
  深色: 'dark',
  夜间: 'dark',
  暗色: 'dark',
  浅色: 'light',
  白天: 'light',
  等宽: 'mono',
  字体: 'font',
  界面: 'ui',
  主题: 'theme',
  配色: 'theme',
  数据库: 'db',
  仓库: 'repo',
  代码库: 'repo',
  接口: 'api',
  密钥: 'api_key',
  令牌: 'token',
  报错: 'bug',
  缺陷: 'bug',
  问题: 'bug',
  部署: 'deploy',
  上线: 'deploy',
}

export function normToken(s: string): string {
  const t = s.trim().toLowerCase().replace(/[“”"'`。，、；：！？（）()【】\[\]]/g, '')
  return SYNONYM[t] ?? t
}

/** 拉丁标识符 / 带点路径 / 数字 / 中文 2–6 字片段，都可作为实体候选。 */
export function extractEntities(text: string): string[] {
  const out = new Set<string>()
  const latin = text.match(/[A-Za-z_][A-Za-z0-9_.\-]{1,40}/g) ?? []
  for (const w of latin) {
    const n = normToken(w)
    if (n.length > 1 && !STOP.has(n)) out.add(n)
  }
  const cjkChunks = text.match(/[\u4e00-\u9fa5]{2,8}/g) ?? []
  for (const chunk of cjkChunks) {
    // 无分词器时的低风险做法：先按虚词切成短语，再取整段与 2-4 字片段。
    // 整块直接当实体是最常见的错误——'在一家做开发者工' 会变成 PATIENT。
    for (const part of chunk.split(/[我你他她它的了是在有和与也就都而且但很太更最这那你我们不要别]/).filter((x) => x.length >= 2)) {
      const n = normToken(part)
      if (!STOP.has(n)) out.add(n)
      if (part.length > 4) {
        for (let i = 0; i + 2 <= Math.min(part.length, 6); i++) {
          const bg = normToken(part.slice(i, i + 2))
          if (!STOP.has(bg) && !SYNONYM[bg]) out.add(bg)
        }
      }
    }
  }
  const nums = text.match(/\d+(?:\.\d+)?/g) ?? []
  for (const n of nums) out.add('#' + n)
  return [...out].slice(0, 24)
}

const PRED_RULES: Array<{ re: RegExp; pred: string }> = [
  // 否定必须排在肯定前面：'不喜欢' 里含 '喜欢'，顺序反了会判成 prefers
  { re: /讨厌|不喜欢|不想|hate|dislike/i, pred: 'dislikes' },
  { re: /喜欢|偏好|倾向|习惯|prefer|like/i, pred: 'prefers' },
  { re: /用|使用|采用|use|using/i, pred: 'uses' },
  { re: /决定|定了|选定|choose|decide/i, pred: 'decides' },
  { re: /改|换成|切换|switch|change/i, pred: 'changes' },
  { re: /修好|修复|fix|resolved/i, pred: 'fixes' },
  { re: /报错|失败|崩|fail|error|broken/i, pred: 'fails' },
  { re: /部署|上线|deploy|ship/i, pred: 'deploys' },
  { re: /记住|记一下|remember/i, pred: 'asserts' },
  { re: /是|为|等于|is/i, pred: 'is' },
]

export function detectPredicate(sentence: string): string {
  for (const r of PRED_RULES) if (r.re.test(sentence)) return r.pred
  return 'states'
}

export function isNegated(sentence: string): boolean {
  return /不|没|别|无需|取消|not\b|no\b|never/i.test(sentence)
}

export interface PreferenceFrame {
  topic?: string
  value?: string
}

/** 话题名词表：偏好句里"话题"往往是被修饰的中心词，靠它把两句话对到同一槽上。 */
export const TOPIC_NOUNS = [
  '字体', '主题', '颜色', '模式', '框架', '语言', '编辑器', '终端', '缩进', '命名',
  '日志', '部署', '缓存', '数据库', '接口', '配色', '布局',
  // 工程活动类：'构建用 pnpm' 与 '构建用 npm' 必须落到同一个话题键上
  '构建', '测试', '打包', '发布', '部署脚本', '鉴权', '认证', '存储',
]

/** 偏好句的 (话题, 取值) 抽取：'字体我也偏好等宽' → { topic: '字体', value: '等宽' }。 */
export function preferenceFrame(text: string): PreferenceFrame {
  const m = text.match(/([\u4e00-\u9fa5A-Za-z_.]{2,8})?[^，。；,;]{0,4}?(?:喜欢|偏好|倾向|习惯|讨厌|不喜欢|prefer|like|hate)\s*([^，。；,;]{1,16})/i)
  if (!m) return {}
  const topic = m[1]
    ?.replace(/[我你他她它的了是在和与也就都]/g, '')
    .replace(/^(其实|更|还|也|都|很|太|最|真的|确实|比较)/, '')
    .replace(/(其实|更|还|也|都|很|太|最)$/, '')
    .trim()
  // 话题必须是像名词的 2–4 字片段，否则宁可不填（宁缺勿错）
  // 施事词不是话题：'用户偏好深色主题' 里的话题是'主题'，不是'用户'
  const isAgent = (x?: string) => !!x && /^(用户|助手|我|你|他|她|我们|你们|他们|系统|工具)$/.test(x)
  let okTopic =
    topic && topic.length >= 2 && topic.length <= 4 && !isAgent(topic) && !/什么|怎么|为什么|多少|哪/.test(topic) ? topic : undefined
  const value = m[2]
    ?.replace(/^[用把将]/, '')
    .replace(/[的了呢吧啊]$/, '')
    .trim()
  // 兜底：从整句里找中心名词（'其实我更喜欢无衬线字体' → 字体）。
  // 没有这一步，'等宽' 与 '无衬线字体' 会被判成两个不相干的事实，矛盾检测直接失效。
  if (!okTopic) {
    const noun = TOPIC_NOUNS.find((n) => text.includes(n) && value !== n)
    if (noun) okTopic = noun
  }
  return { topic: okTopic, value: value || undefined }
}

/**
 * 句末切分。
 *
 * v0.3 之前只有中日韩标点与 `!?;`，**没有英文句号**——`I use pnpm. I like dark mode.`
 * 会粘成一条命题，英文用户等于完全没切分。
 * 现在补上 `.`，但排除三种情况，避免把句子切碎：
 *   · 小数点：`3.14`
 *   · 常见缩写：`e.g.` `i.e.` `Mr.` `v1.2.` 里的点由后面的字母/数字挡掉
 *   · 省略号：`...`（连续点只切一次）
 */
const SPLIT_RE = /(?<=[。！？；!?;])|(?<![\dA-Za-z])\.(?=\s|$)|(?<=[!?;])\s+|\n+/
const SPLIT_RE_LEGACY = /(?<=[。！？；!?;])|\n+/
const CONJ_RE = /(?:，|,)?\s*(?:但是|但|而且|并且|另外|同时|然后|不过)\s*/g

/**
 * L0 规则切分（覆盖约 60%）：句末标点 + 并列/转折连词。
 * 目标不是切得漂亮，而是切出**单一主语 + 单一谓词 + 可判真假**的原子断言。
 */
export function segmentPropositions(text: string): string[] {
  const raw = text
    .split(SPLIT_RE)
    .flatMap((s) => s.split(CONJ_RE))
    .map((s) => s.trim())
    .filter((s) => s.length >= 4)
  // 过短的碎片并回上一句，避免产生"了。"这种不可检索的原子
  const out: string[] = []
  for (const s of raw) {
    if (out.length > 0 && s.length < 6) out[out.length - 1] += s
    else out.push(s)
  }
  return out.slice(0, 12)
}

export interface TimeRange {
  from: number
  to: number
}

const DAY = 86_400_000

/** 相对时间解析（§9.1 Q4）。只覆盖高频表达，宁缺勿错。 */
export function parseTimeExpr(text: string, now = Date.now()): TimeRange | undefined {
  const t = text
  const mk = (from: number, to: number): TimeRange => ({ from, to })
  if (/今天|today/i.test(t)) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    return mk(d.getTime(), d.getTime() + DAY)
  }
  if (/昨天|yesterday/i.test(t)) {
    const d = new Date(now - DAY)
    d.setHours(0, 0, 0, 0)
    return mk(d.getTime(), d.getTime() + DAY)
  }
  if (/前天/.test(t)) {
    const d = new Date(now - 2 * DAY)
    d.setHours(0, 0, 0, 0)
    return mk(d.getTime(), d.getTime() + DAY)
  }
  if (/上周|last week/i.test(t)) return mk(now - 14 * DAY, now - 7 * DAY)
  if (/本周|这周|this week/i.test(t)) return mk(now - 7 * DAY, now)
  if (/上个月|last month/i.test(t)) return mk(now - 60 * DAY, now - 30 * DAY)
  if (/最近|近来|recently/i.test(t)) return mk(now - 7 * DAY, now)
  if (/去年/.test(t)) return mk(now - 730 * DAY, now - 365 * DAY)

  const nMention = t.match(/(\d+)\s*(天|日|周|个?星期|个月)\s*(前|以前|之前)/)
  if (nMention) {
    const n = Number(nMention[1])
    const unit = nMention[2]
    const days = unit === '天' || unit === '日' ? n : /周|星期/.test(unit) ? n * 7 : n * 30
    return mk(now - days * DAY - DAY, now - days * DAY + DAY)
  }
  const ago = t.match(/(\d+)\s*days?\s*ago/i)
  if (ago) {
    const days = Number(ago[1])
    return mk(now - days * DAY - DAY, now - days * DAY + DAY)
  }
  const md = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
  if (md) {
    const y = new Date(now).getFullYear()
    const d = new Date(y, Number(md[1]) - 1, Number(md[2]))
    return mk(d.getTime(), d.getTime() + DAY)
  }
  const ymd = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (ymd) {
    const d = new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    return mk(d.getTime(), d.getTime() + DAY)
  }
  return undefined
}

/**
 * PII / 凭据识别（§7.7 / §19.2）。
 *
 * ── v0.3.1 补了什么，为什么 ──────────────────────────────────────
 * v0.2/v0.3 只覆盖 7 类：sk-/ghp_/AKIA/JWT/邮箱/手机号/身份证。
 * 审查实测指出：IP、银行卡、PEM 私钥块、Bearer token、URL query 里的 token
 * 全部漏网，而编码器把**整轮原文**写进残差——"原文不落盘"只在已识别的
 * secrets 被替换的意义上成立。
 *
 * 顺序很重要：PEM 块必须最先（它内部可能包含看起来像其它模式的 base64），
 * Bearer 与 URL token 在邮箱/手机号之前（避免被拆成碎片后漏判）。
 * 银行卡用 Luhn 校验兜底，否则任何 16 位数字（时间戳、订单号）都会被误伤。
 */
const SECRET_PATTERNS: Array<{ re: RegExp; kind: string; test?: (s: string) => boolean }> = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    kind: 'pem_private_key',
  },
  { re: /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, kind: 'bearer_token' },
  {
    // 只替换参数值，保留参数名——否则"这条 URL 里有个 token"这个信息就丢了
    re: /([?&](?:token|access_token|api_key|apikey|key|secret|sig|signature|password|passwd)=)([^&\s#]{8,})/gi,
    kind: 'url_token',
  },
  { re: /\b(sk|pk|rk)-[A-Za-z0-9]{12,}\b/g, kind: 'api_key' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, kind: 'github_token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, kind: 'aws_key' },
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, kind: 'jwt' },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, kind: 'email' },
  { re: /\b1[3-9]\d{9}\b/g, kind: 'phone' },
  { re: /\b\d{17}[\dXx]\b/g, kind: 'id_card' },
  // 银行卡：13–19 位（允许空格/短横分组），必须过 Luhn 才算
  {
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    kind: 'bank_card',
    test: (s) => luhn(s.replace(/[ -]/g, '')),
  },
  // IPv4：只认点分四段且每段 ≤255
  {
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    kind: 'ip',
    // 版本号（1.2.3.4 这种）经常不是 IP，但误伤一个版本号远好于漏掉一个真实 IP
    test: () => true,
  },
]

/** Luhn 校验：银行卡号的必要条件。用它把"16 位订单号"从 PII 里排除掉。 */
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

export interface RedactResult {
  text: string
  secrets: Array<{ kind: string; index: number }>
  pii: boolean
}

/**
 * 编码前脱敏（§7.7 / §19.2）。原文不落盘，残差里只留 «SECRET:n»。
 * 注意第二步：如果消息里已经是 DSH 的脱敏占位符（***），**不能**把它当真实值编码——
 * 否则模型会记下"用户的 API key 是 ***"，然后在后续对话里自信地复述这个假事实。
 */
export function redact(text: string): RedactResult {
  let out = text
  const secrets: Array<{ kind: string; index: number }> = []
  let n = 0
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p.re, (...args: unknown[]) => {
      const whole = String(args[0])
      if (p.test && !p.test(whole)) return whole
      n++
      secrets.push({ kind: p.kind, index: n })
      // URL token 保留参数名（捕获组 1），其余整段替换
      if (p.kind === 'url_token') {
        const prefix = String(args[1] ?? '')
        return `${prefix}«SECRET:${n}»`
      }
      return `«SECRET:${n}»`
    })
  }
  return { text: out, secrets, pii: secrets.length > 0 }
}

/**
 * 槽位级兜底：即使上游漏了一次 redact，也不允许明文 PII 落进结构化槽位。
 *
 * 为什么单独做一层：审查实测发现 `fillSlots(text, …)` 拿的是**原文**，
 * 于是 digest 是脱敏的、槽位里却是完整手机号，而槽位会经 `kvPairs()`
 * 直接渲染进模型上下文。派生字段的脱敏不能只靠调用方记得。
 */
export function scrubValue(value: string): { value: string; redacted: boolean } {
  if (!value) return { value, redacted: false }
  const r = redact(value)
  return { value: r.text, redacted: r.pii }
}

const PLACEHOLDER_RE = /(\*{3,}|«redacted»|<redacted>|\[redacted\]|\[REDACTED\])/

/** 该槽位值是否只是一个脱敏占位符——是则必须降为 UNK，禁止当真实值编码。 */
export function isRedactionPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value) && value.replace(PLACEHOLDER_RE, '').trim().length < 4
}

export function hasPlaceholder(value: string): boolean {
  return PLACEHOLDER_RE.test(value)
}

/** 动宾结构里的宾语：'统一用 pnpm' → pnpm，'改用 npm' → npm。 */
export function objectOfVerb(text: string): string | undefined {
  // '用' 会出现在'用户/应用/费用/适用/利用'里。不加负向后顾，
  // '用户用 pnpm 构建' 会把宾语抽成'户用'——实测踩过，直接导致两条事实被误合并。
  const VERB = '(?:使用|改用|采用|换成|切换到|统一用|(?<![用应费适作利])用)'

  // 1) 拉丁标识符优先：技术讨论里宾语几乎都是 pnpm / vitest / TypeScript 这类词
  const latin = text.match(new RegExp(`${VERB}\\s*([A-Za-z][A-Za-z0-9_.\\-]{1,30})`))
  if (latin) return latin[1]

  // 2) 中文宾语：逐个候选试，跳过'户用'这种被截断的半截词
  const re = new RegExp(`${VERB}\\s*([\\u4e00-\\u9fa5]{2,8})`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const v = m[1].replace(/[的了呢吧啊，。；]$/, '').trim()
    if (v && !/^[户应费适作利]/.test(v)) return v
  }
  return undefined
}

export function isQuestion(text: string): boolean {
  const t = text.trim()
  if (/[?？]\s*$/.test(t)) return true
  if (/(吗|呢|么)\s*$/.test(t)) return true
  // 疑问词必须和问号/吗一起出现才算问句：
  // '感觉自己什么都做不好' 是陈述，不是提问——早先按关键词判会把整句丢掉（实测踩过）。
  return false
}

export function isUserAskedToRemember(text: string): boolean {
  return /记住|记一下|记下|别忘|remember|don't forget/i.test(text)
}

/** 用户显式指向过去（门控的强信号，§14.5）。 */
export function referencesPast(text: string): boolean {
  return /上次|上回|之前|以前|刚才|前面|早先|说过|提过|记得|last time|earlier|previously|before/i.test(text)
}

export type AttunementSignal = 'affirmed' | 'corrected' | 'implicit' | 'none'

/** attunement 的三条启发式（§11.5，修 D-12）。各自带置信度，低置信不更新。 */
export function attunementSignal(text: string): { signal: AttunementSignal; confidence: number } {
  if (/不对|不是这个|我说的是|错了|不是这意思|你理解错|wrong|that's not/i.test(text)) {
    return { signal: 'corrected', confidence: 0.85 }
  }
  if (/^(对|是的|没错|就是这样|很好|可以|对了)|exactly|that's right|correct/i.test(text.trim())) {
    return { signal: 'affirmed', confidence: 0.9 }
  }
  if (text.trim().length > 8) return { signal: 'implicit', confidence: 0.4 }
  return { signal: 'none', confidence: 0 }
}

/** 用户划的边界（§11.5 boundaries，只增不减）。 */
export function detectBoundary(text: string): string | undefined {
  const m = text.match(/(?:不要|别|不用|禁止|以后别|don't|never)\s*([^\n。，,；;]{2,40})/)
  return m ? m[1].trim() : undefined
}

export function topicFingerprint(text: string): string {
  return topicOf(text)
}

/** 语言检测：只用于选择 token 估算与切分策略，不做语义。 */
export function isCJK(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text)
}
