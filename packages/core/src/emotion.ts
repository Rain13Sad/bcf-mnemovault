/**
 * 情感记忆引擎（v0.6）—— 核心算法层
 *
 * 这一层只做**数学**，不做任何 I/O，也不认识 Cordis / HTTP / 面板。
 * 它把"情绪如何影响记忆"的四条公认机制写成可断言的函数：
 *
 *   ① 评价 → 核心情感（Scherer SEC / OCC → PAD）
 *      情绪不是标签，是六项评价的**投影**。同一句话在不同关系阶段得到不同 PAD，
 *      这正是"陪伴"与"客服"的差别所在。
 *
 *   ② 心境一致性（Bower mood-congruent memory）
 *      难过时更容易想起难过的事。这是真实的，也是**危险的**——
 *      无上限的负向一致会自我强化成反刍。所以这里只提供**增益**，
 *      上限由 `recall.wAffect` 封顶（0.25），并且负向侧再打一次折（见 `moodCongruence`）。
 *
 *   ③ 唤醒对巩固的倒 U 调制（Yerkes-Dodson / 杏仁核调制）
 *      中等唤醒记得最牢，极高唤醒反而碎片化。所以 `arousalBoost(a)` 在 a=0.5 处取峰，
 *      两端都回落——而不是"越激动越重要"的线性假设（那是错的，且会把争吵写成里程碑）。
 *
 *   ④ 情感作为信息（affect-as-information）
 *      心境不只筛选记忆，还改变"这条记忆值多少"。这条只在 `emotionBrief` 里体现为
 *      给模型的**行为提示**，不直接改分数——改分数会让解释器无法自证。
 *
 * 边界（与 affect 包一致，代码注释与对外表述都要守住）：
 *   · 这些数字是**状态变量的投影**，不是主观体验
 *   · `emotionBrief()` 输出的是给模型的上下文，不是"我感到…"
 */

import type { ExtractedFact } from './ports.js'
import type { Appraisal, Pad } from './types.js'

export interface EmotionLabel {
  label: string
  intensity: number
}

export interface AffectEstimate {
  v: number
  a: number
  d: number
  s: number
  labels: EmotionLabel[]
  /** 估计的置信度：词典命中越多越高；纯标点/语气词给低值 */
  confidence: number
}

export const NEUTRAL_PAD: Pad = { v: 0, a: 0, d: 0, s: 0 }

/** 数值裁剪。所有对外返回的 PAD 都要过它，避免累计漂移出界。 */
export function clamp11(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

/**
 * 情感词典。每条 = [词, 效价, 唤醒, 支配]。
 *
 * 只收**高信号**词：能改变记忆颜色的那些。不做通用情感分析——
 * 通用词典在长文本上会把"不是不开心"判成负面，而这里要的是
 * "这句话值不值得被记成带情绪的事"。
 */
export const LEXICON: Array<[string, number, number, number]> = [
  // 正向 · 高唤醒
  ['太棒了', 0.8, 0.7, 0.4],
  ['兴奋', 0.7, 0.8, 0.3],
  ['激动', 0.6, 0.8, 0.2],
  ['惊喜', 0.75, 0.75, 0.2],
  ['终于', 0.5, 0.6, 0.3],
  ['搞定', 0.6, 0.5, 0.6],
  ['成功', 0.6, 0.5, 0.6],
  ['通过了', 0.6, 0.5, 0.5],
  ['amazing', 0.8, 0.7, 0.4],
  ['excited', 0.7, 0.8, 0.3],
  ['finally', 0.5, 0.6, 0.3],
  ['shipped', 0.6, 0.5, 0.6],
  // 正向 · 低唤醒
  ['喜欢', 0.55, 0.35, 0.3],
  ['开心', 0.65, 0.45, 0.4],
  ['满意', 0.5, 0.25, 0.5],
  ['舒服', 0.5, 0.2, 0.4],
  ['谢谢', 0.45, 0.25, 0.2],
  ['感谢', 0.5, 0.3, 0.2],
  ['放心', 0.45, 0.2, 0.4],
  ['靠谱', 0.55, 0.3, 0.5],
  ['nice', 0.55, 0.35, 0.3],
  ['love', 0.7, 0.5, 0.3],
  ['thanks', 0.45, 0.25, 0.2],
  // 负向 · 高唤醒
  ['生气', -0.7, 0.8, 0.4],
  ['愤怒', -0.8, 0.85, 0.4],
  ['崩溃', -0.85, 0.85, -0.2],
  ['烦死', -0.7, 0.75, 0.3],
  ['受不了', -0.75, 0.7, 0.1],
  ['糟糕', -0.65, 0.6, -0.1],
  ['失败了', -0.6, 0.6, -0.1],
  ['又错了', -0.6, 0.6, 0.0],
  ['气死', -0.8, 0.8, 0.3],
  ['angry', -0.7, 0.8, 0.4],
  ['broken', -0.6, 0.6, -0.1],
  ['crash', -0.6, 0.65, -0.1],
  // 负向 · 低唤醒
  ['难过', -0.65, 0.3, -0.3],
  ['失望', -0.6, 0.35, -0.2],
  ['累', -0.45, 0.25, -0.2],
  ['焦虑', -0.55, 0.6, -0.4],
  ['担心', -0.45, 0.5, -0.3],
  ['孤独', -0.6, 0.25, -0.4],
  ['委屈', -0.6, 0.4, -0.3],
  ['sad', -0.65, 0.3, -0.3],
  ['tired', -0.45, 0.25, -0.2],
  ['anxious', -0.55, 0.6, -0.4],
  // 关系信号（支配/信任轴）
  ['对不起', -0.3, 0.3, -0.3],
  ['抱歉', -0.3, 0.3, -0.3],
  ['没事', 0.2, 0.15, 0.2],
  ['算了', -0.25, 0.2, -0.1],
  ['随便', -0.2, 0.2, -0.1],

  // ── v0.6.1 补齐（F4）────────────────────────────────────────
  // v0.6.0 的英文只有 15 条，且**没有 happy / good / bad / great** 这些最高频词，
  // 于是 "I am happy" 的置信度是 0 —— 相对 v0.2 的 affect/appraisal.ts 是**退化**。
  // 中文补的是"好/差/棒/累"这类单字与口语词（它们是最高频的情绪载体）。
  ['高兴', 0.6, 0.4, 0.4],
  ['幸福', 0.7, 0.35, 0.4],
  ['不错', 0.45, 0.25, 0.4],
  ['挺好', 0.5, 0.25, 0.4],
  ['很好', 0.55, 0.3, 0.4],
  ['好', 0.4, 0.2, 0.3],
  ['棒', 0.6, 0.5, 0.4],
  ['赞', 0.55, 0.4, 0.4],
  ['顺利', 0.5, 0.3, 0.5],
  ['轻松', 0.45, 0.2, 0.4],
  ['期待', 0.5, 0.55, 0.3],
  ['差', -0.45, 0.35, -0.2],
  ['麻烦', -0.4, 0.4, -0.2],
  ['烦', -0.55, 0.6, 0.2],
  ['怕', -0.5, 0.6, -0.4],
  ['后悔', -0.6, 0.4, -0.3],
  ['无聊', -0.35, 0.15, -0.2],
  ['尴尬', -0.35, 0.45, -0.3],
  ['烦人', -0.55, 0.55, 0.2],
  ['happy', 0.7, 0.5, 0.4],
  ['glad', 0.6, 0.4, 0.4],
  ['good', 0.5, 0.3, 0.4],
  ['great', 0.65, 0.5, 0.5],
  ['awesome', 0.75, 0.65, 0.4],
  ['excellent', 0.75, 0.55, 0.5],
  ['wonderful', 0.75, 0.55, 0.4],
  ['relieved', 0.5, 0.25, 0.4],
  ['grateful', 0.6, 0.3, 0.2],
  ['calm', 0.4, 0.1, 0.4],
  ['peaceful', 0.45, 0.1, 0.4],
  ['okay', 0.25, 0.15, 0.3],
  ['fine', 0.25, 0.15, 0.3],
  ['confident', 0.55, 0.4, 0.6],
  ['proud', 0.6, 0.4, 0.6],
  ['hopeful', 0.5, 0.4, 0.4],
  ['curious', 0.3, 0.5, 0.3],
  ['enjoy', 0.6, 0.45, 0.4],
  ['like', 0.45, 0.3, 0.3],
  ['bad', -0.55, 0.45, -0.2],
  ['awful', -0.75, 0.65, -0.3],
  ['terrible', -0.75, 0.65, -0.3],
  ['horrible', -0.8, 0.7, -0.3],
  ['hate', -0.75, 0.7, 0.3],
  ['dislike', -0.5, 0.45, 0.2],
  ['upset', -0.6, 0.6, -0.2],
  ['frustrated', -0.65, 0.65, -0.1],
  ['annoyed', -0.55, 0.6, 0.2],
  ['exhausted', -0.55, 0.25, -0.3],
  ['worried', -0.5, 0.55, -0.3],
  ['nervous', -0.5, 0.6, -0.3],
  ['afraid', -0.6, 0.65, -0.4],
  ['scared', -0.65, 0.7, -0.4],
  ['lonely', -0.6, 0.25, -0.4],
  ['bored', -0.35, 0.15, -0.2],
  ['disappointed', -0.6, 0.35, -0.2],
  ['guilty', -0.55, 0.45, -0.3],
  ['ashamed', -0.6, 0.45, -0.3],
  ['jealous', -0.5, 0.55, -0.2],
  ['confused', -0.3, 0.5, -0.4],
  ['hurt', -0.6, 0.5, -0.3],
]

/**
 * 词表去重（v0.6.1）。
 *
 * 扩容时最容易犯的错是**同一个词加了两遍**（"开心""糟糕"原本就在表里），
 * 而匹配循环会对每个条目累加一次——重复条目让效价凭空翻倍。
 * 这里在加载期按词去重（先出现的胜出），`test/v061-emotion` 断言无重复。
 */
export const LEXICON_DEDUP: Array<[string, number, number, number]> = (() => {
  const seen = new Map<string, [string, number, number, number]>()
  for (const e of LEXICON) if (!seen.has(e[0])) seen.set(e[0], e)
  return [...seen.values()]
})()

/** 程度修饰：把"有点"和"非常"区分开。乘在效价与唤醒上。 */
const INTENSIFIERS: Array<[string, number]> = [
  ['非常', 1.5],
  ['特别', 1.4],
  ['真的', 1.25],
  ['超级', 1.6],
  ['极其', 1.7],
  ['极度', 1.7],
  ['太', 1.35],
  ['十分', 1.35],
  ['很', 1.2],
  ['挺', 1.1],
  ['超', 1.4],
  ['贼', 1.4],
  ['有点', 0.6],
  ['有些', 0.65],
  ['稍微', 0.55],
  ['略', 0.6],
  ['还行', 0.5],
  ['very', 1.4],
  ['really', 1.25],
  ['extremely', 1.7],
  ['so', 1.3],
  ['quite', 1.15],
  ['a bit', 0.6],
  ['a little', 0.6],
  ['slightly', 0.55],
]

/**
 * 否定：命中后把效价翻转并降唤醒（"不难过"不是"开心"）。
 *
 * v0.6.0 的实现是 `before = s.slice(idx-3, idx)` 然后 `endsWith(n)`——
 * 窗口只有 3 个字符，而英文的 `not ` 是 4 个字符，于是 **`not` 永远匹配不上**：
 * "I am not happy" 里 before = "t h"，`endsWith('not')` 与 `endsWith('no ')` 都是 false。
 * 中文的远距离否定（"我不是很开心"）同样漏判。
 */
// 中文：不 / 没 / 别 / 无 / 非 / 未　英文：not / never / no / n't / without / hardly / barely

/**
 * 从文本估计核心情感。规则路线，**不是**语义模型——
 * 它只回答"这句话有多带电、往哪个方向"，不回答"是什么情绪"。
 * 精确标签交给 `labelFromAppraisal()` 或 LLM 抽取端口。
 */
export function estimateAffect(text: string): AffectEstimate {
  const s = text.toLowerCase()
  let v = 0
  let a = 0
  let d = 0
  let hits = 0
  let negated = 0

  for (const [word, lv, la, ld] of LEXICON_DEDUP) {
    const w = word.toLowerCase()
    // 同一句里同一个词可能出现多次（"很开心，真的很开心"）：全部计入，但最多 3 次
    let from = 0
    let occ = 0
    while (occ < 3) {
      const idx = s.indexOf(w, from)
      if (idx < 0) break
      from = idx + w.length
      occ++
      // 前 14 个字符足够覆盖 "I am really not very ..." 这类叠加修饰
      const before = s.slice(Math.max(0, idx - 14), idx)
      const neg = isNegated(before)
      const mult = intensifierOf(before)
      v += (neg ? -lv * 0.7 : lv) * mult
      a += la * mult * (neg ? 0.7 : 1)
      d += ld * mult
      hits++
      if (neg) negated++
    }
  }

  // 标点与语气：感叹号提高唤醒，问号提高不确定（降低支配），省略号降低唤醒
  const bangs = (text.match(/[!！]/g) ?? []).length
  const ques = (text.match(/[?？]/g) ?? []).length
  const dots = (text.match(/…|\.\.\./g) ?? []).length
  a += Math.min(0.35, bangs * 0.12)
  a -= Math.min(0.2, dots * 0.08)
  d -= Math.min(0.25, ques * 0.06)

  if (hits === 0 && bangs === 0 && ques === 0) {
    return { ...NEUTRAL_PAD, labels: [], confidence: 0 }
  }

  // 归一：多次命中不该线性累加到爆表，用 tanh 型压缩
  const norm = (x: number) => clamp11(Math.tanh(x * 0.8))
  const pad: Pad = {
    v: norm(v),
    a: clamp01(0.5 + a * 0.5),
    d: norm(d),
    s: clamp01(Math.min(1, hits * 0.22 + bangs * 0.1 + (Math.abs(v) > 0.5 ? 0.25 : 0))),
  }
  return {
    ...pad,
    labels: labelFromPad(pad),
    confidence: clamp01(hits * 0.18 + (bangs + ques > 0 ? 0.1 : 0)),
  }
}

/**
 * 否定判定（v0.6.1 · 修 F4）。
 *
 * 英文用词边界，中文按"紧邻"判：`before` 是词前最多 14 个字符。
 * 中文否定词后面允许夹 1–2 个修饰字（"不是很开心"里的"是很"）。
 */
function isNegated(before: string): boolean {
  if (!before) return false
  const tail = before.toLowerCase()
  // 英文：not / never / no / hardly … 按词边界；n't 是**后缀**（don't / isn't），
  // 前面紧贴字母，所以单独一条规则——v0.6.0 的 `endsWith('not')` 在这里全军覆没。
  if (/(?:^|[^a-z])(not|never|no|without|hardly|barely)(?:[\s\w,'-]{0,8})$/.test(tail)) return true
  if (/n't(?:[\s\w,'-]{0,8})$/.test(tail)) return true
  // 中文：否定词 + 最多 2 个非标点字符 + 词
  return /(不|没|别|无|非|未)[^，。！？,.!?；;\s]{0,2}$/.test(before)
}

/**
 * 程度修饰（v0.6.1 · 修 F4）。
 *
 * 英文走词边界（避免 `so` 命中 `also` / `sofa`），中文走子串但排除高频误伤：
 * `太` 不能命中 `太阳` / `太空` / `太太`；`超` 不能命中 `超市`。
 */
function intensifierOf(before: string): number {
  if (!before) return 1
  const tail = before.toLowerCase()
  let best = 1
  for (const [m, k] of INTENSIFIERS) {
    const hit = /^[a-z]/.test(m) ? new RegExp(`(?:^|[^a-z])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`).test(tail) : cjkHit(before, m)
    if (!hit) continue
    // 取最强的那一个（"非常非常"不该叠乘）
    if (Math.abs(k - 1) > Math.abs(best - 1)) best = k
  }
  return best
}

const CJK_EXCLUDE: Record<string, RegExp> = {
  太: /^[阳空太]$/,
  超: /^[市级过]$/,
  贼: /^[人喊]$/,
}

function cjkHit(before: string, word: string): boolean {
  const idx = before.lastIndexOf(word)
  if (idx < 0) return false
  const after = before.slice(idx + word.length)
  // 修饰词必须贴着情绪词（中间只允许"地/得/是/了"这类虚词）
  if (!/^[地得是了\s]{0,2}$/.test(after)) return false
  const next = before.slice(idx + word.length, idx + word.length + 1)
  const ex = CJK_EXCLUDE[word]
  if (ex && ex.test(next)) return false
  return true
}

/**
 * PAD → 情绪标签（OCC 家族的子集）。
 *
 * 只给 8 个标签，因为再多就不可解释了：面板要能回答"为什么叫这个名"，
 * 而每个标签的判据就是这里的四个不等式。
 */
export function labelFromPad(pad: Pad): EmotionLabel[] {
  const { v, a, d } = pad
  const out: EmotionLabel[] = []
  const push = (label: string, intensity: number) => {
    if (intensity > 0.15) out.push({ label, intensity: clamp01(intensity) })
  }
  if (v >= 0.15) {
    push('喜悦', v * (0.5 + a * 0.5))
    if (a > 0.55) push('兴奋', (a - 0.5) * v * 1.6)
    if (d > 0.45) push('自豪', d * v * 1.2)
    if (a < 0.35) push('安心', v * (1 - a) * 0.9)
  } else if (v <= -0.15) {
    const nv = -v
    push('难过', nv * (1 - a * 0.5))
    if (a > 0.55) push('愤怒', (a - 0.5) * nv * 1.8)
    if (d < -0.3) push('无力', -d * nv * 1.2)
    if (a > 0.4 && d > 0.2) push('焦虑', a * nv * 0.9)
  } else if (a > 0.6) {
    push('警觉', a * 0.6)
  }
  out.sort((x, y) => y.intensity - x.intensity)
  return out.slice(0, 3)
}

/**
 * 评价 → PAD（Scherer SEC 的线性投影）。
 *
 * 六项评价的含义：
 *   goalRel  与目标一致（正向推进）
 *   goalCon  与目标冲突（阻碍）
 *   agency   谁造成的（自己=高支配，他人=低支配）
 *   certainty 确定程度（确定 → 支配高、唤醒低）
 *   novelty  新异性（新 → 唤醒高）
 *   norm     合乎规范（违逆 → 负面 + 高唤醒）
 *   charge   这句话本身带电多少（与目标无关的情感强度）
 */
export function padFromAppraisal(ap: Appraisal): Pad {
  const charge = ap.charge ?? 0
  const v = clamp11(0.55 * (ap.goalRel - ap.goalCon) + 0.25 * (ap.norm - 0.5) * 2 * 0.5 + 0.4 * charge)
  const a = clamp01(0.5 + 0.25 * (ap.novelty - 0.3) + 0.2 * (ap.goalCon - ap.goalRel) + 0.25 * Math.abs(charge) + 0.15 * (1 - ap.certainty))
  const d = clamp11(0.5 * (ap.agency - 0.5) * 2 * 0.6 + 0.3 * (ap.certainty - 0.5) * 2 * 0.5)
  const s = clamp01(0.2 + 0.4 * ap.novelty + 0.5 * Math.abs(charge) + 0.2 * ap.goalCon)
  return { v, a, d, s }
}

/**
 * 心境积分。τ 是惯性：τ 越大越稳。
 * 用指数滑动平均而不是直接赋值，因为"心境"与"情绪"的区别就是时间常数。
 */
export function integrateMood(prev: Pad, cur: Pad, tau = 20): Pad {
  const k = clamp01(1 / Math.max(1, tau))
  const mix = (a: number, b: number) => a + (b - a) * k
  return {
    v: clamp11(mix(prev.v, cur.v)),
    a: clamp01(mix(prev.a, cur.a)),
    d: clamp11(mix(prev.d, cur.d)),
    s: clamp01(mix(prev.s, cur.s)),
  }
}

/**
 * 心境一致性增益 ∈ [−1, 1]。
 *
 * 两条不对称规则（这是本版相对 v0.5 的**唯一算法改动**，也是它值得单独写注释的原因）：
 *   · 负向侧打折 0.7：难过时想起难过的事会自我强化，这个折扣是反刍的闸
 *   · 低显著度的记忆不吃这条增益：不然"今天天气不错"会因为心情好而挤掉重要事实
 */
export function moodCongruence(mood: Pad, cellValence: number, cellSalience = 0.5): number {
  if (Math.abs(mood.v) < 0.08) return 0
  const align = Math.sign(mood.v) === Math.sign(cellValence) ? Math.abs(cellValence) : -Math.abs(cellValence) * 0.5
  const asym = mood.v < 0 ? 0.7 : 1
  const gate = clamp01(0.4 + cellSalience)
  return clamp11(align * Math.abs(mood.v) * asym * gate)
}

/**
 * 唤醒对巩固的倒 U 调制 ∈ [0.85, 1.35]。
 *
 * 峰值在 a = 0.5（中等唤醒记得最牢）。两端回落：
 *   · a → 0：平静，正常固化
 *   · a → 1：过度唤醒，记忆碎片化（真实的创伤记忆就是这样：细节在，顺序没了）
 * 用 4a(1−a) 是因为它在 [0,1] 上峰值为 1、端点为 0，且不需要额外归一。
 */
export function arousalBoost(arousal: number): number {
  const a = clamp01(arousal)
  const curve = 4 * a * (1 - a)
  return 0.85 + 0.5 * curve
}

/**
 * 情感摘要（给 LLM 的一行上下文）。
 *
 * 约 30 token，格式与 MRS 一致（`A|` 前缀）。它回答模型三个问题：
 * 现在什么心情、为什么、该怎么说话。**不给**"你应该感到…"这类指令。
 */
export function emotionBrief(input: {
  pad: Pad
  labels?: EmotionLabel[]
  unresolved?: number
  trust?: number
  familiarity?: number
  hints?: string[]
}): string {
  const { pad } = input
  const sign = (x: number) => (x >= 0 ? `+${x.toFixed(2)}` : x.toFixed(2))
  const lab = (input.labels ?? labelFromPad(pad))
    .slice(0, 2)
    .map((l) => `${l.label}${l.intensity.toFixed(2)}`)
    .join(',')
  const rel = input.trust === undefined ? '' : `|rel:t${Math.round(input.trust * 100)},f${Math.round((input.familiarity ?? 0) * 100)}`
  const open = input.unresolved ? `|open:${input.unresolved}` : ''
  const hints = input.hints?.length ? `|hint:${input.hints.slice(0, 3).join(';')}` : ''
  return `A|mood:${sign(pad.v)}/${pad.a.toFixed(2)}/${sign(pad.d)}|lab:${lab || 'none'}${rel}${open}${hints}`
}

/**
 * 行为提示：从心境与未平复事件推出"该怎么回"。
 * 这三条是**可测试的策略**，不是文案——面板与命令面都读同一份。
 */
export function behaviorHints(input: { pad: Pad; unresolved?: number; policy?: { requireAcknowledgment?: boolean; verbosity?: number; clarification?: number } }): string[] {
  const out: string[] = []
  if (input.unresolved && input.unresolved > 0) out.push('先接住情绪再谈事')
  if (input.pad.v < -0.3) out.push('语气放软，不要列举')
  if (input.pad.a > 0.7) out.push('句子短一点')
  if (input.policy?.verbosity === -1) out.push('精简')
  if (input.policy?.verbosity === 1) out.push('可展开')
  if ((input.policy?.clarification ?? 0) > 0) out.push('先澄清再动手')
  return out.slice(0, 3)
}

/**
 * 负向自强化闸：连续 N 轮负面时把情感权重压低。
 *
 * 这不是"情绪调节"，是**系统稳定性**：`wAffect` 让难过更容易召回难过的事，
 * 而召回又会经再巩固加强效价——正反馈。v0.5 只靠上限 0.25 挡，
 * 实测在长会话里仍会漂到"越聊越丧"。这里按最近窗口的负面比例再折一次。
 */
export function dampedAffectWeight(base: number, recentValence: number[]): number {
  if (recentValence.length < 4) return base
  const neg = recentValence.filter((v) => v < -0.15).length / recentValence.length
  if (neg <= 0.5) return base
  // 负面占比 0.5 → 1.0，权重线性折到 40%
  const k = 1 - (neg - 0.5) * 1.2
  return Math.max(base * 0.4, base * k)
}

/**
 * 抽取提示词（LLM 端口的唯一真相）。
 *
 * 放在 core 而不是 llm 包里，是因为"抽什么"属于内核契约，
 * "怎么调 API"才属于适配层。换一家模型不应该换一套抽取语义。
 */
export const EXTRACTION_SYSTEM_PROMPT = `你是记忆抽取器。把用户这段话拆成"可独立成立"的命题，每条一个 JSON 对象。
只输出 JSON 数组，不要解释、不要 markdown 代码块。

每个对象的字段：
- subject  主语（人/物/项目），可省略
- predicate 谓词（一个词，如 prefers / uses / decided / failed / met）
- object   宾语（被偏好/被使用/被决定的东西）
- manner   方式或限定（如 "等宽字体" 对应 object "JetBrains Mono"）
- quantity 数量/版本/数值
- time     时间表达（原样，如 "上周三"）
- category event | fact | preference | procedure | relation
- valence  -1..1，说话人对这件事的感受（不是你的判断）
- arousal  0..1，这句话有多"带电"（平静=0.1，激动=0.9）
- salience 0..1，这条值不值得长期记住
- confidence 0..1，抽取的确定程度
- quote    原文片段（≤40 字）

规则：
1. 不抽取寒暄、语气词、对助手的评价。
2. 同一件事的多个属性拆成多条，但不要为凑数而拆。
3. 拿不准就给低 confidence，不要猜。
4. 用户明确说"记住"的内容，salience ≥ 0.8。`

/** 抽取结果的运行时校验（模型会给多余字段、给字符串数字、给越界值）。 */
export function sanitizeFacts(raw: unknown): ExtractedFact[] {
  if (!Array.isArray(raw)) return []
  const out: ExtractedFact[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const pred = str(o.predicate)
    if (!pred) continue
    const cat = str(o.category)
    out.push({
      subject: str(o.subject),
      predicate: pred,
      object: str(o.object),
      manner: str(o.manner),
      quantity: str(o.quantity),
      time: str(o.time),
      category: (['event', 'fact', 'preference', 'procedure', 'relation'] as const).find((c) => c === cat),
      valence: num(o.valence, -1, 1),
      arousal: num(o.arousal, 0, 1),
      salience: num(o.salience, 0, 1),
      confidence: num(o.confidence, 0, 1),
      quote: str(o.quote)?.slice(0, 60),
    })
    if (out.length >= 12) break
  }
  return out
}

function str(x: unknown): string | undefined {
  if (typeof x === 'string') {
    const t = x.trim()
    return t.length > 0 ? t.slice(0, 80) : undefined
  }
  if (typeof x === 'number' && Number.isFinite(x)) return String(x)
  return undefined
}

function num(x: unknown, lo: number, hi: number): number | undefined {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN
  if (!Number.isFinite(n)) return undefined
  return Math.min(hi, Math.max(lo, n))
}
