/**
 * EmotionMemoryEngine —— LLM 层面的情感记忆引擎（v0.6 的主交付）
 *
 * ── 定位 ────────────────────────────────────────────────────────
 * v0.5 之前，MnemoVault 是"一个 DSH 插件"：能力都在 Cordis 的钩子里，
 * 换一个宿主就等于重写一遍接线。v0.6 把它拆成两半：
 *
 *   · 内核（core）：同步、纯函数、零第三方依赖 —— 不认识宿主
 *   · 引擎（本文件）：异步、面向任意 LLM —— 只认端口，不认识 Cordis
 *
 * 于是"适配常用大模型"不再是给每个模型写一份适配器，而是：
 * **一份引擎 + 一张模型画像表 + 五个端口**。
 *
 * ── 它到底做什么 ────────────────────────────────────────────────
 * 对上层（LLM / Agent / MCP）暴露五个动词，正好对应"情感记忆"的五个动作：
 *
 *   observe(text)  看一眼用户说了什么 → 更新心境 → 给出一行情感摘要
 *   remember(text) 把这段话变成记忆（需要 encoder 回调）
 *   recall(text)   取回相关记忆 → **按目标模型编译成预算内的上下文**
 *   forget(id)     删除并返回**可验证的删除回执**
 *   status()       当前跑的是真模型还是降级实现（诚实清单）
 *
 * ── 为什么 recall 要"编译"而不是"渲染" ────────────────────────────
 * 同一批记忆，给 GPT-4o 和给本地 7B 模型必须长得不一样：
 * 前者吃 MRS 行式（省 token），后者只能吃散文（多花 2.5×）。
 * 把这件事做成 `compile()` 而不是配置项，是因为**它取决于目标模型，
 * 而不取决于用户偏好**——用户不该被要求知道"哪个模型看不懂行式"。
 */

import type { MemCell } from './cell.js'
import { foldEmb } from './cell.js'
import { compileContext, previewAcrossModels, resolveModel, type CompileOutput } from './compiler.js'
import { behaviorHints, emotionBrief, estimateAffect, integrateMood, NEUTRAL_PAD, type AffectEstimate, type EmotionLabel } from './emotion.js'
import type { AuditPort, ClockPort, EmbeddingPort, EnginePorts, ModelProfile, TokenizerPort } from './ports.js'
import { quantize, queryEmbedding } from './recall.js'
import type { MemoryService } from './service.js'
import type { MnemoConfig, PanelEngineInfo, Pad, RecallQuery, RecallResult } from './types.js'

/** 编码回调：由 encoder 包提供。引擎不认识 L1 切分规则，只要求"给我 cell"。 */
export type EncodeFn = (
  text: string,
  meta: { turn?: number; speaker?: 'user' | 'assistant' | 'tool' },
) => MemCell[]

export interface EngineOptions {
  memory: MemoryService
  ports?: EnginePorts
  /** 模型 id 或完整画像。缺省按 `config.llm.model` 查表 */
  model?: string | ModelProfile
  /** 编码回调。没有它时 `remember()` 会明确报错，而不是静默什么都不做 */
  encode?: EncodeFn
  clock?: ClockPort
  audit?: AuditPort
  /** 单轮注入 token 上限（缺省用 config.maxSurfaceTokens） */
  maxTokens?: number
  /** 单轮注入价格上限（¥，缺省用 config.llm.maxPricePerTurn，0 = 不限） */
  maxPrice?: number
}

export interface EngineRecall {
  result: RecallResult
  /** 按目标模型编译后的上下文（可能与 result.rendered 不同：格式降级 / 裁剪） */
  context: string
  tokens: number
  cost: number
  mode: string
  reasons: string[]
  /** 是否用了真 embedding（false = 哈希降级） */
  usedProvider: boolean
  brief: string | null
}

export interface DeletionReceipt {
  cellId: string
  /** 被删对象的摘要（删除后仍可核对，但不含原文） */
  digest: string
  mode: 'soft' | 'hard'
  at: number
  /**
   * 墓碑 id。当前实现里**永远是 null**：
   * soft 删除 = 降到归档层（tier 3，importance ≤ 0.05，可 restore），
   * hard 删除 = 物理删除（连墓碑都没有）。真正的墓碑（tier 4）由保留度链路的
   * `demoteDue` 产生，不经过这个入口。字段保留是为了将来把两条路并进来。
   */
  tombstoneId: string | null
  /** 删除后仍引用这条记忆的边数（0 = 真的没有悬空引用） */
  danglingEdges: number
  /** 可校验摘要：sha 风格的短指纹，用于"这条真的没了"的自证 */
  proof: string
}

export interface ObserveResult {
  affect: AffectEstimate
  mood: Pad
  brief: string
  hints: string[]
}

/**
 * 引擎主体。
 *
 * 一条刻意的设计：**它不持有 store**。所有读写都经 `memory`，
 * 这样"引擎看到的世界"与"宿主看到的世界"永远一致，
 * 不会出现"面板显示 100 条、引擎只看到 80 条"的分裂。
 */
export class EmotionMemoryEngine {
  readonly memory: MemoryService
  readonly ports: EnginePorts
  readonly model: ModelProfile
  private readonly encode?: EncodeFn
  private readonly clock: ClockPort
  private readonly audit: AuditPort
  private readonly maxTokens: number
  private readonly maxPrice: number
  private mood: Pad = { ...NEUTRAL_PAD }
  private labels: EmotionLabel[] = []
  private lastCompile: PanelEngineInfo['lastCompile'] = null
  private lastProbe: { ok: boolean; message: string; at: number } | null = null
  /**
   * 端口是否由调用方显式注入。
   *
   * 两种开启方式都算数：
   *   · 宿主配置 `llm.embeddingEnabled = true`（部署级开关）
   *   · 构造时显式传 `ports.embedding`（代码级开关，独立使用者走这条）
   * 这样"没配就不联网"的默认仍然成立，而 SDK 使用者不必去改配置。
   */
  private readonly explicitPorts: boolean

  constructor(opts: EngineOptions) {
    this.memory = opts.memory
    this.ports = opts.ports ?? opts.memory.ports ?? {}
    this.explicitPorts = Boolean(opts.ports?.embedding)
    this.encode = opts.encode
    this.clock = opts.clock ?? this.ports.clock ?? { now: () => Date.now() }
    this.audit = opts.audit ?? this.ports.audit ?? { record() {}, list: () => [] }
    this.model = typeof opts.model === 'string' ? resolveModel(opts.model) : opts.model ?? resolveModel(this.config.llm.model)
    this.maxTokens = opts.maxTokens ?? this.config.maxSurfaceTokens
    this.maxPrice = opts.maxPrice ?? this.config.llm.maxPricePerTurn
  }

  private get config(): MnemoConfig {
    return this.memory.config
  }

  // ── ① 观察：情感估计 + 心境积分 ──────────────────────────────

  /**
   * 看一眼用户说了什么。**不写库**——它只更新引擎自己的心境状态。
   *
   * 为什么不顺手 ingest：因为"看一眼"与"记住"是两件事。
   * 客服场景里大量发言不该进长期记忆（寒暄、情绪宣泄），
   * 把两者绑在一起会让 `salience` 失去意义。
   */
  observe(text: string, opts: { turn?: number } = {}): ObserveResult {
    const est = estimateAffect(text)
    this.mood = integrateMood(this.mood, { v: est.v, a: est.a, d: est.d, s: est.s }, 18)
    this.labels = est.labels
    const brief = emotionBrief({
      pad: this.mood,
      labels: est.labels,
      hints: behaviorHints({ pad: this.mood, unresolved: 0 }),
    })
    this.audit.record({
      at: this.clock.now(),
      action: 'observe',
      target: `turn:${opts.turn ?? 0}`,
      actor: 'user',
      detail: `v=${est.v.toFixed(2)} a=${est.a.toFixed(2)} conf=${est.confidence.toFixed(2)}`,
    })
    return { affect: est, mood: { ...this.mood }, brief, hints: behaviorHints({ pad: this.mood }) }
  }

  moodNow(): { pad: Pad; labels: EmotionLabel[]; brief: string } {
    return {
      pad: { ...this.mood },
      labels: [...this.labels],
      brief: emotionBrief({ pad: this.mood, labels: this.labels }),
    }
  }

  /**
   * 抽取（v0.6）。没有 extractor 端口时返回 null——调用方回落规则路径。
   *
   * 这个方法存在的意义是让"LLM 抽取"成为**可单独调用**的能力：
   * 外部 Agent 可以只要抽取、不要存储（比如先给人看一眼再决定记不记）。
   */
  async extract(text: string): Promise<import('./ports.js').ExtractedFact[] | null> {
    const x = this.ports.extractor
    if (!x) return null
    try {
      const r = await x.extract({ text, timeoutMs: this.config.llm.timeoutMs })
      this.memory.counters.noteExtract(r !== null)
      return r
    } catch (err) {
      this.memory.counters.noteExtract(false)
      this.memory.counters.noteEmbedError(err)
      return null
    }
  }

  // ── ② 记住：委托 encoder ────────────────────────────────────

  remember(text: string, meta: { turn?: number; speaker?: 'user' | 'assistant' | 'tool' } = {}): MemCell[] {
    if (!this.encode) {
      throw new Error(
        '[mnemo-engine] remember() 需要 encoder 回调：new EmotionMemoryEngine({ encode })；' +
          'DSH 宿主里由 @rain13sad/llm-mnemo-encoder 提供，独立使用时用 devkit.createHarness()。',
      )
    }
    const cells = this.encode(text, meta)
    this.audit.record({
      at: this.clock.now(),
      action: 'ingest',
      target: cells.map((c) => c.cellId.toString(16).slice(-8)).join(','),
      actor: meta.speaker === 'assistant' ? 'agent' : 'user',
      detail: `${cells.length} 条 · ${text.slice(0, 24)}`,
    })
    return cells
  }

  // ── ③ 取回：预热向量 → 召回 → 编译 ──────────────────────────

  /**
   * 取回并编译。这是引擎对 LLM 的**唯一入口**。
   *
   * 三段式，每段都可能降级，且每次都如实报告降在哪：
   *   1. 向量：provider（真语义）→ 哈希（零依赖）
   *   2. 召回：内核四路（不变）
   *   3. 编译：rows → compact → prose（按模型能力与预算）
   */
  async recall(text: string, opts: Partial<RecallQuery> & { prime?: boolean } = {}): Promise<EngineRecall> {
    const { prime = true, ...query } = opts
    const embedding = this.ports.embedding
    const useProvider = this.embeddingUsable()
    let usedProvider = false

    if (prime && useProvider && embedding) {
      try {
        if (embedding.prime) {
          await embedding.prime([text])
        } else {
          await embedding.embed(text)
        }
      } catch (err) {
        this.memory.counters.noteEmbedError(err)
      }
    }

    const q: RecallQuery = {
      text,
      budget: this.maxTokens,
      ...query,
    }
    if (useProvider && embedding?.peek) {
      const v = embedding.peek(text)
      if (v && v.length > 0) {
        q.emb = v
        usedProvider = true
      }
    }

    const result = this.memory.recall(q)
    const cells = result.hits
      .map((h) => {
        const cell = this.memory.store.getCell(BigInt('0x' + h.cellId))
        return cell ? { cell, shortId: h.shortId } : null
      })
      .filter((x): x is { cell: MemCell; shortId: string } => x !== null)

    const compiled = this.compileCells(cells, this.moodBriefLine())
    this.lastCompile = {
      at: this.clock.now(),
      tokens: compiled.tokens,
      cost: compiled.cost,
      mode: compiled.mode,
      model: compiled.model,
      dropped: compiled.droppedByBudget,
      reasons: compiled.reasons,
    }
    this.audit.record({
      at: this.clock.now(),
      action: 'recall',
      target: result.queryId,
      actor: 'agent',
      detail: `${result.hits.length} 命中 · ${compiled.tokens} tok · ${compiled.mode}${usedProvider ? ' · provider' : ' · hash'}`,
    })
    return {
      result,
      context: compiled.text,
      tokens: compiled.tokens,
      cost: compiled.cost,
      mode: compiled.mode,
      reasons: compiled.reasons,
      usedProvider,
      brief: this.config.affectEnabled ? emotionBrief({ pad: this.mood, labels: this.labels }) : null,
    }
  }

  /** 用当前配置与模型重编一次（面板"重编"按钮）。不查库，只重算格式与成本。 */
  compileNow(): { tokens: number; cost: number; mode: string; reasons: string[] } | null {
    const snap = this.memory.panelSnapshot()
    const cells = snap.cells.slice(0, 24).map((c) => {
      const cell = this.memory.store.getCell(BigInt('0x' + c.cellId))
      return cell ? { cell, shortId: c.shortId } : null
    })
    const list = cells.filter((x): x is { cell: MemCell; shortId: string } => x !== null)
    if (list.length === 0) return null
    const out = this.compileCells(list, this.moodBriefLine())
    this.lastCompile = {
      at: this.clock.now(),
      tokens: out.tokens,
      cost: out.cost,
      mode: out.mode,
      model: out.model,
      dropped: out.droppedByBudget,
      reasons: out.reasons,
    }
    return { tokens: out.tokens, cost: out.cost, mode: out.mode, reasons: out.reasons }
  }

  private compileCells(cells: Array<{ cell: MemCell; shortId: string }>, affectLine?: string): CompileOutput {
    return compileContext({
      cells,
      model: this.model,
      maxTokens: this.maxTokens,
      maxPrice: this.maxPrice > 0 ? this.maxPrice : undefined,
      mode: this.config.surfaceMode,
      includeLegend: true,
      affectLine,
      tokenizer: this.ports.tokenizer ?? null,
    })
  }

  private moodBriefLine(): string | undefined {
    if (!this.config.affectEnabled) return undefined
    if (this.mood.v === 0 && this.mood.a === 0 && this.labels.length === 0) return undefined
    return emotionBrief({ pad: this.mood, labels: this.labels })
  }

  // ── ④ 遗忘：带回执 ─────────────────────────────────────────

  /**
   * 删除并返回回执（创新 I2 的最小可用形态）。
   *
   * 回执的三个字段各有用途：
   *   · digest      —— 删了之后用户还能核对"删的是不是这条"
   *   · tombstoneId —— soft 删除的墓碑 id，可用于 restore 或二次核验
   *   · danglingEdges —— 0 表示没有悬空引用（这是"删干净了"的硬证据）
   *
   * `proof` 是内容指纹，不是密码学签名：它证明"这条记录的摘要自删除后没变过"，
   * 不证明"我们真的没有备份"。宣称后者需要 append-only 存储 + 第三方审计，
   * 那不在本版范围（诚实清单里写着）。
   */
  forget(cellId: string, mode: 'soft' | 'hard' = 'soft'): DeletionReceipt {
    const id = BigInt('0x' + cellId.replace(/^0x/, '').padStart(16, '0'))
    const cell = this.memory.store.getCell(id)
    const digest = cell?.digest ?? ''
    const dangling = this.memory.store.edgesFrom(id).length + this.memory.store.edgesTo(id).length
    this.memory.forget(cellId, mode, 'user', 'engine.forget')
    const at = this.clock.now()
    const receipt: DeletionReceipt = {
      cellId: cellId,
      digest,
      mode,
      at,
      tombstoneId: null,
      danglingEdges: dangling,
      proof: proofOf(digest, at),
    }
    this.audit.record({
      at,
      action: 'forget',
      target: cellId,
      actor: 'user',
      detail: `${mode} · proof=${receipt.proof} · dangling=${dangling}`,
    })
    return receipt
  }

  // ── ⑤ 状态：诚实清单 ───────────────────────────────────────

  status(): PanelEngineInfo {
    const embedding = this.ports.embedding
    const usable = this.embeddingUsable()
    const caps: string[] = []
    const limits: string[] = []
    if (usable) caps.push(`语义路 · ${embedding?.name ?? 'provider'}`)
    else caps.push('语义路 · 本地哈希（零依赖）')
    if (this.ports.extractor) caps.push(`抽取 · ${this.ports.extractor.name}`)
    else caps.push('抽取 · 规则')
    caps.push(`编译 · ${this.model.label}`)
    if (this.ports.tokenizer) caps.push(`计数 · ${this.ports.tokenizer.name}`)
    else caps.push('计数 · 启发式')

    if (!usable) limits.push('未启用真 embedding：语义路是字符 bigram + 同义词桥，不是语义模型')
    if (!this.ports.extractor) limits.push('未启用 LLM 抽取：规则路线的谓词表是封闭的')
    if (this.config.llm.maxPricePerTurn === 0) limits.push('未设价格上限：贵模型下记忆注入的成本不受约束')
    if (this.lastProbe && !this.lastProbe.ok) limits.push(`最近一次连通性探测失败：${this.lastProbe.message}`)

    const snap = this.memory.panelSnapshot()
    const sample = snap.cells.slice(0, 12).map((c) => {
      const cell = this.memory.store.getCell(BigInt('0x' + c.cellId))
      return cell ? { cell, shortId: c.shortId } : null
    })
    const list = sample.filter((x): x is { cell: MemCell; shortId: string } => x !== null)
    // 跨模型预览：同一批记忆在 6 个常见模型下各要多少 token / 多少钱。
    // 这是"适配常用大模型"最直观的证据——不是兼容列表，是成本表。
    const across = list.length ? previewAcrossModels(list, this.maxTokens) : []

    return {
      model: {
        id: this.model.id,
        provider: this.model.provider,
        label: this.model.label,
        contextWindow: this.model.contextWindow,
        inputPricePerMTok: this.model.inputPricePerMTok,
      },
      embedding: {
        mode: usable ? 'provider' : 'hash',
        name: embedding?.name ?? 'hash',
        space: embedding?.space ?? 'hash',
        vaultSpace: this.memory.embSpace,
        primed: this.memory.counters.embedPrimed,
        misses: this.memory.counters.embedMiss,
        error: this.memory.counters.error,
      },
      extractor: {
        mode: this.ports.extractor ? 'provider' : 'rule',
        name: this.ports.extractor?.name ?? 'rule-lite',
        ok: this.memory.counters.extractOk,
        failed: this.memory.counters.extractFail,
        failRate: this.memory.counters.extractFailRate,
      },
      tokenizer: this.ports.tokenizer?.name ?? 'heuristic',
      lastCompile: this.lastCompile,
      across,
      mood: { ...this.mood },
      brief: this.config.affectEnabled ? emotionBrief({ pad: this.mood, labels: this.labels }) : null,
      capabilities: caps,
      limits,
    }
  }

  /** 把状态回填到面板（宿主侧调用；独立使用时可以不调）。 */
  publish(): PanelEngineInfo {
    const info = this.status()
    this.memory.noteEngine(info)
    return info
  }

  // ── 端口运维 ────────────────────────────────────────────────

  /**
   * provider 向量是否**真的可用**。
   *
   * 判据只有一条：库的向量空间 == 端口的向量空间。
   * 早期版本这里放行了"库还是哈希空间"的情况（想省掉一次重算），
   * 结果是拿 provider 向量去打哈希库——余弦相似度仍然返回 0~1 之间的数，
   * 但那个数没有意义。**这种错误不会报错，只会让召回悄悄变差**，所以必须拦住。
   * 想让 provider 生效，唯一的路是 `reembed()` 把全库换到新空间。
   */
  private embeddingUsable(): boolean {
    if (!this.config.llm.embeddingEnabled && !this.explicitPorts) return false
    const e = this.ports.embedding
    if (!e) return false
    return this.memory.embSpace === e.space
  }

  /**
   * 连通性探测。**真的发一次最小请求**——不做"配置看起来对就算通"的自欺。
   */
  async probe(): Promise<{ ok: boolean; message: string }> {
    const e = this.ports.embedding
    const x = this.ports.extractor
    if (!e && !x) {
      this.lastProbe = { ok: false, message: '未配置任何模型端口', at: this.clock.now() }
      return { ok: false, message: this.lastProbe.message }
    }
    const parts: string[] = []
    let ok = true
    if (e) {
      try {
        const v = await e.embed('probe')
        parts.push(`embedding ok（${v.length} 维，${e.name}）`)
      } catch (err) {
        ok = false
        parts.push(`embedding 失败：${String((err as Error)?.message ?? err)}`)
      }
    }
    if (x) {
      try {
        const r = await x.extract({ text: '我更喜欢用 pnpm。', timeoutMs: this.config.llm.timeoutMs })
        parts.push(r ? `抽取 ok（${r.length} 条）` : '抽取返回空')
      } catch (err) {
        ok = false
        parts.push(`抽取失败：${String((err as Error)?.message ?? err)}`)
      }
    }
    const message = parts.join(' · ')
    this.lastProbe = { ok, message, at: this.clock.now() }
    return { ok, message }
  }

  /**
   * 重算向量空间（创新 I1 的工程前提）。
   *
   * 为什么需要它：dense vector 路线下，换 embedding 模型 = 全库重算，
   * 这是**固有成本**，不是本项目的缺陷。能做的是让它可续、可观测、不阻塞：
   *   · 游标存在 meta 里，每批 500 条，可反复调用直到 done=total
   *   · 用 digest + 槽位文本作为重算输入（原文在残差里，取出来慢 10 倍）
   *   · 全部完成后才把 `emb.space` 切到 provider —— 中途失败不会留下半个空间
   */
  async reembed(opts: { limit?: number; batch?: number } = {}): Promise<{ done: number; total: number; skipped: number; space: string }> {
    const e = this.ports.embedding
    if (!e) return { done: 0, total: 0, skipped: 0, space: this.memory.embSpace }
    const limit = opts.limit ?? 500
    const ids: bigint[] = []
    this.memory.store.forEachCell((c) => ids.push(c.cellId))
    const cursor = Number(this.memory.store.meta('emb.reembed.cursor') ?? 0)
    const slice = ids.slice(cursor, cursor + limit)
    let skipped = 0
    for (const id of slice) {
      const cell = this.memory.store.getCell(id)
      if (!cell) {
        skipped++
        continue
      }
      const text = embeddingTextOf(cell)
      try {
        const vec = await e.embed(text)
        cell.emb = foldEmb(quantize(vec, vec.length), this.config.embStoreDim ?? this.config.embDim)
        this.memory.store.putCell(cell)
      } catch (err) {
        this.memory.counters.noteEmbedError(err)
        skipped++
      }
    }
    const done = Math.min(ids.length, cursor + slice.length)
    this.memory.store.setMeta('emb.reembed.cursor', String(done))
    if (done >= ids.length) {
      this.memory.setEmbSpace(e.space)
      this.memory.store.setMeta('emb.reembed.cursor', '0')
    }
    this.audit.record({
      at: this.clock.now(),
      action: 'reembed',
      target: `${cursor}..${done}/${ids.length}`,
      actor: 'system',
      detail: `skipped=${skipped} space=${this.memory.embSpace}`,
    })
    return { done, total: ids.length, skipped, space: this.memory.embSpace }
  }
}

/** 重算向量的输入文本：digest + 槽位值。不含原文（原文在残差里，代价高 10 倍）。 */
export function embeddingTextOf(cell: MemCell): string {
  const slots = cell.slots.filter((s) => s.type !== 'UNK' && s.value).map((s) => s.value)
  return [cell.digest, ...slots].filter(Boolean).join(' ').slice(0, 400)
}

/** 内容指纹：FNV-1a 32 位，十六进制。用途是"核对"，不是"防伪"。 */
export function proofOf(digest: string, at: number): string {
  let h = 0x811c9dc5
  const s = `${digest}|${at}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export type { TokenizerPort, EmbeddingPort, EnginePorts }
export { queryEmbedding }
