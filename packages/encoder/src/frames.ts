/**
 * 抽取管线：从句 → 类型化帧（v0.7.0）
 *
 * ── 为什么重写这一层 ─────────────────────────────────────────────
 * 独立审计的结论是：**写入端是产品可用性的总闸**。
 * 默认配置下，实测连最简单的单值事实都会丢：
 *
 *   "我的猫叫雪球"                 → 0 条 cell（整句丢失）
 *   "我不吃辣，但川菜除外"          → 吃辣=states（值、否定、例外全丢）
 *   "生日其实是 3 月不是 4 月"      → 上周说错=is（主题丢失，否定丢失）
 *   "上次提到的那个项目，它的 deadline 提前了" → 上次提到=states（项目与 deadline 全丢）
 *   "新服务用 Go 写、gRPC 通信、部署在杭州，测试继续用 pytest" → 只留 1 条
 *   "我下周要去北京出差三天"        → 只留"下周"（目的地/时长全丢）
 *
 * 根因不是"规则不够多"，而是**结构缺失**：旧实现是"整句 → 一堆槽位"的一步映射，
 * 而语言的最小单位是**从句**。一个从句里有且只有一个谓词，
 * 谓词决定了哪些成分是客体、哪个是取值、否定作用在谁身上。
 * 没有这层结构，就只能靠正则碰运气。
 *
 * 所以这一版把管线拆成三段：
 *
 *   ① 切分（clause）：句末标点 → 逗号/顿号（仅当后半段自带谓词）→ 转折标记
 *   ② 成帧（frame）：每个从句抽出一个 `Frame`（谓词 + 角色 + 极性 + 例外 + 时间/地点/数量）
 *   ③ 过滤（informative）：抽不出任何实质成分的帧**不产出 cell**
 *      ——这是"值槽保护"的推广：宁可不记，也不记一条 `X=states` 的空壳。
 *
 * 三个跨从句能力：**否定传播**（否定作用于谓词与客体，不作用于整句）、
 * **指代回填**（它/那个 → 上一个实体）、**例外与更正**（但…除外 / 不是 Y）。
 *
 * ── 边界 ────────────────────────────────────────────────────────
 * 这仍然是规则，不是句法分析器。它做不到反讽、跨句推理、深层嵌套。
 * 它只保证一件事：**常见句式里的关键成分不会静默消失**。
 * 真正的语义抽取仍然走 `LlmExtractor`（v0.6 端口），规则路径是零依赖基线。
 */

import {
  SLOT_ROLE,
  TOPIC_NOUNS,
  extractEntities,
  isQuestion,
  objectOfVerb,
  parseTimeExpr,
  preferenceFrame,
  type TimeRange,
} from '@rain13sad/llm-mnemo-core'

export interface Frame {
  /** 施事：用户 / 助手 / 工具 */
  agent: string
  /** 谓词（归一后的动词 id） */
  pred: string
  /** 话题/主体（偏好句的"字体"、命名句的"猫"） */
  topic?: string
  /** 客体（"用 pnpm" 的 pnpm） */
  patient?: string
  /** 取值（"字体偏好等宽" 的等宽）——与 topic 配对才有意义 */
  value?: string
  /** 极性：否定作用在谓词与客体上，不作用于整句 */
  polarity: 'pos' | 'neg'
  /** 例外（"但川菜除外" 的川菜） */
  exception?: string
  /** 被否定的旧值（"不是 4 月" 的 4 月）——更新链的输入 */
  negatedValue?: string
  time?: TimeRange
  place?: string
  qty?: string
  /** 原句片段（进 digest 与残差） */
  raw: string
  /**
   * 是否包含实质信息。
   * false 的帧**不产出 cell**：这是"宁可不记，也不记空壳"的判据。
   */
  informative: boolean
  /** 抽取置信度 0..1（规则命中越具体越高） */
  confidence: number
  /**
   * 情感显著性（v0.7.0）。
   *
   * `informative` 的判据不能只看"有没有语义角色"。陪伴场景里
   * "今天真的很难受" 没有任何 (话题, 取值)，但它是**最该被记住的那类话**——
   * 旧实现靠 `fillSlots` 的兜底把它变成一条 `X=states` 空壳，
   * 而新的值槽保护会直接丢掉它。两种都不对。
   *
   * 所以这里单列一条：带显著情感/关系标记的从句，即使没有角色也成帧，
   * 由 `deriveLens` 归到 feeling / bond，并照常参与情感记忆与叙事。
   */
  emotional: boolean
}

// ── 谓词表 ────────────────────────────────────────────────────────

/**
 * 谓词识别。顺序即优先级：越具体的越靠前。
 *
 * 与旧 `detectPredicate` 的差别：
 *   · 补了"命名/居住/出行/就医/日程"这几类高频日常谓词——
 *     它们正是审计实测里丢得最彻底的那批（"猫叫雪球""去北京""住院"）；
 *   · 否定形式单独成条（"不吃" → `eats` + polarity=neg，而不是 `states`）。
 */
const PRED_RULES: Array<{ re: RegExp; pred: string }> = [
  // 命名 / 等同：最高优先级，"X 叫 Y" 与 "X 是 Y" 是最常见的赋值句式
  { re: /叫做|名叫|名为|取名|(?<![不])叫(?![做])/, pred: 'named' },
  { re: /(?:是|为|等于|就是)/, pred: 'is' },
  // 偏好（含否定形式）
  { re: /讨厌|不喜欢|反感|不想要/, pred: 'dislikes' },
  { re: /喜欢|偏好|倾向|习惯|爱用|更愿意/, pred: 'prefers' },
  // 居住 / 出行 / 就医 / 日程
  { re: /住在|搬到|搬家|居住/, pred: 'lives' },
  /**
   * 位置（v0.7.1）。
   *
   * 审计 R1 的根因之一："办公室在浦东" 里没有 `在` 这个谓词，
   * 整句落到 `states`，而 `informative` 要求 `pred !== 'states'`——
   * 于是**第一句就没有 cell**，三阶段改口从起点就断了。
   *
   * 中文的"在"既是存在动词也是介词，无法靠单一正则区分，
   * 所以这里只认明确的定位动词，裸"X在Y"由 `detectLocative()` 用形态判据补。
   */
  { re: /位于|坐落于|坐落|定在|设在|落在|安在/, pred: 'located' },
  { re: /住院|做手术|确诊|生病|发烧|去世|离世/, pred: 'hospitalized' },
  { re: /出差|去|前往|到访|飞往|赶到/, pred: 'goes' },
  { re: /开会|面试|复诊|体检|汇报|答辩|截止|到期|交付/, pred: 'scheduled' },
  { re: /工作|上班|就职|任职|入职|离职/, pred: 'works' },
  { re: /上学|读书|读研|读博|学习/, pred: 'studies' },
  // 饮食/忌口：审计实测里"我不吃辣"整句丢值，就是因为没有这一类
  { re: /吃|喝|忌口/, pred: 'eats' },
  // 工程动作
  { re: /改用|换成|换到|改到|迁到|切换到|改成|切换|提前|推迟/, pred: 'changes' },
  { re: /使用|采用|统一用|一律按|按|(?<![用应费适作利])用(?![户来以于])/, pred: 'uses' },
  { re: /决定|定了|选定|敲定/, pred: 'decides' },
  { re: /修好|修复|解决了/, pred: 'fixes' },
  { re: /报错|失败|崩了|挂了|跑不起来|不通过/, pred: 'fails' },
  { re: /部署|上线|发布/, pred: 'deploys' },
  { re: /通信|通讯|调用|对接/, pred: 'communicates' },
  /**
   * 讨论/商量（v0.7.1）。
   *
   * 这是会议记录类长文本里出现频率最高的谓词。缺了它，
   * "我们讨论了缓存分片方案" 会落到 `states`，整段被当成空壳丢掉——
   * 而它恰恰是"该被记住"的那种内容（长文本的存储比测试也依赖这条）。
   */
  { re: /讨论|商量|聊了|沟通了|评审了/, pred: 'discusses' },
  /**
   * 耗时/运行必须排在 `uses` / `changes` **之后**。
   *
   * "我们用 vitest 跑测试" 的主谓是"用 vitest"（工具选择），"跑"只是补语。
   * 如果 `runs` 抢在前面，两句改口（vitest → jest）会被归成同一个 `runs` 家族，
   * 矛盾检测拿不到 (uses, patient=vitest/jest) 这个真正的对照键——
   * 实测后果是 SUPERSEDES 边一条都建不起来。
   */
  { re: /跑|运行|耗时/, pred: 'runs' },
  { re: /记住|记一下|记下/, pred: 'asserts' },
  { re: /有|养|拥有/, pred: 'has' },
]

/** 否定词：只认紧邻谓词/客体的那些，避免"我不觉得这不好"这类双重否定误判。 */
const NEG_CUE = /(不|没|没有|别|未|无需|不再|从不)/

/** 转折词：用来识别"但…除外"这类例外。 */
const CONTRAST = /(但是|但|不过|可是|然而|只是)/

/** 例外标记。 */
const EXCEPTION_RE = /(?:但|不过|可是|除了|除)\s*([^，。；,;]{1,20}?)\s*(?:除外|以外|之外|都可以|都行|随便)?$/

/**
 * 情感/关系显著性。
 *
 * 与 `crisis.ts` 的危机词表**用途不同**：那边判断"要不要转介"，
 * 这边判断"值不值得记"。两者刻意分开——危机是安全边界，情感显著性只是记忆价值。
 */
const AFFECT_STRONG =
  /难受|难过|痛苦|委屈|崩溃|绝望|压抑|孤独|寂寞|焦虑|害怕|生气|愤怒|气死|烦死|无语|心烦|烦|累|疲惫|想哭|哭了|开心|高兴|幸福|感动|踏实|安心|谢谢|感谢|对不起|抱歉|我们一起|陪我|陪你|和好|吵架|约定|答应|做不好|没用|撑不住/

/**
 * 更正标记："不是 X" → 被否定的旧值。
 *
 * 这是知识更新链（SUPERSEDES）真正能拿到输入的入口：
 * 旧实现里"不是 4 月"整段丢失，于是矛盾检测永远发现不了"改口"。
 */
const NEGATED_VALUE_RE = /(?:不是|并非|不再是|而不是)\s*([^，。；,;\s]{1,16})/

// ── 切分 ──────────────────────────────────────────────────────────

/** 句末切分：保留标点后不做二次处理。 */
const SENTENCE_SPLIT = /(?<=[。！？；!?;])|\n+/

/**
 * 从句切分。
 *
 * 逗号/顿号不是无条件切分点——"深色主题，浅色看久了眼睛疼" 的前半句没有谓词，
 * 切开会产生一条不可检索的碎片。所以只有在**后半段自带谓词**时才切。
 * 这条规则让"新服务用 Go 写、gRPC 通信、部署在杭州" 切成四段而不是一段。
 */
export function splitClauses(text: string): string[] {
  const out: string[] = []
  for (const sent of text.split(SENTENCE_SPLIT)) {
    const s = sent.trim()
    if (!s) continue
    const parts = s.split(/[，,、]/).map((x) => x.trim()).filter(Boolean)
    let buf = ''
    for (const p of parts) {
      if (!buf) {
        buf = p
        continue
      }
      // 后半段有谓词 → 独立成句；否则并回（避免碎片）
      if (hasPredicate(p)) {
        out.push(buf)
        buf = p
      } else {
        buf += '，' + p
      }
    }
    if (buf) out.push(buf)
  }
  return out
}

function hasPredicate(s: string): boolean {
  return PRED_RULES.some((r) => r.re.test(s))
}

function detectPred(s: string): string {
  for (const r of PRED_RULES) if (r.re.test(s)) return r.pred
  return 'states'
}

// ── 角色抽取 ──────────────────────────────────────────────────────

/**
 * 谓词之前的主语片段。
 *
 * 处理两种常见噪声：
 *   · 逗号后的人称（"ui.theme 这件事上，我偏好 X" → 去掉"，我"）；
 *   · 话题化的后缀（"…这件事上" / "…这方面"）。
 */
function subjectBefore(clause: string, verbRe: RegExp): string | undefined {
  const before = clause.split(verbRe)[0]
  if (!before) return undefined
  const cleaned = before
    .replace(/[，,]\s*(我们|我)\s*$/, '')
    .replace(/(我们|我)\s*$/, '')
    .replace(/(这件事上|这方面|这一点上|方面)$/, '')
    .trim()
  return cleaned || undefined
}

/** 话题/主体清理：去掉人称与程度副词，保留中心名词。 */
function cleanTopic(x?: string): string | undefined {
  if (!x) return undefined
  let t = x
    .replace(/[《》「」“”"']/g, '')
    // 程度/语气副词可能出现在**两端**："其实我更喜欢…" 与 "生日其实…"
    .replace(/^(其实|更|还|也|都|很|太|最|真的|确实|比较|目前|现在|最近)/g, '')
    .replace(/(其实|更|还|也|都|很|太|最|真的|确实|比较|目前|现在|最近|又|再|还是)$/g, '')
    // 长分支必须排在前面：`我|我们` 会把"我们"切成"们"
    .replace(/^(我们的|我们|我的|我|你的|你)/g, '')
    // 谓词/副词残留："我习惯 X 是 Y" 的主语是 X，不是"习惯 X"
    .replace(/^(决定|定了|选定|敲定|以后|一律|统一|继续|一般|通常|习惯|喜欢|偏好|倾向|按|照)/g, '')
    // 话语标记不是话题："最终定在静安寺" 的主语不是"最终"
    .replace(/^(其实|最终|最后|后来|结果|反正|总之|然后|所以|另外|顺便)/g, '')
    // 祈使/否定标记不是话题（"别用 npm" 的话题不该是"别"）
    .replace(/^(别|不要|请|务必|记得|千万别|不准|禁止)/g, '')
    // 指示代词做定语时剥掉："那个项目" → "项目"（它不携带信息）
    .replace(/^(那个|这个|那些|这些|该|那|这)/g, '')
    .replace(/(的|了|呢|吧|啊)$/g, '')
    .replace(/(一律|统一|都|就|继续)$/g, '')
    .replace(/(这件事上|这方面|上|方面)$/g, '')
    .trim()
  /**
   * 长度上限按形态分：
   *   · 标识符（`test.framework` / `ui.theme`）可以到 24 —— 配置类陈述的主语几乎都是这种；
   *   · 自然语言片段限 12，超过基本是没切干净的长句。
   * 一刀切 12 会把 `test.framework`（14 字符）判成无效，主语整段丢掉。
   */
  const maxLen = /[._]/.test(t) ? 24 : 12
  if (t.length < 1 || t.length > maxLen) return undefined
  if (/^(用户|助手|工具|系统)$/.test(t)) return undefined
  // 指代词不能当话题：它不携带信息，必须靠回填
  if (/^(它|他|她|它们|那个|这个|该|其|这|那)$/.test(t)) return undefined
  return t
}

/** 取值清理：去掉书名号与尾巴助词，但**不截断内容**（值就是值）。 */
function cleanValue(x?: string): string | undefined {
  if (!x) return undefined
  const v = x
    .replace(/[《》「」“”"']/g, '')
    /**
     * 取值**不能跨标点**。
     *
     * "以后 ui.theme 一律按 深色主题 来，别再改了" 的取值是"深色主题"，
     * 而不是"深色主题 来，别再改了"——后者作为 PATIENT 会让
     * "同一件事被改了"永远对不上（槽位值必须可比较）。
     */
    .split(/[，,。；;！？!?]/)[0]
    // "3 月不是 4 月"：值只到"不是"之前——否定部分是 negatedValue，不是取值的一部分
    .split(/(?:不是|并非|不再是|而不是)/)[0]
    .replace(/^[用把将]/, '')
    .replace(/[来去]$/, '')
    .replace(/[的了呢吧啊]$/, '')
    .trim()
  if (!v || v.length > 24) return undefined
  return v
}

/**
 * 动宾宾语（按谓词分派）。
 *
 * `objectOfVerb` 只认"用/改用/采用"，覆盖不到"吃辣""住在杭州"这类日常谓词——
 * 而它们正是审计实测里丢值最彻底的那批。这里按谓词各给一条**窄**正则：
 * 窄是为了不误抽（"我不吃辣"抽"辣"，不能抽成"辣但我"）。
 */
const VERB_OBJECT: Array<{ pred: string; re: RegExp }> = [
  { pred: 'eats', re: /(?:吃|喝)\s*([\u4e00-\u9fa5A-Za-z]{1,8})/ },
  { pred: 'lives', re: /住在?\s*([\u4e00-\u9fa5A-Za-z]{2,10})/ },
  { pred: 'works', re: /(?:在)\s*([\u4e00-\u9fa5A-Za-z]{2,10})\s*(?:工作|上班)/ },
  { pred: 'studies', re: /(?:在|读)\s*([\u4e00-\u9fa5A-Za-z]{2,10})/ },
  { pred: 'has', re: /(?:养|有)\s*(?:了|一只|一个|一条)?\s*([\u4e00-\u9fa5A-Za-z]{1,10})/ },
]

/**
 * 主语（谓词之前的部分）。
 *
 * "新服务用 Go 写" → 主语"新服务"；"测试继续用 pytest" → 主语"测试"。
 * 旧实现完全没有这一步，所以复合句里四个分句的主语全丢了。
 */
const SUBJECT_BEFORE_VERB: Array<{ pred: string; re: RegExp }> = [
  { pred: 'uses', re: /^(.{1,12}?)(?:继续|统一|也|都|就)?\s*(?:用|使用|采用)/ },
  { pred: 'communicates', re: /^(.{1,12}?)\s*(?:通信|通讯|调用|对接)/ },
  { pred: 'changes', re: /^(.{1,12}?)(?:改用|换成|换到|改到|切换到|改成)/ },
  { pred: 'deploys', re: /^(.{1,12}?)(?:部署|上线|发布)/ },
  { pred: 'fails', re: /^(.{1,12}?)(?:报错|失败|崩了|挂了)/ },
  { pred: 'runs', re: /^(.{1,12}?)(?:跑|运行|耗时)/ },
  { pred: 'prefers', re: /^(.{1,12}?)(?:喜欢|偏好|讨厌|不喜欢)/ },
]

/** 数量：中文数字与阿拉伯数字都认，单位必须出现（否则"3 月"会被当成数量）。 */
const QTY_RE = /(\d+(?:\.\d+)?|[一二三四五六七八九十两半几]+)\s*(天|日|周|个星期|个月|年|小时|分钟|次|个|条|行|人|岁|公里|千米|%|ms|kb|mb|gb)/

/**
 * 地点：在/去/到/往 + 地名或机构。`(?!的|了)` 排除"上次提到的那个项目"这类误命中。
 *
 * v0.7.1：允许吞掉**尾部的语气助词**。
 * "其实搬到徐汇了" 旧版把地点捕成 `徐汇了`——而冲突判定是**按槽位值比较**的，
 * "徐汇" 与 "徐汇了" 不相等，于是"同一件事被改了"永远对不上。
 * 一个助词就能让整条更新链失效，这类"值污染"必须在抽取层清掉。
 */
const PLACE_RE = /(?:在|去|到|往|从)\s*(?![的了])([\u4e00-\u9fa5A-Za-z]{2,10}?)(?:了|的|呢|吧|啊|啦)?(?=[出差住在待见开会工作上学读书玩]|$|[，。；,;])/

/**
 * 裸"X 在 Y"的位置句（v0.7.1）。
 *
 * 判据刻意保守：`Y` 必须是**看起来像地点**的短语——
 * 否则 "我在写代码" 会被抽成 `在=写代码`，比不记更糟。
 * 形态判据两条：以行政区/建筑后缀结尾，或短且不含动词。
 */
const LOCATIVE_RE =
  /^(.{1,12}?)(?:其实|已经|就|一直|现在|目前|后来|最终|最后)?\s*(?:在|于)\s*([\u4e00-\u9fa5A-Za-z]{2,10})[。！？；!?;，,\s]*$/

const PLACE_SUFFIX = /(区|市|路|街|道|楼|室|园|院|寺|镇|村|县|州|港|站|城|岛|山|湖|湾|中心|大厦|广场|小区|校区|园区|基地|总部|分部|分公司)$/

/**
 * 允许"跨轮携带话题"的谓词。
 *
 * 判据是**这个谓词描述的是不是主体的某个属性**。属性句可以省略主语
 * （"办公室在浦东" → "搬到徐汇"），事件句不能（"我妈住院" → "买了水果"）。
 *
 * 表刻意**极窄**，只留"位置/部署/改动"四类。原因是被污染的话题会**直接
 * 生成假记忆并触发错误取代**——实测把 24 个配置项连续写入时，
 * 一句"以后 ui.font 一律按 无衬线字体"如果自身没抽到话题，
 * 就会继承上一轮的 `i18n.mode`，然后以"同一件事"的身份把真正的 i18n.mode 判成失效。
 * 一次携带错误 = 丢一条正确记忆 + 多一条错误记忆，比漏记严重得多。
 */
const CARRY_PREDS = new Set(['located', 'lives', 'changes', 'deploys'])

/** 动词开头 → 是"在做什么"，不是"在哪里"。 */
const VERB_TAIL = /^(写|做|看|想|说|改|跑|学|吃|等|开|测|调|处|忙|加|查|读|听|睡|玩|买|卖|搞|弄|试|整|装|修)/

function looksLikePlace(x: string): boolean {
  if (!x || x.length < 2) return false
  if (VERB_TAIL.test(x)) return false
  if (/[，,。；;！？!?]/.test(x)) return false
  return PLACE_SUFFIX.test(x) || x.length <= 6
}

/**
 * 谓词判定 + 位置句补判。
 *
 * 只在**规则没能给出实义谓词**（states）时才补，避免抢走 "我在写代码" 之外的正常句子。
 */
function detectPredWithLocative(clause: string): { pred: string; loc?: { topic?: string; value?: string } } {
  const pred = detectPred(clause)
  if (pred !== 'states') return { pred }
  const m = clause.match(LOCATIVE_RE)
  if (!m) return { pred }
  const topic = cleanTopic(m[1])
  const value = cleanValue(m[2])
  if (!value || !looksLikePlace(value)) return { pred }
  return { pred: 'located', loc: { topic, value } }
}

/** 命名/等同句的主体：`我的猫叫雪球` 的"我的猫"。 */
const NAMED_SUBJECT_RE = /^(.{1,14}?)(?:叫做|名叫|名为|取名|叫|是|为)\s*(.+)$/

/** 就医句的主体：`我妈最近住院了` 的"我妈"。 */
const HOSPITAL_SUBJECT_RE = /^(.{1,10}?)(?:最近|刚刚|已经|上周|前天|昨天|今天)?\s*(?:住院|做手术|确诊|生病|发烧|去世|离世)/

// ── 主流程 ────────────────────────────────────────────────────────

export interface ParseOptions {
  /** 施事默认值：用户消息 → '用户' */
  agent?: string
  /** 时间基准 */
  now?: number
  /** 上一轮/上一句的实体（指代回填用） */
  prevEntities?: string[]
  /**
   * 上一轮的话题（跨轮话题携带，v0.7.1）。
   *
   * 中文的改口几乎都不重复主语：
   *   "办公室在浦东。" → "其实搬到徐汇了。" → "最终定在静安寺。"
   * 后两句没有主语。不带话题的话，它们会变成两条**无主**的位置记忆，
   * 冲突检测拿不到 MANNER 键，于是"现在到底在哪"永远答不出来——
   * 这正是审计 R1（P0）的实测形态。
   */
  carryTopic?: string
}

/**
 * 从句 → 帧。
 *
 * 返回的帧里 `informative=false` 的那些**不应产出 cell**：
 * 它们要么是纯情绪（"气死了"）、要么是纯语气（"好的"）、要么是抽不出任何成分的碎片。
 * 旧实现会把它们变成 `X=states` 的空壳——那比不记更糟，因为它会参与去重与矛盾检测。
 */
export function parseFrames(text: string, opts: ParseOptions = {}): Frame[] {
  const agent = opts.agent ?? '用户'
  const now = opts.now ?? Date.now()
  const frames: Frame[] = []
  /** 指代回填用的最近实体（跨从句累积） */
  let lastEntity: string | undefined = opts.prevEntities?.filter(Boolean).slice(-1)[0]
  /**
   * 话题携带（v0.7.0）。
   *
   * 中文习惯把话题单独说成一个短语："ui.theme 这件事上，我偏好 深色主题。"
   * 从句切分之后，前半段没有谓词（会被丢弃），后半段有谓词但没主语——
   * 于是"哪一项被偏好"这个键整段消失。
   *
   * 这里让"没有谓词但带标识符/名词"的从句变成**话题载体**，交给下一个成帧的从句使用。
   */
  let pendingTopic: string | undefined

  for (const clause of splitClauses(text)) {
    // 疑问句不是断言（"我之前说的字体偏好是什么？"不该被记成一条事实）
    if (isQuestion(clause)) continue

    const predInfo = detectPredWithLocative(clause)
    const pred = predInfo.pred
    const loc = predInfo.loc
    const polarity: 'pos' | 'neg' = NEG_CUE.test(clause) ? 'neg' : 'pos'
    const time = parseTimeExpr(clause, now)
    const qtyMatch = clause.match(QTY_RE)
    const placeMatch = clause.match(PLACE_RE)
    const exception = clause.match(EXCEPTION_RE)?.[1]?.trim()
    const negatedValue = clause.match(NEGATED_VALUE_RE)?.[1]

    let topic: string | undefined
    let patient: string | undefined
    let value: string | undefined
    let confidence = 0.5

    // 位置句的直接产物（"办公室在浦东" 的 办公室 / 浦东）
    if (loc) {
      topic = loc.topic
      value = loc.value
      confidence = 0.8
    }

    /**
     * 指代回填：从句以"它/他/她/那个/这/该"开头，或含"它的/那个的"，
     * 且自身没有明确主体时，用上一个实体补上。
     *
     * 这是审计实测里丢得最狠的一类（"上次提到的那个项目，它的 deadline 提前了"），
     * 因为指代词本身不携带任何信息。
     */
    const pronominal = /^(它|他|她|那个|这个|该|其)/.test(clause) || /(它的|他的|她的|那个的)/.test(clause)
    const backfilled = pronominal ? lastEntity : undefined

    // ① 命名 / 等同句：X 叫 Y / X 是 Y
    if (pred === 'named' || pred === 'is') {
      const m = clause.match(NAMED_SUBJECT_RE)
      if (m) {
        topic = cleanTopic(m[1]) ?? backfilled
        value = cleanValue(m[2])
        confidence = 0.85
      }
    }

    // ② 偏好句：'字体我也偏好等宽' → topic=字体, value=等宽
    if (pred === 'prefers' || pred === 'dislikes') {
      const pref = preferenceFrame(clause)
      if (pref.topic) topic = cleanTopic(pref.topic) ?? topic
      if (pref.value) value = cleanValue(pref.value) ?? value
      /**
       * 主语在偏好动词**之前**："ui.theme 这件事上，我偏好 深色主题"。
       * `preferenceFrame` 只往后看（取值），话题要靠这里往前取——
       * 否则标识符形式的 key（ui.theme）会整段丢掉，只剩取值。
       */
      if (!topic) {
        topic = cleanTopic(subjectBefore(clause, /(?:喜欢|偏好|倾向|习惯|讨厌|不喜欢)/))
      }
      // '我最喜欢的电影是《星际穿越》'：偏好句 + 等同 → 电影/星际穿越
      if (!value) {
        const m = clause.match(/^.{0,6}?(?:喜欢|偏好|讨厌|习惯)的?\s*([^，。；,;]{1,12}?)\s*(?:是|为)\s*(.+)$/)
        if (m) {
          topic = cleanTopic(m[1]) ?? topic
          value = cleanValue(m[2]) ?? value
        }
      }
      /**
       * 话题名词只在**偏好动词之前**找。
       *
       * "ui.theme 这件事上，我偏好 深色主题" 里 `主题` 出现在**取值**内部，
       * 旧写法 `clause.includes(t)` 会把它当成话题，于是 topic=主题、
       * value=深色主题——两个都"对"，但"哪一项被偏好"这个键丢了。
       */
      if (!topic) {
        const before = subjectBefore(clause, /(?:喜欢|偏好|倾向|习惯|讨厌|不喜欢)/) ?? ''
        const noun = TOPIC_NOUNS.find((t) => before.includes(t))
        if (noun) topic = noun
      }
      /**
       * 取值尾部的中心名词要拆出来当话题。
       *
       * "我更喜欢用 pnpm 构建" 的取值是 `pnpm`、话题是 `构建`，
       * 而 `preferenceFrame` 会给出 value="pnpm 构建"。
       * 不拆的话，这条 cell 里没有任何"构建"槽位——问"我用什么构建"就匹配不上，
       * 而"构建"恰恰是用户提问时会用的词（实测真实语料里这类查询占多数）。
       */
      if (value && !topic && !pendingTopic) {
        const v = value
        const tail = TOPIC_NOUNS.find((t) => v.endsWith(t) && v !== t)
        if (tail) {
          topic = tail
          value = v.slice(0, -tail.length).trim() || v
        }
      }
      confidence = 0.8
    }

    // ③ 就医 / 日程：主体在谓词之前
    if (pred === 'hospitalized' || pred === 'scheduled') {
      const m = clause.match(HOSPITAL_SUBJECT_RE)
      if (m) {
        topic = cleanTopic(m[1]) ?? backfilled
        confidence = 0.75
      } else {
        topic = backfilled
      }
    }

    /**
     * ④ 二元组："A 用/是/按 B" → topic=A, value=B。
     *
     * 必须排在"主语在谓词之前"之前，而且**主语允许是标识符**——
     * 配置类陈述的主语几乎都是 `ui.theme` / `build.tool` 这种带点的键，
     * 而旧实现只往动词后面找宾语，主语整段丢掉（"哪一项被改了"这个信息就没了）。
     *
     * 实测后果不是"少一条记忆"，而是 bench 的 ground truth 找不到对应 cell，
     * 数据集从 36 条掉到 12 条——指标看起来变好，其实是在更小的样本上算的。
     */
    if (!topic && !value) {
      const pair = clause.match(
        /^(.{1,28}?)\s*(?:决定|定了|选定|敲定|以后|一律|统一|都|就|继续|一般|通常)?\s*(?:改用|换成|切换到|改成|使用|采用|一律按|用(?![户来以于])|是|为|按)\s*(.+)$/,
      )
      if (pair) {
        const head = cleanTopic(pair[1])
        const tail = cleanValue(pair[2])
        if (head && tail && head !== tail) {
          topic = head
          value = tail
          confidence = Math.max(confidence, 0.8)
        }
      }
    }

    /**
     * ④b 主语（谓词之前的那一段）。
     *
     * 复合句的每一段都有自己的主语，旧实现完全没有这一步——
     * "新服务用 Go 写、gRPC 通信、部署在杭州" 因此只剩一条。
     */
    if (!topic) {
      const sub = SUBJECT_BEFORE_VERB.find((x) => x.pred === pred)
      const m = sub ? clause.match(sub.re) : null
      if (m) {
        topic = cleanTopic(m[1])
        if (topic) confidence = Math.max(confidence, 0.7)
      }
    }

    /**
     * ④d 话题名词优先。
     *
     * "我们用 vitest 跑测试" 与 "我们改成 jest 跑测试" 的**共同话题是"测试"**，
     * 而主体位置（"我们"）被剥掉之后两边都抽不到话题，矛盾检测就失去了 MANNER 键。
     * `TOPIC_NOUNS` 正是为这种"同一件事被改了"准备的——它比实体兜底稳定得多。
     */
    if (!topic) {
      /**
       * 只在**取值之外**找话题名词。
       *
       * 两件事一起防：
       *   · "ui.theme 这件事上，我偏好 深色主题" 的 `主题` 在取值内部；
       *   · "我们决定用 pnpm 部署" 的 `部署` 才是话题（`pnpm` 是取值）。
       * 判据是"这个名词不出现在已抽到的 patient/value 里"——
       * 比"只看谓词之前"更稳，因为中文的话题位置很自由。
       */
      const noun = TOPIC_NOUNS.find(
        (t) => clause.includes(t) && !(patient ?? '').includes(t) && !(value ?? '').includes(t),
      )
      if (noun) {
        topic = noun
        confidence = Math.max(confidence, 0.7)
      }
    }

    // ⑤ 动宾宾语：'吃辣' → 辣，'用 pnpm' → pnpm
    if (!patient) {
      const byPred = VERB_OBJECT.find((x) => x.pred === pred)
      const m = byPred ? clause.match(byPred.re) : null
      if (m) {
        patient = cleanValue(m[1])
        if (patient) confidence = Math.max(confidence, 0.7)
      } else {
        const obj = objectOfVerb(clause)
        if (obj) {
          patient = cleanValue(obj)
          if (patient) confidence = Math.max(confidence, 0.7)
        }
      }
    }

    // ⑥ 通用主体：X 的 Y —— 优先取"的"后面的名词（"那个项目"比"上次提到"更像主体）
    if (!topic) {
      const poss = clause.match(/^(.{1,10}?)的\s*([\u4e00-\u9fa5A-Za-z_.\-]{2,12})/)
      if (poss) {
        /**
         * 定语是人称/指代词（"它的 deadline"）→ 主体靠回填；
         * 定语是实义短语（"上次提到的那个项目"）→ 主体取"的"后面的名词。
         */
        const head = cleanTopic(poss[1])
        const tail = cleanTopic(poss[2])
        topic = head ? tail ?? head : backfilled
        if (!patient) patient = cleanValue(poss[2])
        confidence = Math.max(confidence, 0.65)
      }
    }

    /**
     * 位置类谓词：**地点就是取值**（v0.7.1）。
     *
     * "最终定在静安寺" 的地点被 `PLACE_RE` 抽到了 PLACE 槽，但取值槽是空的。
     * 冲突判定按 `PATIENT`（= 取值）比较，取值空 ⇒ `valueDiffers` 判否 ⇒
     * 第三句明明说了新地址，却没能取代第二句。实测后果是"现在在哪"答中间那一版。
     *
     * 所以位置句必须把地点同时写进取值：PLACE 是"在哪儿"的语义角色，
     * PATIENT 是"这一项被改成了什么"的对照键，两者都要。
     */
    if (!value && !patient && (pred === 'located' || pred === 'lives') && placeMatch?.[1]) {
      value = cleanValue(placeMatch[1])
      confidence = Math.max(confidence, 0.75)
    }

    /**
     * 话题与客体相同时只保留话题。
     *
     * "它的 deadline 提前了" 会同时给出 topic=deadline、patient=deadline，
     * 而 `frameToSlots` 里 MANNER 与 PATIENT 同值会让矛盾检测把"同一件事"判成两件。
     */
    if (topic && patient && topic === patient) patient = undefined

    /**
     * ⑦ 兜底：从实体里挑最长的当话题。
     *
     * **只在"状态类谓词"上启用**。移动/就医/日程类谓词的句子主语往往就是动作本身
     * （"去北京出差" → 抽出来的是"去北京出"），硬兜底只会制造垃圾话题。
     */
    const movementLike = pred === 'goes' || pred === 'hospitalized' || pred === 'scheduled'
    if (!topic && !patient && !value && !placeMatch && pred !== 'states' && !movementLike) {
      const ents = extractEntities(clause).filter(
        (e) =>
          !/^#/.test(e) &&
          // 谓词自己的英文规范形不能当话题（"部署在杭州" → 实体是 deploy → 话题也成 deploy）
          e !== pred &&
          e !== pred.replace(/s$/, ''),
      )
      const best = ents.sort((a, b) => b.length - a.length)[0]
      if (best && best.length >= 2) {
        topic = cleanTopic(best)
        confidence = Math.min(confidence, 0.45)
      }
    }

    if (backfilled && !topic) topic = backfilled

    /**
     * 跨轮话题携带（v0.7.1）。
     *
     * 只对**属性类谓词**生效：位置、居住、工作、就读、改用、采用、决定、偏好。
     * 这些句式的共同点是"说的还是上一句那个东西，只是换了取值"。
     * 对叙事类谓词（住院/去/失败）刻意不携带——"我妈住院了"之后
     * 紧接一句"买了水果"，不该被记成"我妈买了水果"。
     */
    if (!topic && opts.carryTopic && CARRY_PREDS.has(pred)) {
      topic = opts.carryTopic
      confidence = Math.max(confidence, 0.65)
    }
    // 话题携带：上一段只说了"X 这件事上"，本段负责说取值
    if (!topic && pendingTopic) {
      topic = pendingTopic
      pendingTopic = undefined
      confidence = Math.max(confidence, 0.7)
    }

    const informative = Boolean(topic || patient || value || placeMatch?.[1] || qtyMatch?.[1]) && pred !== 'states'
    const emotional = AFFECT_STRONG.test(clause)
    // 纯情绪/语气片段：没有谓词也没有成分 → 不产出
    const frame: Frame = {
      agent,
      pred,
      topic,
      patient: patient ?? undefined,
      value: value ?? undefined,
      polarity,
      exception: exception && exception.length >= 1 ? exception : undefined,
      negatedValue: negatedValue ? cleanValue(negatedValue) : undefined,
      time,
      place: placeMatch?.[1],
      qty: qtyMatch ? `${qtyMatch[1]}${qtyMatch[2]}` : undefined,
      raw: clause,
      // 情感显著的话即使没有语义角色也要记——它是陪伴场景的核心素材
      informative: informative || Boolean(exception || negatedValue) || emotional,
      confidence: informative ? confidence : emotional ? 0.4 : 0.2,
      emotional,
    }
    frames.push(frame)

    /**
     * 无谓词从句 → 话题载体。
     *
     * "ui.theme 这件事上" 单独成段时它没有谓词、不该成为一条记忆，
     * 但它携带了**下一句的话题**。丢掉它，后面那句就只剩取值。
     */
    if (!frame.informative) {
      const cand =
        extractEntities(clause).find((e) => /[._]/.test(e)) ??
        cleanTopic(subjectBefore(clause, /[，,。！？；]|$/)?.replace(/(这件事上|这方面|这一点上)$/, ''))
      if (cand && cand.length >= 2) pendingTopic = cand
    }

    /**
     * 更新指代回填的锚点。
     *
     * 优先用**干净的名词**（话题），其次取值/客体；如果话题本身像句子碎片
     * （长度 > 6 或含动词），改用实体里最长的那个——"上次提到的那个项目"
     * 的话题是"上次提到"这种垃圾，而实体里有"项目"。
     */
    let anchor = frame.topic
    if (!anchor || anchor.length > 6) {
      const ents = extractEntities(clause).filter((e) => !/^#/.test(e) && !/^(deploy|bug)$/.test(e))
      const best = ents.sort((a, b) => b.length - a.length)[0]
      anchor = (best && best.length >= 2 ? best : frame.topic) ?? frame.value ?? frame.patient
    }
    if (anchor && anchor.length >= 1) lastEntity = anchor
  }

  return frames
}

/** 帧 → digest（一行可读摘要，进残差与面板；不进 MRS 正文）。 */
export function frameDigest(f: Frame): string {
  const bits: string[] = []
  if (f.topic) bits.push(f.topic)
  const zh = PRED_ZH[f.pred]
  /**
   * 谓词与话题重复时不重复输出。
   *
   * `extractEntities` 会把"部署"归一到 `deploy`，于是 topic 可能已经是谓词的
   * 英文规范形——此时再打印一次中文谓词就成了 "deploy 部署 在杭州"。
   * `goes` 且已抽出地点时同理（"去 去北京"）。
   */
  const topicHasPred =
    (f.pred === 'goes' && !!f.place) ||
    (!!f.topic &&
      (f.topic === f.pred ||
        f.topic === f.pred.replace(/s$/, '') ||
        (!!zh && f.topic.includes(zh))))
  if (f.pred && f.pred !== 'states' && zh && !topicHasPred) {
    bits.push(zh)
  }
  if (f.value) bits.push(f.value)
  else if (f.patient) bits.push(f.patient)
  // 位置句里 value 与 place 是同一个东西（"办公室在浦东"），不重复打印
  if (f.place && f.place !== (f.value ?? f.patient)) {
    bits.push(f.pred === 'goes' ? `去${f.place}` : `在${f.place}`)
  }
  if (f.qty) bits.push(f.qty)
  if (f.exception) bits.push(`但${f.exception}除外`)
  if (f.negatedValue) bits.push(`不是${f.negatedValue}`)
  const body = bits.filter(Boolean).join(' ')
  const neg = f.polarity === 'neg' && !f.exception ? '（否定）' : ''
  return (body || f.raw).slice(0, 120) + neg
}

/**
 * 帧 → 语义槽位。
 *
 * 映射规则（每条都有理由）：
 *   · `topic`  → MANNER（话题）。矛盾检测靠 (AGENT, PRED, MANNER) 定位"同一件事"
 *   · `value`  → PATIENT（取值）。**value 优先于 patient**：
 *     "字体偏好等宽" 的客体是"等宽"，不是"字体"
 *   · `place`  → PLACE，`qty` → QTY，`time` → TIME（ISO 日期，便于区间比较）
 *   · `exception` → EXCEPTION，`negatedValue` → NEGVALUE
 *   · 极性 → POLARITY（否定作用在谓词与客体上，不作用于整句）
 */
export function frameToSlots(f: Frame): Array<{ role: number; type: 'LIT'; value: string }> {
  const out: Array<{ role: number; type: 'LIT'; value: string }> = []
  const lit = (role: number, value: string) => out.push({ role, type: 'LIT' as const, value: value.slice(0, 64) })

  lit(SLOT_ROLE.AGENT, f.agent)
  lit(SLOT_ROLE.PRED, f.pred)
  if (f.topic) lit(SLOT_ROLE.MANNER, f.topic)
  const patient = f.value ?? f.patient
  if (patient) lit(SLOT_ROLE.PATIENT, patient)
  if (f.place) lit(SLOT_ROLE.PLACE, f.place)
  if (f.qty) lit(SLOT_ROLE.QTY, f.qty)
  if (f.time) {
    const d = new Date(f.time.from)
    lit(SLOT_ROLE.TIME, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  if (f.exception) lit(SLOT_ROLE.EXCEPTION, f.exception)
  if (f.negatedValue) lit(SLOT_ROLE.NEGVALUE, f.negatedValue)
  lit(SLOT_ROLE.POLARITY, f.polarity)
  return out
}

const PRED_ZH: Record<string, string> = {  named: '叫',
  is: '是',
  prefers: '偏好',
  dislikes: '不喜欢',
  eats: '吃',
  lives: '住',
  located: '在',
  hospitalized: '就医',
  goes: '去',
  scheduled: '有安排',
  works: '工作',
  studies: '在读',
  changes: '改为',
  uses: '用',
  decides: '决定',
  fixes: '修复',
  fails: '失败',
  deploys: '部署',
  communicates: '通信',
  discusses: '讨论',
  runs: '跑',
  asserts: '记住',
  has: '有',
  states: '陈述',
}
