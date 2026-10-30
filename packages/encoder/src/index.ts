/**
 * @rain13sad/dsh-mnemo-encoder —— 写侧（§7 / §14.2）
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
  hashEmbedding,
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
  type MemCell,
  type ResidualRef,
  type MemoryService,
  type Slot,
  type Sdr,
  type SdrSpace,
} from '@rain13sad/dsh-mnemo-core'

import { fromHostLlm, parseLlmPropositions, probeLlmPort, segmentLite, segmentWithPort, type HostLlmPort, type LlmPort, type Proposition } from './l1.js'
import type { L1Status, RuntimeStatus } from '@rain13sad/dsh-mnemo-core'

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
    const budget = this.maxCellsForTurn(input.userText)

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
    const turnText = redact(input.userText).text.slice(0, this.config.maxResidualBytes)
    const turnBytes = new TextEncoder().encode(turnText)
    const turnRef: ResidualRef = {
      sha: shaOf(turnText),
      off: BigInt(this.memory.store.putResidual(shaOf(turnText), turnBytes)),
      rawLen: turnBytes.length,
    }

    const push = (text: string, provenance: 0 | 1 | 2 | 3, seq: number) => {
      if (out.cells.length >= budget) {
        out.skipped++
        return
      }
      const key = text.trim().toLowerCase()
      if (!key || seen.has(key)) return
      seen.add(key)
      const cell = this.buildCell({ ...input, at }, text, provenance, seq, turnRef)
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
     * v0.5：**先脱敏，再切分**。
     *
     * v0.4 是"先切分、后脱敏"（脱敏发生在 buildCell 里），而切分按标点断句，
     * `https://x.com/cb?access_token=SECRET123` 会被切成 `...cb?access_token=SECRET123` 之外的碎片，
     * 丢掉 `?` 之后 URL token 规则（旧版依赖 `[?&]` 锚点）就漏判了——实测 4 个参数名全明文。
     * 顺序反过来之后，占位符 `«SECRET:n»` 会跟着命题一起被切，但它是不可再分的整体。
     */
    const safeUserText = redact(input.userText).text
    let seq = input.seqs[0] ?? 0
    for (const p of this.segment(safeUserText)) {
      // 疑问句不是断言：'我之前说的字体偏好是什么？' 若被编码，会变成一条假记忆
      if (isQuestion(p)) {
        out.skipped++
        continue
      }
      push(p, 0, seq++)
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
    const turnText = redact(input.userText).text.slice(0, this.config.maxResidualBytes)
    const turnBytes = new TextEncoder().encode(turnText)
    const turnRef: ResidualRef = {
      sha: shaOf(turnText),
      off: BigInt(this.memory.store.putResidual(shaOf(turnText), turnBytes)),
      rawLen: turnBytes.length,
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
      const cell = this.buildCell({ ...input, at }, p.text, 0, s, turnRef)
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
    const pred = detectPredicate(safe)
    const neg = isNegated(safe)
    const timeRange = parseTimeExpr(safe, at)
    const slots = scrubSlots(fillSlots(safe, { ents, pred, neg, timeRange, provenance }))
    if (slots.length === 0) return null

    const sdr = this.buildSdr(slots)
    const emb = hashEmbedding(safe, this.memory.config.embDim)
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
      const rawBytes = new TextEncoder().encode(red.text.slice(0, this.config.maxResidualBytes))
      const sha = shaOf(red.text)
      residualRef = { sha, off: BigInt(this.memory.store.putResidual(sha, rawBytes)), rawLen: rawBytes.length }
    }

    const cellId = cellIdFor(input.sessionId, [seq], sdr)
    const stability = kind === KIND.procedure ? 30 : kind === KIND.episodic ? 2 : 7

    const cell: MemCell = {
      cellId,
      kind: kind as MemCell['kind'],
      tier: 1,
      flags: FLAG.residual | (provenance === 3 ? FLAG.web : 0) | (red.pii ? FLAG.pii | FLAG.redacted : 0),
      tFrom: BigInt(timeRange ? timeRange.from : at),
      tTo: BigInt(timeRange ? timeRange.to : at),
      tIngest: BigInt(at),
      tAccess: BigInt(at),
      accessCount: 0,
      stability,
      importance,
      valence: pad.v,
      arousal: pad.a,
      dominance: pad.d,
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
      topic: topicFingerprint(safe),
      digest: red.text.slice(0, 120),
      // 作用域与会话归属（§14.10）：情景记忆靠 session 隔离，语义记忆靠 scope 共享
      scope: this.memory.scopeKey,
      session: input.sessionId,
    }
    return cell
  }

  /** 命题 SDR：bind(filler, role) 后 bundle（§6.6）。参数顺序是 (填充值, 角色)。 */
  buildSdr(slots: readonly Slot[]): Sdr {
    const items = slots
      .filter((s) => s.type !== 'UNK' && s.value)
      .slice(0, 8)
      .map((s) => {
        const roleName = Object.entries(SLOT_ROLE).find(([, v]) => v === s.role)?.[0] ?? String(s.role)
        return this.space.bind(this.space.identity('V:' + normToken(s.value)), this.space.role(roleName))
      })
    return this.space.bundle(items)
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

/** 槽位填充：规则版。8 个语义槽 + POLARITY（§7.3 / §7.6）。 */
export function fillSlots(  text: string,
  ctx: { ents: string[]; pred: string; neg: boolean; timeRange?: { from: number; to: number }; provenance: number },
): Slot[] {
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
  if (!memory) throw new Error('[mnemo-encoder] 需要 ctx.memory（先装 @rain13sad/dsh-mnemo-core）')
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
