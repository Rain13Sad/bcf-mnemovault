/**
 * @rain13sad/llm-mnemo-encoder —— 写侧（§7 / §14.2）
 *
 * 编码器是唯一能写晶格的入口（对应内嗅皮层的串行瓶颈）。
 * 五阶段：① 切分 ② 槽位填充 ③ 表征生成 ④ 情感评价 ⑤ 冲突消解与落库。
 *
 * 一条硬边界：**编码器从第一步起就不产生散文**。L1 小模型的输出必须是
 * JSON 数组的槽位填充结果，不是摘要句子——否则文本记忆会从后门回来。
 *
 * L0 规则覆盖约 60%，L1 由宿主 LLM 提供（可选）。没有 LLM 时只跑 L0，
 * 覆盖率下降但链路完整——这是刻意的降级，不是缺失。
 */

import type { Context } from '@deepseek-ai/cordis'
// 引入 dsh-session 的类型增强，让 ctx.on('session/event') 拿到真实的事件签名
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  FLAG,
  KIND,
  PROV_NAME,
  SLOT_ROLE,
  TRUST_BY_PROVENANCE,
  cellIdFor,
  queryEmbedding,
  isNegated,
  parseTimeExpr,
  redact,
  scrubValue,
  segmentPropositions,
  detectPredicate,
  extractEntities,
  normToken,
  preferenceFrame,
  objectOfVerb,
  TOPIC_NOUNS,
  isQuestion,
  topicFingerprint,
  shaOf,
  assessCrisis,
  detectMinor,
  looksLikeInstruction,
  isSensitive,
  TAG,
  type MemCell,
  type ResidualRef,
  type MemoryService,
  type Slot,
  type Sdr,
  type SdrSpace,
} from '@rain13sad/llm-mnemo-core'

import { fromHostLlm, parseLlmPropositions, probeLlmPort, segmentLite, segmentWithPort, type HostLlmPort, type LlmPort, type Proposition } from './l1.js'
import { frameDigest, frameToSlots, parseFrames, type Frame } from './frames.js'
import type { L1Status, RuntimeStatus } from '@rain13sad/llm-mnemo-core'

export const name = 'mnemo-encoder'
export const inject = ['memory', 'sessions']

export interface Config {
  /** 是否编码助手自己的断言（默认只编码"承诺/决定"类） */
  encodeAssistant: boolean
  /** 是否编码工具结果（默认只编码含实体且非空的结果） */
  encodeTools: boolean
  /** 单轮最多产出多少 cell（防止长粘贴把库刷爆） */
  maxCellsPerTurn: number
  /**
   * 长度感知的切分预算：每多少字最多产出一条 cell。
   *
   * 这是存储比的第一个杠杆，也是最容易被误解的一个：命题级切分（§7.2）本身是对的，
   * 但一条 800 字的轮次切出 6 条 cell，每条都要付 112 B 头 + SDR + 向量，
   * 固定基底会盖过压缩收益。默认 600 字/条 = "800 字轮次最多 2 条"，
   * 既保留"一件事一条"的语义，又不让短句碎片把库撑大。
   * 设为 0 关闭（退化为纯 maxCellsPerTurn 上限）。
   */
  cellsPerTurnChars: number
  /**
   * 单轮 cell 预算的**下限**（v0.7.0）。
   *
   * 旧口径只看字数，短轮次恒为 1，于是"字体偏好等宽，主题用深色"只存得下一条。
   * 现在至少容纳 min(有信息的从句数, 本值) 条——短句里的多个事实不再被静默丢掉。
   *
   * 设为 1 就退回旧行为（`bench-eval` 的 coarse 档用它测"每轮 1 条"的定长基底）。
   */
  cellsPerTurnFloor: number
  /** 残差长度上限（字节），超出截断并标注 */
  maxResidualBytes: number
  /** L1 小模型切分（需要宿主 llm 服务；缺失时静默降级到 L0） */
  l1: { enabled: boolean; model?: string; probe: boolean; timeoutMs: number }
}

export const Config: z<Config> = z.object({
  encodeAssistant: z.boolean().default(true).description('编码助手的承诺/决定类断言'),
  encodeTools: z.boolean().default(true).description('编码工具结果中的事实'),
  maxCellsPerTurn: z.number().min(1).max(32).default(8).description('单轮 cell 上限，防止长粘贴刷库'),
  cellsPerTurnChars: z.number().min(0).max(4000).default(600).description('每多少字最多一条 cell（存储比与原子性的折中）'),
  cellsPerTurnFloor: z.number().min(1).max(8).default(3).description('单轮 cell 预算下限：至少容纳几条有信息的从句（1 = 退回纯字数口径）'),
  maxResidualBytes: z.number().min(512).max(65536).default(8192).description('残差字节上限'),
  l1: z.object({
    enabled: z.boolean().default(true).description('启用 L1 小模型切分（需宿主 llm 服务；缺失时自动降级）'),
    model: z.string().description('L1 模型名，留空用宿主默认小模型'),
    probe: z.boolean().default(true).description('加载时真打一次探针，验证宿主 llm 的调用形状'),
    timeoutMs: z.number().min(500).max(30000).default(4000).description('探针超时'),
  }),
})

export interface TurnInput {
  sessionId: string
  /** 本轮事件的 seq 列表，用于 cellId 的确定性派生 */
  seqs: number[]
  turn: number
  userText: string
  assistantText?: string
  toolResults?: Array<{ name: string; text: string; fromWeb?: boolean }>
  /** 事件发生时间（ms） */
  at?: number
  /** 当前 PAD（affect 缺席时中性），用于 A 元组与 importance */
  pad?: { v: number; a: number; d: number; s: number }
}

export interface EncodeResult {
  cells: MemCell[]
  created: number
  merged: number
  linked: number
  conflicts: number
  skipped: number
}

const PLACEHOLDER_G = new RegExp('\u00abSECRET:[0-9]+\u00bb', 'g')

const PROPOSITION_KIND: Array<{ re: RegExp; kind: number }> = [
  { re: /不要|别|禁止|永远|must|never/i, kind: KIND.procedure },
  { re: /喜欢|偏好|习惯|prefer|always/i, kind: KIND.semantic },
  { re: /决定|定了|以后都|from now on/i, kind: KIND.semantic },
]

export class Encoder {
  private turnsSincePass = 0
  private cellsSincePass = 0
  /**
   * 已识别为未成年人的会话（v0.7.0）。
   *
   * **粘性**：一旦在某轮识别到（"我今年 15 岁"），本会话后续所有轮次都按未成年人处理——
   * 否则用户第二句不说年龄，保护就自动失效了。这是"保护必须比识别更持久"。
   */
  private minorSessions = new Set<string>()

  /**
   * 会话级话题锚（v0.7.1）。
   *
   * 中文改口不重复主语（"办公室在浦东" → "搬到徐汇" → "定在静安寺"），
   * 后两句没有主体；不带锚的话它们会成为无主记忆，冲突检测拿不到 MANNER 键，
   * "现在到底在哪"就永远答不出来（审计 R1）。
   *
   * 只存**最近一个**话题，且只对属性类谓词生效（见 `CARRY_PREDS`）——
   * 携带太多会让"我妈住院了 / 买了水果"串成一句假记忆。
   */
  private lastTopic = new Map<string, string>()

  /** L1 端口：宿主小模型；缺席时用 L1-lite（规则增强） */
  private readonly port: LlmPort | null
  private l1: L1Status

  constructor(
    private readonly memory: MemoryService,
    private readonly space: SdrSpace,
    private readonly config: Config,
    port?: LlmPort | null,
  ) {
    this.port = port ?? null
    this.l1 = {
      enabled: config.l1.enabled,
      mode: config.l1.enabled ? (port ? 'lite' : 'lite') : 'l0',
      entry: (port as HostLlmPort | null)?.entry ?? null,
      ok: false,
      lastMs: 0,
      note: port ? '端口已就绪，等待首轮调用' : config.l1.enabled ? '未找到宿主 llm，使用 lite 规则切分' : 'L1 未启用',
    }
  }

  /** 一轮结束时的编码入口。 */
  encodeTurn(input: TurnInput, opts: { skipSensory?: boolean } = {}): EncodeResult {
    const at = input.at ?? Date.now()
    const out: EncodeResult = { cells: [], created: 0, merged: 0, linked: 0, conflicts: 0, skipped: 0 }

    // 感觉记忆（§8.1）：同一段内容在 2 轮内重复出现就不再编码。
    // 用户反复粘贴同一份日志是最常见的 token 浪费来源，哈希命中比"看着像"可靠得多。
    const ring = opts.skipSensory
      ? { duplicate: false, hash: '' }
      : this.memory.sensory.push(input.turn, input.userText)
    if (ring.duplicate && input.userText.length > 40) {
      out.skipped = 1
      return out
    }
    const seen = new Set<string>()

    // 残差按**轮**共享，而不是按命题各存一份（§6.3 残差共享）。
    // 命题级各存一份的后果实测很直接：一条 800 字轮次被切成 4 条命题时，
    // 固定 704 B × 4 的基底成本会盖过一切，存储比反而比原文还高。
    /**
     * v0.7.0：**惰性写入**。
     *
     * 旧实现一进 encodeTurn 就 putResidual，于是"这一轮一条 cell 都没产出"
     * （纯寒暄、纯情绪、全被合并）时，盘上会留一份没有任何 cell 引用的原文——
     * doctor 把它报成"孤儿残差"。这不是泄漏，但它是"说了删干净却没删干净"的同类问题：
     * 用户没让你存的原文不该因为"本来准备存"而落盘。
     */
    let turnRefCache: ResidualRef | undefined
    const getTurnRef = (): ResidualRef => {
      if (turnRefCache) return turnRefCache
      const turnText = truncateToBytes(redact(input.userText).text, this.config.maxResidualBytes)
      const turnBytes = new TextEncoder().encode(turnText)
      turnRefCache = {
        sha: shaOf(turnText),
        off: BigInt(this.memory.store.putResidual(shaOf(turnText), turnBytes)),
        rawLen: turnBytes.length,
      }
      return turnRefCache
    }

    const push = (text: string, provenance: 0 | 1 | 2 | 3, seq: number) => {
      if (out.cells.length >= budget) {
        out.skipped++
        return
      }
      const key = text.trim().toLowerCase()
      if (!key || seen.has(key)) return
      seen.add(key)
      const cell = this.buildCell({ ...input, at }, text, provenance, seq, getTurnRef())
      if (!cell) {
        out.skipped++
        return
      }
      const r = this.memory.ingest(cell, [{ session: input.sessionId, seq }])
      out.cells.push(r.cell)
      if (r.action === 'created') out.created++
      else if (r.action === 'merged') out.merged++
      else if (r.action === 'linked') out.linked++
      else if (r.action === 'conflict') out.conflicts++
    }

    /**
     * ① 用户命题：永远编码（这是最高价值的一类）。
     *
     * v0.7.0：从"整句 → 槽位"改成"从句 → 帧 → 槽位"。
     *
     * 旧路径把一整段话压成一条命题，于是"我不吃辣，但川菜除外"只有一个谓词位，
     * 值、否定、例外互相覆盖；"新服务用 Go 写、gRPC 通信、部署在杭州" 只剩一条。
     * 现在每个从句独立成帧，`informative=false` 的帧（纯情绪、纯语气）不产出 cell。
     *
     * 注意：脱敏在切分**之前**（v0.5 的教训），所以帧里的文本已经是脱敏后的。
     */
    const redTurn = redact(input.userText)
    const safeUserText = redTurn.text
    // 轮级标签先算一次：有些信号（年龄、危机）落在不会产出 cell 的从句里
    this.computeTurnTags(safeUserText, input.sessionId)
    /**
     * 预算（v0.7.0 调整）。
     *
     * 旧口径只看字数：`ceil(len / cellsPerTurnChars)`，短轮次恒为 1。
     * 于是"我字体偏好等宽，主题用深色"（14 字、两个事实）只存得下一条——
     * 第二条被 `out.skipped++` 静默丢掉。这是"为省字节而丢事实"，
     * 与"写入端是产品总闸"的结论直接冲突。
     *
     * 新口径：**至少容纳本轮有信息的从句数**（上限仍是 maxCellsPerTurn）。
     * 字数预算继续管"长粘贴别刷库"，但不再决定"一句里的两件事只记一件"。
     */
    const carryTopic = this.lastTopic.get(input.sessionId)
    const frames = parseFrames(safeUserText, { agent: '用户', now: at, carryTopic })
    const informativeCount = frames.filter((f) => f.informative).length
    /**
     * 上限取 3：短句里的两三个事实必须都留下（"字体偏好等宽，主题用深色"），
     * 但长粘贴仍然由字数预算与 `maxCellsPerTurn` 管——
     * 不设这个上限，一段 800 字的多从句长文会一次产出七八条 cell，
     * 把存储比从 0.72 推到 0.81（实测）。
     */
    /**
     * 预算下限必须**容忍缺字段**（v0.7.1）。
     *
     * 宿主/devkit 传进来的 encoder 配置是**手写对象**，不经过 schema 解析；
     * 新增字段如果只写在 schema 里，运行期就是 `undefined` →
     * `Math.min(n, undefined)` = NaN → `cells.length >= NaN` 恒为 false →
     * **上限整个失效**（实测：一轮 294 字产出了 4 条 cell，而预算是 3）。
     *
     * 这类"配置缺字段导致闸门静默失效"的 bug 不会报错，只会让存储比悄悄变差。
     */
    const floor = Math.max(1, Math.floor(Number.isFinite(this.config.cellsPerTurnFloor) ? this.config.cellsPerTurnFloor : 3))
    const budget = Math.max(this.maxCellsForTurn(input.userText), Math.min(informativeCount, floor))
    // 更新会话话题锚（本轮最后一个有主体的成帧从句）
    for (const f of frames) {
      if (f.informative && f.topic && f.topic.length >= 2) this.lastTopic.set(input.sessionId, f.topic)
    }
    if (this.lastTopic.size > 64) {
      // 有界：删最早的会话，避免长驻插件无限增长
      const oldest = this.lastTopic.keys().next().value
      if (oldest !== undefined) this.lastTopic.delete(oldest)
    }
    let seq = input.seqs[0] ?? 0
    for (const f of frames) {
      if (!f.informative) {
        out.skipped++
        continue
      }
      if (out.cells.length >= budget) {
        out.skipped++
        continue
      }
      const key = f.raw.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      const cell = this.buildCell({ ...input, at }, f.raw, 0, seq++, getTurnRef(), f, redTurn.pii)
      if (!cell) {
        out.skipped++
        continue
      }
      const r = this.memory.ingest(cell, [{ session: input.sessionId, seq: seq - 1 }])
      out.cells.push(r.cell)
      if (r.action === 'created') out.created++
      else if (r.action === 'merged') out.merged++
      else if (r.action === 'linked') out.linked++
      else out.conflicts++
    }

    // ② 助手断言：只编码承诺/决定类（避免把自己的寒暄写进长期记忆）
    if (this.config.encodeAssistant && input.assistantText) {
      for (const p of this.segment(redact(input.assistantText).text)) {
        if (!/我会|我已经|已改成|决定|约定|以后|will|agreed|decided/i.test(p)) continue
        push(p, 1, seq++)
      }
    }

    // ③ 工具结果：只编码含实体的短结果；网络来源打 flag 且默认隔离
    if (this.config.encodeTools) {
      for (const t of input.toolResults ?? []) {
        const text = (t.text ?? '').trim()
        if (text.length < 8 || text.length > 4000) continue
        if (extractEntities(text).length === 0) continue
        push(`${t.name}: ${firstSentence(text)}`, t.fromWeb ? 3 : 2, seq++)
      }
    }

    this.turnsSincePass++
    this.cellsSincePass += out.created
    return out
  }

  /**
   * 切分：L1（模型）→ L1-lite（规则增强）→ L0（基础规则）。
   * 每一级都只是"切得更细一点"，不会假装切得更准。
   *
   * 注意这里是同步路径：模型调用是异步的，所以同步链路用 lite，
   * 真正的端口留给 `encodeTurnAsync`（宿主能在 turn/end 上 await 时用）。
   */
  private segment(text: string): string[] {
    if (!text) return []
    if (this.config.l1.enabled) {
      const lite = segmentLite(text)
      if (lite.length > 0) return lite.map((p) => p.text)
    }
    return segmentPropositions(text)
  }

  /**
   * 本轮 cell 预算：`ceil(len / cellsPerTurnChars)`，夹在 [1, maxCellsPerTurn]。
   *
   * 为什么不是纯 maxCellsPerTurn：那个上限是**防御性**的（防长粘贴刷库），
   * 不是**经济性**的。存储比的问题恰恰来自"短轮次切得太多"，
   * 所以预算要跟轮次长度走：一段 200 字的话切成 6 条，每条都只剩半句，
   * 既稀释了证据计数，又让固定基底成本翻六倍。
   */
  maxCellsForTurn(text: string): number {
    const max = this.config.maxCellsPerTurn
    const per = this.config.cellsPerTurnChars
    if (!per || per <= 0) return max
    return Math.max(1, Math.min(max, Math.ceil(text.length / per)))
  }

  /**
   * 异步编码：优先用模型做 L1 切分，失败或未启用时退回同步路径。
   * 宿主若能在 turn/end 上 await，用这个版本；否则用 encodeTurn（同步、lite）。
   */
  async encodeTurnAsync(input: TurnInput): Promise<EncodeResult> {
    if (!this.config.l1.enabled || !this.port) return this.encodeTurn(input)
    const t0 = Date.now()
    const props = await segmentWithPort(input.userText, this.port)
    this.noteL1(props, Date.now() - t0)
    if (!props || props.length === 0) return this.encodeTurn(input)
    return this.encodePropositions(input, props)
  }

  /** L1 运行时状态：成功/失败/耗时都记下来，面板与 doctor 直接读。 */
  private noteL1(props: Proposition[] | null, ms: number): void {
    this.l1 = {
      enabled: this.config.l1.enabled,
      mode: props ? 'port' : this.config.l1.enabled ? 'lite' : 'l0',
      entry: (this.port as HostLlmPort | null)?.entry ?? null,
      ok: Boolean(props),
      lastMs: ms,
      note: props ? `L1 切分 ${props.length} 条命题（${ms}ms）` : '端口返回不可解析，本轮回退到 lite 规则切分',
    }
  }

  l1Status(): L1Status {
    return { ...this.l1 }
  }

  /** 用给定命题列表编码（L1 的产物直接进这条路径，不再二次切分）。 */
  private encodePropositions(input: TurnInput, props: Proposition[]): EncodeResult {
    const at = input.at ?? Date.now()
    const out: EncodeResult = { cells: [], created: 0, merged: 0, linked: 0, conflicts: 0, skipped: 0 }
    const seen = new Set<string>()
    this.computeTurnTags(redact(input.userText).text, input.sessionId)
    // 与 encodeTurn 同一条惰性策略：没有 cell 引用就不该把原文落盘
    let turnRefCache: ResidualRef | undefined
    const getTurnRef = (): ResidualRef => {
      if (turnRefCache) return turnRefCache
      const turnText = truncateToBytes(redact(input.userText).text, this.config.maxResidualBytes)
      const turnBytes = new TextEncoder().encode(turnText)
      turnRefCache = {
        sha: shaOf(turnText),
        off: BigInt(this.memory.store.putResidual(shaOf(turnText), turnBytes)),
        rawLen: turnBytes.length,
      }
      return turnRefCache
    }
    let seq = input.seqs[0] ?? 0
    const budget = this.maxCellsForTurn(input.userText)
    for (const p of props) {
      if (out.cells.length >= budget) break
      const key = p.text.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      /**
       * 先取值再自增，**同一个 s 同时用于 cellId 与 cell_sources**。
       *
       * v0.3 之前写的是 `buildCell(..., seq++)` 配 `ingest(..., { seq })`：
       * cellId 用自增前的值、来源记录用自增后的值，两者永远差 1。
       * 而 `deriveCellId(sessionId, seqs, sdr)` 的输入正是 seq——
       * 于是从 session_log 重放会算出**不同的 cellId**，
       * 直接违反"写入可复现"这条硬约束。
       */
      const s = seq++
      const cell = this.buildCell({ ...input, at }, p.text, 0, s, getTurnRef())
      if (!cell) {
        out.skipped++
        continue
      }
      const r = this.memory.ingest(cell, [{ session: input.sessionId, seq: s }])
      out.cells.push(r.cell)
      if (r.action === 'created') out.created++
      else if (r.action === 'merged') out.merged++
      else if (r.action === 'linked') out.linked++
      else out.conflicts++
    }
    this.turnsSincePass++
    this.cellsSincePass += out.created
    return out
  }

  private buildCell(
    input: TurnInput,
    text: string,
    provenance: 0 | 1 | 2 | 3,
    seq: number,
    turnRef?: ResidualRef,
    /** v0.7.0：帧路径。给了就用帧的槽位，不再走整句启发式 */
    frame?: Frame,
    /**
     * 轮级 PII 标记（v0.7.1）。
     *
     * 帧路径拿到的文本是**已经脱敏过**的（`encodeTurn` 先 redact 再切分），
     * 于是 buildCell 里再 redact 一次已经找不到密钥 → `red.pii` 恒为 false
     * → 主写入路径上 `FLAG.pii` **从来没被设置过**。
     *
     * 后果不是"泄漏"（明文确实没落盘），而是"看不见"：
     * 面板无法标出"这条含敏感信息"，外发守卫也少了一层判据。
     * 所以轮级结果必须显式传下来。
     */
    turnPii?: boolean,
  ): MemCell | null {
    const at = input.at ?? Date.now()
    const red = redact(text)
    if (red.pii && !red.text.replace(/«SECRET:\d+»/g, '').trim()) return null

    /**
     * 从这里往下，**一律用 `red.text`**，不再碰原文。
     *
     * v0.2/v0.3 的 bug：digest 用了脱敏文本，但实体抽取、槽位填充、向量、话题指纹
     * 全都读原文。结果是「摘要里是 «SECRET:1»，旁边的槽位里是完整手机号」——
     * 而槽位会经 kvPairs() 直接渲染进模型上下文。审查用一个注入探针就复现了。
     *
     * 规则很简单：**脱敏是入口，不是收尾**。原文在这个函数里只允许出现在
     * `red.text` 这一个变量里。
     */
    const safe = red.text

    const ents = extractEntities(safe)
    let pred: string
    let neg: boolean
    let timeRange: { from: number; to: number } | undefined
    let slots: Slot[]
    /** 进 digest / 话题指纹的文本：帧路径用结构化摘要，旧路径用原文前缀 */
    let digestText: string

    if (frame) {
      /**
       * v0.7.0 帧路径：槽位由帧直接给出，不再回退到整句启发式。
       *
       * 这条路径的存在意义是**成分不丢**：帧里的 topic/value/place/qty/exception
       * 都是从句里确实抽到的成分，而 `fillSlots` 是从整句里"猜"一个最像客体的词。
       */
      pred = frame.pred
      neg = frame.polarity === 'neg'
      timeRange = frame.time
      slots = scrubSlots(frameToSlots(frame))
      digestText = frameDigest(frame)
      if (slots.length === 0) return null
    } else {
      pred = detectPredicate(safe)
      neg = isNegated(safe)
      timeRange = parseTimeExpr(safe, at)
      const filledSlots = fillSlots(safe, { ents, pred, neg, timeRange, provenance })

      // v0.6.2（§5.1 修复）：值槽保护——fillSlots 返回 null 表示
      // 规则没能从这句话里抽出有意义的槽位，此时降级为"原文残差 + 实体 SDR"。
      // 不产出结构化 cell（X=states 空值），但仍然可被残差通道检索到。
      if (filledSlots === null) return null
      slots = scrubSlots(filledSlots)
      if (slots.length === 0) return null
      digestText = red.text.slice(0, 120)
    }

    const sdr = this.buildSdr(slots)
    /**
     * 写入向量（v0.6）：库与端口同空间时用预热好的 provider 向量，否则哈希。
     *
     * 这里必须与 `runRecall` 的查询向量走**同一条变换链**（`queryEmbedding`），
     * 否则"写的时候 64 维折叠、查的时候 256 维截断"会让余弦相似度失去意义——
     * 而这种错误不报错，只会让召回悄悄变差。
     */
    const port = this.memory.ports.embedding
    const pre = port && this.memory.embSpace === port.space ? (port.peek?.(safe) ?? null) : null
    const emb = queryEmbedding(safe, this.memory.config, pre)
    const kind = pickKind(safe, pred)
    const trust = TRUST_BY_PROVENANCE[provenance]
    const pad = input.pad ?? { v: 0, a: 0.2, d: 0.5, s: 0.3 }

    // 双置信度：confidence 是编码时自评（只在这里写一次），support 由服务层累加
    const confidence = clamp01(0.55 + (slots.length / 8) * 0.25 + (timeRange ? 0.05 : 0) + (provenance === 0 ? 0.1 : 0))
    // importance：受情感调制 + 来源可信度（§19.1 交叉验证：单来源网络断言 ×0.5）
    let importance = clamp01(0.35 + Math.abs(pad.v) * 0.3 + pad.s * 0.25 + (provenance === 0 ? 0.1 : 0))
    if (provenance >= 2) importance *= 0.5

    // 共享轮级残差；没有轮级残差时（单测直接调 buildCell）退回命题级
    let residualRef = turnRef
    if (!residualRef) {
      const rawBytes = new TextEncoder().encode(truncateToBytes(red.text, this.config.maxResidualBytes))
      const sha = shaOf(red.text)
      residualRef = { sha, off: BigInt(this.memory.store.putResidual(sha, rawBytes)), rawLen: rawBytes.length }
    }

    const cellId = cellIdFor(input.sessionId, [seq], sdr)
    const stability = kind === KIND.procedure ? 30 : kind === KIND.episodic ? 2 : 7

    const cell: MemCell = {
      cellId,
      kind: kind as MemCell['kind'],
      tier: 1,
      flags: FLAG.residual | (provenance === 3 ? FLAG.web : 0) | (red.pii || turnPii ? FLAG.pii | FLAG.redacted : 0),
      tFrom: BigInt(timeRange ? timeRange.from : at),
      tTo: BigInt(timeRange ? timeRange.to : at),
      tIngest: BigInt(at),
      tAccess: BigInt(at),
      accessCount: 0,
      stability,
      importance,
      // v0.5.1：PAD 三个分量都必须钳到 [-1,1]。
      // v0.5 只钳了 salience，实测有 cell 拿到 valence=1.48（情绪语料叠加后越界），
      // 下游 affectIntensityOf 用 clamp01(max(|v|,a)) 会把它恒饱和成 1.0，七因子里的
      // affect 项就此失去分辨率。
      valence: clamp11(pad.v),
      arousal: clamp11(pad.a),
      dominance: clamp11(pad.d),
      salience: clamp01(pad.s),
      provenance,
      trust,
      sdr,
      emb,
      slots,
      edges: [],
      residual: residualRef,
      confidence,
      support: 1,
      /**
       * 话题指纹仍用**原句**，digest 用结构化摘要——两者服务于不同的东西：
       *   · `topic` 是 `cueMatch` 的输入（词法重叠），原句的覆盖面更广；
       *   · `digest` 是给人看的摘要（面板/日志），结构化的更可读。
       *
       * 实测：把 topic 也换成结构化摘要时，Recall@8 从 0.941 升到 1.0，
       * 但 MRR 从 0.650 掉到 0.611——候选都进了池子，只是排序变差，
       * 因为"测试 用 pnpm"与查询"pnpm 用什么构建"的词法重叠比原句更少。
       */
      topic: topicFingerprint(safe),
      digest: digestText,
      // 作用域与会话归属（§14.10）：情景记忆靠 session 隔离，语义记忆靠 scope 共享
      scope: this.memory.scopeKey,
      session: input.sessionId,
      // v0.7.0：策略标签（危机/未成年/注入/敏感）。见 tagsFor()。
      tags: this.tagsFor(safe, input.sessionId),
    }
    return cell
  }

  /**
   * 本轮级策略标签（v0.7.0）。
   *
   * 为什么必须分两层：从句级标签更精确（"这**一句**是危机"），
   * 但有些信号属于**整轮**——"我今年 14 岁，喜欢玩游戏" 里年龄那半句
   * 没有谓词、不会产出 cell，如果只在从句上判，保护就永远不生效。
   *
   * 所以：轮级判一次（危机/未成年/注入/敏感），从句级再判一次，取并集。
   */
  private turnTags: string[] = []

  /** 轮级标签：在 encodeTurn / encodePropositions 入口算一次。 */
  private computeTurnTags(text: string, sessionId: string): void {
    const sec = this.memory.config.security
    const tags = new Set<string>()
    if (sec.crisisEnabled) {
      if (assessCrisis(text, { referral: sec.crisisReferral }).level !== 'none') tags.add(TAG.crisis)
    }
    if (sec.minorGuardEnabled) {
      if (detectMinor(text).detected) this.minorSessions.add(sessionId)
      if (this.minorSessions.has(sessionId)) tags.add(TAG.minor)
    }
    if (sec.blockInstructionRendering && looksLikeInstruction(text).detected) tags.add(TAG.instruction)
    if (isSensitive(text)) tags.add(TAG.sensitive)
    this.turnTags = [...tags]
  }

  /**
   * 策略标签（v0.7.0）。
   *
   * 在**写入口**打标，而不是在检索时临时判断——因为标签要跟着 cell 一起落盘：
   * 一条危机记忆三个月后被检索到时，仍然应该知道自己曾经是危机记忆。
   *
   * 四类标签各有消费方：
   *   · `crisis`      → 面板高亮 + 保留度保护 + 不参与"陪伴素材"叙事
   *   · `minor`       → ingest 强制降层、去情感标记（`MINOR_POLICY`）
   *   · `instruction` → recall 默认不渲染（防记忆化注入）
   *   · `sensitive`   → 面板标记 + 更短的保留期
   */
  private tagsFor(text: string, sessionId: string): string[] {
    const sec = this.memory.config.security
    const tags = new Set<string>(this.turnTags)
    if (sec.crisisEnabled) {
      const c = assessCrisis(text, { referral: sec.crisisReferral })
      if (c.level !== 'none') tags.add(TAG.crisis)
    }
    if (sec.minorGuardEnabled) {
      if (detectMinor(text).detected) this.minorSessions.add(sessionId)
      // 粘性：本会话一旦识别过，后续轮次都按未成年人处理
      if (this.minorSessions.has(sessionId)) tags.add(TAG.minor)
    }
    if (sec.blockInstructionRendering && looksLikeInstruction(text).detected) tags.add(TAG.instruction)
    if (isSensitive(text)) tags.add(TAG.sensitive)
    return [...tags]
  }

  /** 命题 SDR：bind(filler, role) 后 bundle（§6.6）。参数顺序是 (填充值, 角色)。 */
  buildSdr(slots: readonly Slot[]): Sdr {
    const usable = slots.filter((s) => s.type !== 'UNK' && s.value).slice(0, 8)
    const bound = usable.map((s) => {
      const roleName = Object.entries(SLOT_ROLE).find(([, v]) => v === s.role)?.[0] ?? String(s.role)
      return this.space.bind(this.space.identity('V:' + normToken(s.value)), this.space.role(roleName))
    })
    /**
     * v0.7.0：额外叠一条**裸实体通道**（bag channel）。
     *
     * 只有角色绑定时，cell SDR 的每一位都落在"角色对应的位段"里，
     * 而查询侧不知道实体将扮演什么角色，只能 bundle 裸实体——
     * 两边位永远错开，`containment` 恒等于噪声底。
     * 实测后果：四路召回里符号路长期"有代码、没效果"，单跳精确事实只能靠语义路兜。
     *
     * 加上裸实体后，"这条记忆提到过哪些实体"变成一个可匹配的集合，
     * 而角色绑定继续服务于解绑（`unbind` 仍然精确可逆）。
     * 位数：5 槽 × 8 绑定 + 5 实体 × 8 裸 = 80 位，远低于 bundle 上限 245。
     */
    const bare = usable.map((s) => this.space.identity('V:' + normToken(s.value)))
    return this.space.bundle([...bound, ...bare])
  }

  stats() {
    return { turnsSincePass: this.turnsSincePass, cellsSincePass: this.cellsSincePass }
  }

  resetPassCounters(): void {
    this.turnsSincePass = 0
    this.cellsSincePass = 0
  }
}

/**
 * 槽位兜底脱敏。
 *
 * 为什么需要单独一层：`fillSlots` 是规则函数，它不知道哪些值是凭据；
 * 而槽位值会进 SDR、进 MRS 渲染、进面板、进导出。只要有一处漏了脱敏，
 * 明文就会沿着三条链路同时扩散。所以出口统一过一遍，命中就换成 «SECRET:n»。
 */
export function scrubSlots(slots: readonly Slot[]): Slot[] {
  return slots.map((s) => {
    if (s.type !== 'LIT' || !s.value) return s
    const r = scrubValue(s.value)
    return r.redacted ? { ...s, value: r.value } : s
  })
}

/**
 * 槽位填充：规则版。8 个语义槽 + POLARITY（§7.3 / §7.6）。
 *
 * v0.6.2（§5.1 修复）：值槽保护。
 *
 * 当 preferenceFrame / objectOfVerb 抽不到 (topic, value) 时，
 * 原实现仍会产出 `X=states` 型空值 cell——等于"确认过记错了"。
 * 现在 fillSlots 返回 `null` 表示"只有残差可检索、不应产出结构化 cell"，
 * 调用方 buildCell 会据此降级为"原文残差 + 实体 SDR"的可检索单元。
 */
export function fillSlots(  text: string,
  ctx: { ents: string[]; pred: string; neg: boolean; timeRange?: { from: number; to: number }; provenance: number },
): Slot[] | null {
  const slots: Slot[] = []
  const lit = (role: number, value: string): Slot => ({ role, type: 'LIT', value: value.slice(0, 64) })

  const agent = /我|用户|我们/.test(text) ? '用户' : ctx.provenance === 1 ? '助手' : ctx.provenance === 2 ? '工具' : '用户'
  slots.push(lit(SLOT_ROLE.AGENT, agent))
  slots.push(lit(SLOT_ROLE.PRED, ctx.pred))

  // PATIENT 的取法按可靠性排序：
  //   1. 偏好句的取值（'字体我也偏好等宽' → 等宽），话题进 MANNER
  //   2. 带点/下划线的标识符（api.key、ui.theme）
  //   3. 长度 2–4 的短实体（避免把整句当实体）
  const pref = ctx.pred === 'prefers' || ctx.pred === 'dislikes' ? preferenceFrame(text) : {}
  // 话题槽（MANNER）不只服务偏好句：'决定用 pnpm 部署' 与 '改用 npm 部署' 必须落到同一个
  // 话题键上，否则矛盾检测永远发现不了"同一件事被改了"。这是实测抓到的漏判。
  const topicNoun = pref.topic ?? TOPIC_NOUNS.find((t) => text.includes(t))
  if (topicNoun) slots.push(lit(SLOT_ROLE.MANNER, topicNoun))
  const ident = ctx.ents.find((e) => /[._]/.test(e))
  const short = ctx.ents.filter((e) => !/^#/.test(e) && e.length >= 2 && e.length <= 4)
  // 动宾结构的宾语优先：'统一用 pnpm' 的客体是 pnpm，不是'部署'。
  // 不取宾语的话，'用 pnpm 部署' 与 '改用 npm 部署' 会共用同一个 PATIENT，
  // 矛盾检测于是永远判不出"同一件事被改了"（bench 里 timeReasoning 直接归零）。
  const verbObject = ctx.pred === 'uses' || ctx.pred === 'changes' || ctx.pred === 'deploys' ? objectOfVerb(text) : undefined
  const patient =
    pref.value ?? verbObject ?? ident ?? short[0] ?? ctx.ents.filter((e) => !/^#/.test(e)).sort((a, b) => b.length - a.length)[0]

  // v0.6.2（§5.1 修复）：值槽保护
  //
  // 偏好句（prefers/dislikes）的语义是「(话题, 取值) 二元组」。
  // 如果规则既没抽到取值（pref.value）、也没抽到话题（pref.topic）、
  // 也没有标识符或动宾宾语，那么 PATIENT 只能从"随便一个实体"兜底——
  // 而那个实体往往就是谓词本身（'我喜欢' → PATIENT='喜欢'）。
  // 这种 cell 的价值是负的：它会让矛盾检测把两句无关的偏好判成"同一件事被改了"，
  // 还会让模型自信地复述一条它从没被告诉过的事实。
  //
  // 所以宁可不产出结构化 cell（返回 null），把这句话交给残差通道兜底。
  if (ctx.pred === 'prefers' || ctx.pred === 'dislikes') {
    const hasValue = Boolean(pref.value || pref.topic || ident || verbObject)
    if (!hasValue) return null
  }
  if (patient) slots.push(lit(SLOT_ROLE.PATIENT, patient))

  if (ctx.timeRange) {
    const d = new Date(ctx.timeRange.from)
    slots.push(lit(SLOT_ROLE.TIME, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`))
  }
  // 数量槽不能从脱敏占位符里取数字：「SECRET:1» 里的 1 不是数量。
  const qty = text.replace(PLACEHOLDER_G, ' ').match(/(\d+(?:\.\d+)?)\s*(个|次|天|周|月|年|行|条|%|ms|s|kb|mb)?/i)
  if (qty && qty[1]) slots.push(lit(SLOT_ROLE.QTY, `${qty[1]}${qty[2] ?? ''}`))
  slots.push(lit(SLOT_ROLE.POLARITY, ctx.neg ? 'neg' : 'pos'))

  // 未提及的槽显式记 UNK 吗？不。UNK 只在"确实存在该角色但未填"时才有意义，
  // 给每个命题都塞 8 个 UNK 会把 SDR 稀释。这里只填实际出现的角色。
  return slots
}

function pickKind(text: string, pred: string): number {
  for (const r of PROPOSITION_KIND) if (r.re.test(text)) return r.kind
  if (pred === 'prefers' || pred === 'dislikes') return KIND.semantic
  if (/bug|报错|失败/.test(text)) return KIND.episodic
  return KIND.semantic
}

function firstSentence(text: string): string {
  const i = text.search(/[。！？\n.!?]/)
  return (i > 0 ? text.slice(0, i) : text).slice(0, 160)
}

/**
 * 按**字节**截断（v0.5.2 修 D22）。
 *
 * 配置项叫 `maxResidualBytes`，而 v0.5.1 的实现是 `text.slice(0, max)`——
 * 那是按 UTF-16 **码元**截断。中文一个字 3 字节，于是"8192"实际存了约 24 KB，
 * 而同一段代码在 `rawLen` 里报的是真字节数，两个口径并存。
 *
 * 现在按码点累加 UTF-8 字节，切在**码点边界**上（不会切出半个代理对）。
 * 一次 800 字的轮次上这点计算可以忽略；换来的是"名字说 8192 就真的是 8192 字节"。
 */
function truncateToBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= maxBytes) return text
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const n = enc.encode(ch).length
    if (bytes + n > maxBytes) break
    bytes += n
    out += ch
  }
  return out
}

function clamp11(x: number): number {
  return Math.min(1, Math.max(-1, Number.isFinite(x) ? x : 0))
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}


interface PendingTurn {
  sessionId: string
  turn: number
  seqs: number[]
  user: string[]
  assistant: string[]
  tools: Array<{ name: string; text: string; fromWeb?: boolean }>
  at: number
}

/** 事件载荷在 rc 间调整过，读侧一律走宽类型 + 运行时校验，不强转（§14.4 的 ⚠）。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object') {
          const o = b as Record<string, unknown>
          if (typeof o.text === 'string') return o.text
          if (typeof o.content === 'string') return o.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (content && typeof content === 'object') {
    const o = content as Record<string, unknown>
    if (typeof o.text === 'string') return o.text
  }
  return ''
}

export function apply(ctx: Context, config: Config) {
  const memory = ctx.get('memory') as MemoryService
  if (!memory) throw new Error('[mnemo-encoder] 需要 ctx.memory（先装 @rain13sad/llm-mnemo-core）')
  const hostLlm = config.l1.enabled ? fromHostLlm(ctx.get('llm')) : null
  const port = hostLlm
  const encoder = new Encoder(memory, memory.space, config, port)
  const runtime = ctx.get('mnemoRuntime') as RuntimeStatus | undefined
  const log = ctx.logger('mnemo-encoder')

  // 暴露给面板/命令面读（L1 状态、预算等）
  try {
    ctx.provide('mnemoEncoder', encoder)
  } catch {
    /* 热重载时已存在 */
  }

  const pushL1 = () => {
    const s = encoder.l1Status()
    runtime?.setL1(s)
    if (runtime) {
      runtime.capabilities = [
        ...runtime.capabilities.filter((c) => !c.startsWith('L1')),
        s.mode === 'port' ? `L1 · ${s.entry ?? 'port'}` : s.enabled ? 'L1 · lite 规则切分' : 'L1 · 关闭',
      ]
    }
  }
  pushL1()

  // 启动自检：入口存在 ≠ 能跑通。探针失败不抛错，只把结论写进运行时状态。
  if (config.l1.enabled && port && config.l1.probe) {
    ctx.effect(() => {
      let alive = true
      void (async () => {
        const r = await probeLlmPort(port, config.l1.timeoutMs)
        if (!alive) return
        runtime?.setL1({ enabled: true, entry: (port as HostLlmPort).entry, ok: r.ok, lastMs: r.ms, note: r.note, mode: r.ok ? 'lite' : 'lite' })
        pushL1()
        log.info(`L1 自检：${r.ok ? '通过' : '失败'}（${(port as HostLlmPort).entry}，${r.ms}ms）${r.note}`)
        if (!r.ok && runtime) {
          runtime.limits = [...runtime.limits.filter((x) => !x.startsWith('L1')), `L1：宿主 llm 自检未通过（${r.note}），当前用 lite 规则切分`]
        }
      })()
      return () => {
        alive = false
      }
    }, 'mnemo-encoder: l1 probe')
  } else if (config.l1.enabled && !port) {
    log.warn('L1 已启用但未识别到宿主 llm 入口，降级为 lite 规则切分')
    if (runtime) runtime.limits = [...runtime.limits.filter((x) => !x.startsWith('L1')), 'L1：未识别到 ctx.llm 入口，当前用 lite 规则切分']
  }

  /** 按会话累积本轮事件，在 turn/end 一次性编码——逐条编码会把碎片写进库。 */
  const pending = new Map<string, PendingTurn>()

  const bucket = (sessionId: string, turn: number): PendingTurn => {
    let p = pending.get(sessionId)
    if (!p || p.turn !== turn) {
      p = { sessionId, turn, seqs: [], user: [], assistant: [], tools: [], at: Date.now() }
      pending.set(sessionId, p)
    }
    return p
  }

  ctx.effect(() => {
    const off = ctx.on('session/event', (session: { id?: string }, event: Record<string, unknown>) => {
      const sid = String(session?.id ?? (event.sessionId as string) ?? 'default')
      const type = String(event.type ?? '')
      const seq = Number(event.seq ?? 0)
      const at = Number(event.time ?? Date.now())
      const turn = Number(event.turn ?? (pending.get(sid)?.turn ?? 0))

      switch (type) {
        case 'turn/start':
          bucket(sid, turn)
          break
        case 'user/message': {
          const p = bucket(sid, turn)
          p.seqs.push(seq)
          const text = textOf((event as { content?: unknown }).content ?? (event as { message?: unknown }).message)
          if (text.trim()) p.user.push(text)
          p.at = at
          break
        }
        case 'assistant/message': {
          const p = bucket(sid, turn)
          p.seqs.push(seq)
          const text = textOf((event as { content?: unknown }).content ?? (event as { message?: unknown }).message)
          if (text.trim()) p.assistant.push(text)
          break
        }
        case 'tool/result': {
          const p = bucket(sid, turn)
          p.seqs.push(seq)
          const name = String((event as { name?: string }).name ?? 'tool')
          const text = textOf((event as { content?: unknown }).content)
          if (text.trim()) p.tools.push({ name, text, fromWeb: /fetch|search|web/i.test(name) })
          break
        }
        case 'turn/end': {
          const p = pending.get(sid)
          pending.delete(sid)
          if (!p) break
          // 带上 affect 的当前 PAD：不带的话每条 cell 的情感维度都是 0，
          // "情感记忆"就永远不会被标记（实测踩过：flags.bit6 一条都打不上）。
          const affectNow = ctx.get('affect') as { current?(): { v: number; a: number; d: number; s: number } } | undefined
          const input: TurnInput = {
            sessionId: sid,
            seqs: p.seqs,
            turn: p.turn,
            userText: p.user.join('\n'),
            assistantText: p.assistant.join('\n'),
            toolResults: p.tools,
            at: p.at,
            pad: affectNow?.current?.(),
          }
          const finish = (r: EncodeResult) => {
            for (const cell of r.cells) {
              memory.emit('memory/cell', {
                cellId: cell.cellId.toString(16).padStart(16, '0'),
                kind: cell.kind,
                digest: cell.digest ?? '',
                sourceSeqs: p.seqs,
                residualRef: cell.residual ? String(cell.residual.off) : undefined,
              })
            }
            memory.noteTurn()
          }
          // L1 端口可用时走异步路径（宿主在 turn/end 上不 await，但监听器自身可以 async）；
          // 任何异常都退回同步路径，绝不让"模型不可用"变成"这一轮没记"。
          if (config.l1.enabled && port) {
            void (async () => {
              try {
                finish(await encoder.encodeTurnAsync(input))
              } catch (err) {
                log.warn(`L1 编码失败，回退同步路径：${String(err)}`)
                try {
                  finish(encoder.encodeTurn(input))
                } catch (err2) {
                  log.error(`编码失败：${String(err2)}`)
                }
              } finally {
                pushL1()
              }
            })()
          } else {
            finish(encoder.encodeTurn(input))
            pushL1()
          }
          break
        }
      }
    })
    return () => {
      off()
      pending.clear()
    }
  }, 'mnemo-encoder: turn accumulation')

  // 影子日志：只存重建晶格所需的最小信息（§14.11）。
  // 它不是 DSH Session Log 的替代品，而是让 /mnemo rebuild 不依赖宿主回放接口。
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      const e = event as { type?: string; seq?: number; turn?: number; time?: number; content?: unknown; name?: string }
      const sid = String((session as { id?: string })?.id ?? 'default')
      const type = String(e?.type ?? '')
      const role = type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : type === 'tool/result' ? 'tool' : ''
      if (!role) return
      const text = textOf(e.content)
      if (!text.trim()) return
      // 影子日志也要脱敏：它是重建晶格的唯一依据，而重建用的编码器读的是脱敏文本，
      // 所以存脱敏版本既等价、又不把明文凭据落第二份盘（审查实测过这一处泄漏）。
      const safe = redact(text).text
      try {
        memory.store.appendLog({
          session: sid,
          seq: Number(e.seq ?? 0),
          turn: Number(e.turn ?? 0),
          role: role as 'user' | 'assistant' | 'tool',
          text: safe,
          at: Number(e.time ?? Date.now()),
        })
      } catch {
        /* 影子日志写失败不影响主链路 */
      }
    })
    return () => off()
  }, 'mnemo-encoder: shadow log')

  // 重建钩子：清派生层 → 按会话/轮次重放日志 → 重新编码
  memory.registerRebuildHook(async () => {
    const entries = memory.store.listLog()
    if (entries.length === 0) return { turns: 0, cells: 0 }
    // 保留 kind 3/4/5：图式、人格锚、关系模型不是对话日志的派生物
    memory.store.clearLattice([3, 4, 5])

    const byTurn = new Map<string, { session: string; turn: number; seqs: number[]; user: string[]; assistant: string[]; tools: Array<{ name: string; text: string }>; at: number }>()
    for (const e of entries) {
      const key = `${e.session}#${e.turn}`
      const cur = byTurn.get(key) ?? { session: e.session, turn: e.turn, seqs: [], user: [], assistant: [], tools: [], at: e.at }
      cur.seqs.push(e.seq)
      cur.at = Math.min(cur.at || e.at, e.at)
      if (e.role === 'user') cur.user.push(e.text)
      else if (e.role === 'assistant') cur.assistant.push(e.text)
      else cur.tools.push({ name: 'tool', text: e.text })
      byTurn.set(key, cur)
    }

    let cells = 0
    let turns = 0
    for (const t of byTurn.values()) {
      const r = encoder.encodeTurn(
        {
          sessionId: t.session,
          seqs: t.seqs,
          turn: t.turn,
          userText: t.user.join('\n'),
          assistantText: t.assistant.join('\n'),
          toolResults: t.tools,
          at: t.at,
        },
        { skipSensory: true },
      )
      cells += r.created
      turns++
    }
    return { turns, cells }
  })

  ctx.logger('mnemo-encoder').info(`encoder ready (maxCellsPerTurn=${config.maxCellsPerTurn})`)
  return encoder
}

export { Encoder as MnemoEncoder }
export const PROVENANCE_LABEL = PROV_NAME
