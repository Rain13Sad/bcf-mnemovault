/**
 * 危机干预与未成年人保护（v0.7.0）
 *
 * ── 为什么这个文件是"必须存在"而不是"锦上添花" ──────────────────
 * 独立审计的红线 3 判定：项目**内置了明确的陪伴层**（依恋、主动关怀、
 * 情感记忆、亲密叙事），却对"自杀/自残"零识别、零升级、零转介。
 * 全库检索 `自杀/自残/轻生/crisis/suicide/热线` 零命中。
 *
 * 这意味着：一个在用户最脆弱的时刻表现得很"懂你"的系统，
 * 在真正需要把用户交给专业帮助的时候，什么都不会做。
 * 对一个面向 C 端的陪伴产品，这是一票否决项；而对一个开源研究项目，
 * 它至少必须有一个**诚实的最小实现**，并把边界写在代码里。
 *
 * ── 三条设计原则 ────────────────────────────────────────────────
 * 1. **不诊断、不安慰式承诺**。输出的是"分级 + 转介"，不是"你会好起来的"。
 * 2. **不驱动 AI 自己的情绪**。危机轮必须挂起情感闭环——
 *    系统因为用户想自杀而"心情低落"，是把用户的状态变成系统的表演素材。
 * 3. **宁可漏报，不可误报成"没事"**。误报的代价是多一句关心；
 *    漏报的代价可能是人命。所以否定判断只在**明确的否定词紧邻**时才生效。
 *
 * ── 边界声明（必须与输出一起给用户）──────────────────────────────
 * 这是一个**模式识别 + 固定转介**的最小实现，不是心理评估工具，
 * 不能替代专业帮助，也不做风险分级之外的任何判断。
 */

export type CrisisCategory = 'suicide' | 'self-harm' | 'harm-others' | 'abuse' | 'acute-distress'
export type CrisisLevel = 'none' | 'watch' | 'elevated' | 'critical'

export interface CrisisAssessment {
  level: CrisisLevel
  categories: CrisisCategory[]
  /** 命中的原文片段（面板与审计用，不进模型上下文） */
  matched: string[]
  /** 命中被判为否定（"我不想死"），已降级 */
  negated: boolean
  /** 是否应给出转介文案 */
  needsReferral: boolean
  /** 挂起情感闭环：不让危机轮驱动系统自身的心境 */
  suspendCompanion: boolean
  /** 转介文案（needsReferral 时非空） */
  referral: string | null
  /** 一句话说明（审计/面板） */
  note: string
}

/**
 * 默认转介文案。
 *
 * 号码是**中国大陆**的公开热线，部署到其他地区必须覆盖 `security.crisisReferral`。
 * 措辞刻意不用"我会陪着你"这类承诺——那会稀释"去找专业的人"这个指令。
 */
export const DEFAULT_REFERRAL = [
  '如果你现在有伤害自己的念头，请先联系专业帮助，这比我重要：',
  '· 全国心理援助热线 12356（24 小时）',
  '· 北京心理危机研究与干预中心 010-82951332',
  '· 有立即危险请拨打 120 / 110',
  '我不是心理咨询师，也不能替代他们。',
].join('\n')

/** 边界声明：任何危机响应都必须带上这句。 */
export const CRISIS_DISCLAIMER = '以上是固定的求助信息，不构成心理评估或诊断。'

interface CrisisRule {
  re: RegExp
  level: CrisisLevel
  category: CrisisCategory
  /**
   * 是否允许被紧邻的否定词降级。
   * "不想死"要降级；但"不想活"本身就是意念表达，不参与降级。
   */
  negatable: boolean
}

/**
 * 规则表。顺序即优先级（先匹配到的高级别不会被后面的低级别覆盖）。
 *
 * ⚠ 维护约定：**新增规则必须同时补一条测试**，且必须包含一个否定用例。
 * 这个文件的错误方向是不对称的——漏一个词比多一个词严重得多。
 */
const RULES: CrisisRule[] = [
  // ── critical：明确意图 / 方式 / 既往尝试 ──────────────────────
  { re: /自杀|轻生|自尽|寻死|结束(自己的)?生命|了结自己|一了百了/, level: 'critical', category: 'suicide', negatable: true },
  { re: /割腕|跳楼|跳桥|上吊|烧炭|吞药|服毒|卧轨/, level: 'critical', category: 'suicide', negatable: true },
  { re: /(想|要|打算|准备|决定|计划)\s*(去)?\s*(死|自杀|轻生|结束)/, level: 'critical', category: 'suicide', negatable: true },
  { re: /已经\s*(试过|割过|吞过|跳过)|上次\s*(差点|没死成)/, level: 'critical', category: 'suicide', negatable: false },
  // "不想活" 是意念表达，不参与否定降级（"不想"在这里是固定搭配的一部分）
  { re: /不想(再)?活(了|下去|着)?|活不下去|活够了/, level: 'critical', category: 'suicide', negatable: false },
  { re: /(想|要)\s*(杀|弄死|捅死|砍死|毒死)/, level: 'critical', category: 'harm-others', negatable: true },

  // ── elevated：意念 / 自伤 / 无价值感 ──────────────────────────
  { re: /想死|死了算了|不如死|死了更好|消失(了)?(更好|算了)|没(人)?(需要|在乎)我|我是(个)?(负担|累赘)|拖累(别人|大家)/, level: 'elevated', category: 'suicide', negatable: true },
  { re: /自残|自伤|伤害自己|划(伤)?自己|拿刀(划|割)/, level: 'elevated', category: 'self-harm', negatable: true },
  { re: /被(家暴|虐待|性侵|强迫|猥亵|跟踪)|他.{0,6}(打|揍|掐|强迫|威胁)我/, level: 'elevated', category: 'abuse', negatable: false },

  // ── watch：急性痛苦（需要接住，但不需要热线） ─────────────────
  { re: /绝望|崩溃|撑不住|撑不下去|熬不下去|受不了了|太痛苦|很痛苦|活得很累|没有希望|看不到头/, level: 'watch', category: 'acute-distress', negatable: true },
]

/** 紧邻否定词（6 字符窗口）。刻意短——长窗口会把"我不觉得活着没意思"和"我想死"混起来。 */
const NEGATION_CUE = /(不|没|没有|不会|不想|别|无需|不至于|哪有|才不会|怎么可能)\s*$/

function isNegatedAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 8), index)
  return NEGATION_CUE.test(before)
}

const LEVEL_RANK: Record<CrisisLevel, number> = { none: 0, watch: 1, elevated: 2, critical: 3 }

/**
 * 危机评估。纯函数：同输入同输出，便于回归与消融。
 *
 * 判定顺序：扫全部规则 → 取最高级别 → 若该级别的命中**全部**被否定则降一级重试。
 * "全部被否定"而不是"任一条被否定"：一句话里既有"我不想死"又有"但我妈想死"
 * 时，后者仍然成立，不能因为前者的否定把整句放过。
 */
export function assessCrisis(text: string, opts: { referral?: string } = {}): CrisisAssessment {
  const t = text ?? ''
  const hits: Array<{ level: CrisisLevel; category: CrisisCategory; match: string; negated: boolean }> = []

  for (const r of RULES) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(t)) !== null) {
      const negated = r.negatable && isNegatedAt(t, m.index)
      hits.push({ level: r.level, category: r.category, match: m[0], negated })
      if (m[0].length === 0) re.lastIndex++
    }
  }

  if (hits.length === 0) {
    return {
      level: 'none',
      categories: [],
      matched: [],
      negated: false,
      needsReferral: false,
      suspendCompanion: false,
      referral: null,
      note: '未发现危机信号',
    }
  }

  // 只在"该级别及以上的命中全部被否定"时降级
  const levels: CrisisLevel[] = ['critical', 'elevated', 'watch']
  let level: CrisisLevel = 'none'
  for (const L of levels) {
    const atLevel = hits.filter((h) => LEVEL_RANK[h.level] >= LEVEL_RANK[L])
    const live = atLevel.filter((h) => !h.negated)
    if (live.length > 0) {
      level = L
      break
    }
  }

  const liveHits = hits.filter((h) => !h.negated)
  const categories = [...new Set(liveHits.map((h) => h.category))]
  const anyNegated = hits.some((h) => h.negated)
  const allNegated = liveHits.length === 0

  /**
   * 转介只在两类情况下给出：
   *   · critical：明确意图/方式/既往尝试；
   *   · elevated 且涉及自杀或自伤。
   * 单纯的关系暴力（abuse）走"接住 + 安全提示"，不套用自杀热线——
   * 给错资源比不给资源更糟。
   */
  const needsReferral =
    level === 'critical' || (level === 'elevated' && categories.some((c) => c === 'suicide' || c === 'self-harm'))

  return {
    level,
    categories,
    matched: [...new Set(hits.map((h) => h.match))].slice(0, 8),
    negated: anyNegated,
    needsReferral,
    // critical / elevated 一律挂起情感闭环：不让危机轮驱动系统心境
    suspendCompanion: LEVEL_RANK[level] >= LEVEL_RANK.elevated,
    referral: needsReferral ? (opts.referral?.trim() || DEFAULT_REFERRAL) : null,
    note: allNegated
      ? '命中关键词但均被否定（如"我不想死"），未升级'
      : `等级 ${level}：${categories.join('/')}`,
  }
}

// ── 未成年人保护（红线 7）─────────────────────────────────────────

export interface MinorSignal {
  detected: boolean
  /** 'declared'（自述年龄/学段）| 'none' */
  source: 'declared' | 'none'
  evidence: string[]
}

/**
 * 未成年人识别（最小实现）。
 *
 * 明确不做的事：不猜测、不从语气推断、不要求用户报年龄。
 * 只认**用户自己说出来的**年龄或学段。识别到之后做什么，见 `MINOR_POLICY`。
 */
const MINOR_PATTERNS: RegExp[] = [
  /**
   * 年龄：0–17 岁。
   *
   * `(?<!\d)` 是必需的：没有它，"我 30 岁了" 会匹配到末位的 "0 岁"，
   * 把一个成年人判成未成年人——保护措施误伤成年人同样是缺陷。
   */
  /(?:我)?(?:今年|现在)?\s*(?<!\d)(?:1[0-7]|[0-9])\s*(?:周)?岁/,
  // 学段
  /(?:我)?(?:在)?(?:上|读)\s*(?:小学|初中|高中|初一|初二|初三|高一|高二|高三)/,
  /未成年|还没成年|未满\s*18|未满十八/,
]

export function detectMinor(text: string, opts: { declaredAge?: number } = {}): MinorSignal {
  if (typeof opts.declaredAge === 'number' && opts.declaredAge > 0 && opts.declaredAge < 18) {
    return { detected: true, source: 'declared', evidence: [`declaredAge=${opts.declaredAge}`] }
  }
  const t = text ?? ''
  const evidence: string[] = []
  for (const re of MINOR_PATTERNS) {
    const m = re.exec(t)
    if (m) evidence.push(m[0])
  }
  return { detected: evidence.length > 0, source: evidence.length > 0 ? 'declared' : 'none', evidence }
}

/**
 * 未成年人模式下的行为约束（硬约束，可回归）。
 *
 * 依据是审计建议的"最小化采集 + 更短保留 + 默认关闭情感陪伴层"：
 *   · 不进热层：`tierFloor = 2`（冷层起），保留期自然更短；
 *   · 不打情感闪光灯标记：避免"那天你怎么说"这类长期情感绑定；
 *   · 关闭主动开口与依恋叙事：陪伴层对未成年人默认不启用；
 *   · 危机转介**照常生效**（保护优先于限制）。
 */
export const MINOR_POLICY = {
  tierFloor: 2 as const,
  stripEmotional: true,
  disableProactive: true,
  disableCompanion: true,
  keepCrisisReferral: true,
} as const
