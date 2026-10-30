/**
 * @rain13sad/dsh-mnemo-consolidator —— 离线巩固（§10）
 *
 * 在线编码只能做局部决策；全局决策（哪些该抽象、哪些降权、哪些被取代）必须离线。
 * 三个相位：NREM（抽象合并）、REM（发散 + 情绪衰减）、主动遗忘（按比例降权 + 弱边剪除）。
 *
 * 锁写在存储而不是内存里，否则崩溃后无法判断上次 pass 是否完成（§10.2）。
 * 幂等：passId = hash(sessionId‖startSeq)，重复执行同一 passId 不产生新边。
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import {
  FLAG,
  KIND,
  REL,
  RETENTION_WEIGHTS,
  cellIdFor,
  evaluateRetention,
  slotValue,
  type MemCell,
  type MemoryService,
  type PresetName,
} from '@rain13sad/dsh-mnemo-core'

export const name = 'mnemo-consolidator'
export const inject = ['memory', 'sessions']

export interface Config {
  enabled: boolean
  /** 按比例降权系数 γ（§10.5）。保留相对排序，只压刻度 */
  gamma: number
  /** 弱边剪除阈值（i8 尺度） */
  pruneBelow: number
  /** 弱边未共激活天数 */
  pruneAfterDays: number
  /** REM 温度：越大越发散 */
  divergenceTemp: number
  /** 每个 pass 最多处理多少 seed */
  maxSeeds: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true).description('关闭后只做降层，不做抽象与发散'),
  gamma: z.number().min(0.9).max(0.99).default(0.95).description('按比例降权系数。按比例而非绝对值，保证相对强弱结构不变'),
  pruneBelow: z.number().min(0).max(32).default(8).description('弱边剪除阈值'),
  pruneAfterDays: z.number().min(30).max(365).default(90).description('弱边剪除的未共激活天数'),
  divergenceTemp: z.number().min(0.1).max(2).default(0.7).description('REM 发散温度'),
  maxSeeds: z.number().min(8).max(200).default(60).description('每个 pass 的 seed 上限'),
})

export interface PassResult {
  passId: string
  merged: number
  linked: number
  revalenced: number
  pruned: number
  downscaled: number
  /** 本轮新生成/更新的叙事节点数 */
  narrated: number
  /** v0.5：睡眠期重放救回的记忆数 */
  replayed: number
}

/** 确定性伪随机：同一 key 永远得到同一 (0,1) 值。 */
function unitHash(key: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x2545f491) >>> 0
  h ^= h >>> 13
  return h / 4294967296
}

export function derivePassId(sessionId: string, seq: number): string {
  let h = 0x811c9dc5
  const s = `${sessionId}|${seq}`
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

export class Consolidator {
  constructor(
    private readonly memory: MemoryService,
    private readonly config: Config,
  ) {}

  /** 触发判定（§10.2）。 */
  passDue(state: { turnsSinceLastPass: number; cellsSinceLastPass: number; idleMs?: number; dirty?: boolean }): boolean {
    const c = this.memory.config.consolidation
    if (state.turnsSinceLastPass >= c.everyTurns) return true
    if (state.cellsSinceLastPass >= c.everyCells) return true
    if ((state.idleMs ?? 0) >= c.idleMs && state.dirty) return true
    return false
  }

  /** 一次完整 pass。整个 pass 一个事务（§8.5），失败时不写 end，留下可检测的锁。 */
  run(passId: string): PassResult {
    const mem = this.memory
    const open = mem.store.meta('consolidate:open')
    if (open) throw new Error(`存在未完成的巩固锁 ${open}，先 /mnemo doctor --unlock`)

    const t0 = Date.now()
    mem.store.setMeta('consolidate:open', passId)
    mem.emit('memory/consolidate/start', { passId, phase: 'nrem' })
    try {
      const result = mem.store.write(() => {
        const nrem = this.runNrem(passId)
        const rem = this.runRem(passId)
        const story = this.runNarrative(passId)
        // 重放放在遗忘**之前**：先按保留度把"重要但很久没提"的记忆加固一级，
        // 再跑降权与降档。顺序反了就成了"先打下去再捞上来"，等于白做。
        const replay = this.runReplay()
        const forget = this.runForget()
        return {
          passId,
          merged: nrem.merged,
          linked: nrem.linked + rem.linked,
          revalenced: rem.revalenced,
          pruned: forget.pruned,
          narrated: story.narrated,
          downscaled: forget.downscaled,
          replayed: replay.replayed,
        }
      })
      mem.emit('memory/consolidate', {
        passId,
        phase: 'nrem',
        merged: result.merged,
        linked: result.linked,
        revalenced: result.revalenced,
        pruned: result.pruned,
      })
      mem.emit('memory/consolidate/end', { passId, ok: true })
      mem.store.setMeta('consolidate:open', '')
      // 把结果回填给面板：`记忆整理` 页要显示"最近一次整理做了什么"，
      // 否则用户只能看到"还没有跑过"，明明刚跑过。
      mem.noteConsolidation({
        merged: result.merged,
        abstracted: result.narrated,
        pruned: result.pruned,
        decayed: result.revalenced,
        elapsedMs: Date.now() - t0,
      })
      return result
    } catch (err) {
      // 不写 end：留下可检测的遗留锁，阻塞后续 pass（§15.8 的理由）
      mem.error(`consolidate ${passId} failed: ${String(err)}`)
      throw err
    }
  }

  /** NREM：重放高频 cell，抽 schema，N 个情景 cell 合 1 个语义 cell（§10.3）。 */
  private runNrem(passId: string): Pick<PassResult, 'merged' | 'linked'> {
    const mem = this.memory
    const minSupport = mem.config.consolidation.schemaMinSupport
    const groups = new Map<string, MemCell[]>()

    mem.store.forEachCell((c) => {
      if (c.tier === 3) return
      if (c.flags & FLAG.noDecay) return
      if (c.accessCount < 2) return
      const key = `${c.kind}|${slotValue(c, 'AGENT') ?? ''}|${slotValue(c, 'PRED') ?? ''}`
      const arr = groups.get(key) ?? []
      arr.push(c)
      groups.set(key, arr)
    })

    let merged = 0
    let linked = 0
    for (const [, cells] of groups) {
      if (cells.length < minSupport) continue
      // 槽位高度重合才抽象：用两两 Jaccard 的中位数做判据
      const pairs: number[] = []
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) pairs.push(mem.space.sim(cells[i].sdr, cells[j].sdr))
      }
      pairs.sort((a, b) => a - b)
      const median = pairs[Math.floor(pairs.length / 2)] ?? 0
      if (median < 0.35) continue

      const base = cells[0]
      const slots = modeSlots(cells)
      const support = cells.reduce((n, c) => n + c.support, 0)
      const shortest = cells.slice().sort((a, b) => (a.residual?.rawLen ?? 1e9) - (b.residual?.rawLen ?? 1e9))[0]
      const sdr = mem.space.bundle(slots.filter((s) => s.type !== 'UNK').map((s) => mem.space.bind(mem.space.identity('V:' + s.value.toLowerCase()), mem.space.role(String(s.role)))))
      const cellId = cellIdFor('nrem:' + passId, [cells.length], sdr)
      if (mem.store.getCell(cellId)) continue // 幂等：同一 passId 不重复产生

      const now = Date.now()
      const schemaCell: MemCell = {
        cellId,
        kind: KIND.schema,
        tier: 1,
        flags: FLAG.noDecay & 0,
        tFrom: BigInt(Math.min(...cells.map((c) => Number(c.tFrom)))),
        tTo: BigInt(Math.max(...cells.map((c) => Number(c.tTo)))),
        tIngest: BigInt(now),
        tAccess: BigInt(now),
        accessCount: 0,
        stability: Math.max(...cells.map((c) => c.stability)) * 1.2,
        importance: Math.max(...cells.map((c) => c.importance)),
        valence: avg(cells.map((c) => c.valence)),
        arousal: avg(cells.map((c) => c.arousal)),
        dominance: avg(cells.map((c) => c.dominance)),
        salience: Math.max(...cells.map((c) => c.salience)),
        provenance: 4,
        trust: 160,
        sdr,
        emb: base.emb,
        slots,
        edges: cells.slice(0, 12).map((c) => ({ targetPrefix: Number(c.cellId & 0xffffffffn), dst: c.cellId, rel: REL.PART_OF, weight: 64 })),
        residual: shortest.residual,
        confidence: avg(cells.map((c) => c.confidence)),
        support,
        topic: base.topic,
        digest: `抽象：${slotValue(base, 'AGENT') ?? ''} ${slotValue(base, 'PRED') ?? ''} ×${cells.length}`,
      }
      mem.store.putCell(schemaCell)
      for (const c of cells) {
        mem.store.putEdge({ src: c.cellId, dst: cellId, rel: REL.PART_OF, weight: 64 })
        linked++
      }
      merged++
    }
    return { merged, linked }
  }

  /** REM：反事实重组生成联想边 + 情景 cell 情绪衰减（§10.4）。只动情感维度，不动内容维度。 */
  private runRem(passId: string): Pick<PassResult, 'linked' | 'revalenced'> {
    const mem = this.memory
    const budget = mem.config.consolidation.remLinkBudget
    const decayV = mem.config.consolidation.remValenceDecay
    const decayA = mem.config.consolidation.remArousalDecay
    let linked = 0
    let revalenced = 0

    const hot: MemCell[] = []
    mem.store.forEachCell((c) => {
      if (c.tier <= 1 && c.accessCount >= 2) hot.push(c)
    })
    hot.sort((a, b) => b.accessCount - a.accessCount)
    const seeds = hot.slice(0, this.config.maxSeeds)

    for (const seed of seeds) {
      if (linked >= budget) break
      for (const e of mem.store.edgesFrom(seed.cellId)) {
        const target = mem.store.getCell(e.dst)
        if (!target) continue
        // 语义相似但情感效价相反 —— 最有价值的一类配对（"用户前后矛盾"/"被忽略的替代方案"）
        const j = mem.space.sim(seed.sdr, target.sdr)
        if (j > 0.3 && seed.valence * target.valence < -0.05) {
          const exists = mem.store.edgesFrom(seed.cellId).some((x) => x.dst === target.cellId && x.rel === REL.CONTRADICTS)
          if (!exists) {
            mem.store.putEdge({ src: seed.cellId, dst: target.cellId, rel: REL.CONTRADICTS, weight: 64 })
            linked++
          }
        }
        // 弱关联：按温度采样，控制总量。
        // 采样必须**确定性**：用 (passId, seed, target) 的哈希代替 Math.random，
        // 否则同一段日志跑两遍 rebuild 会得到不同的联想边集合——
        // 而"重放可复现"是这个项目对文本摘要方案的核心差异化承诺。
        const p = 1 / (1 + Math.exp(-(j - 0.15) / this.config.divergenceTemp))
        if (unitHash(`${passId}|${seed.cellId}|${target.cellId}`) < p && linked < budget) {
          const exists = mem.store.edgesFrom(seed.cellId).some((x) => x.dst === target.cellId && x.rel === REL.ASSOC)
          if (!exists) {
            mem.store.putEdge({ src: seed.cellId, dst: target.cellId, rel: REL.ASSOC, weight: 38 })
            linked++
          }
        }
      }
    }

    // 情绪衰减：人格锚（bit1）与情感记忆（bit6）都不参与。
    // 情感记忆不衰减是本项目对"陪伴"场景的明确承诺：吵架那天的原话、
    // 第一次说谢谢的那句，不该因为过了三个月就变成中性。
    mem.store.forEachCell((c) => {
      if (c.kind !== KIND.episodic && c.kind !== KIND.schema) return
      if (c.flags & FLAG.noDecay) return
      if (c.flags & FLAG.emotional) return
      c.valence *= decayV
      c.arousal *= decayA
      c.salience *= 0.96
      if (Math.abs(c.valence) < 0.05) c.valence = 0
      mem.store.putCell(c)
      revalenced++
    })
    void passId
    return { linked, revalenced }
  }

  /**
   * 叙事层（`kind=6`）：把一段时间里的情感事件串成"我们之间发生过什么"。
   *
   * 为什么单独一层：事实记忆回答"用户喜欢什么"，叙事记忆回答"我们是什么关系"。
   * 陪伴场景里后者才是用户真正在意的——但把它做成散文段落会立刻违反"不存散文"的约束，
   * 所以这里存的是**结构化叙事**：阶段 + 主题 + 事件引用 + 一行 digest。
   *
   * 只吸收情感记忆（bit6）与里程碑，不吸收普通事实——否则每条偏好都会变成"故事"。
   */
  private runNarrative(passId: string): { narrated: number } {
    const mem = this.memory
    const now = Date.now()
    const since = Number(mem.store.meta('narrative:since') ?? 0)

    const events: MemCell[] = []
    mem.store.forEachCell((c) => {
      if (c.kind === KIND.narrative) return
      if (Number(c.tFrom) < since) return
      const charged = (c.flags & FLAG.emotional) !== 0 || (c.flags & FLAG.milestone) !== 0
      if (!charged) return
      if (Number(c.tInvalid ?? 0) !== 0) return
      events.push(c)
    })
    if (events.length < 3) return { narrated: 0 }

    // 取情感强度最高的几条做锚点
    events.sort((a, b) => Math.abs(b.valence) * b.salience - Math.abs(a.valence) * a.salience)
    const anchors = events.slice(0, 5)
    const positive = anchors.filter((c) => c.valence > 0).length
    const phase = positive >= anchors.length * 0.6 ? '亲近期' : positive <= anchors.length * 0.3 ? '摩擦期' : '磨合期'
    // 主题取"锚点里最常见的槽位值"（话题/客体），而不是 topic 指纹——
    // 指纹是 '我喜欢把日志放在-stderr-stdout' 这种切碎的串，直接当主题很难看。
    const words = anchors.flatMap((c) => c.slots.filter((x) => x.type === 'LIT' && (x.role === 6 || x.role === 2)).map((x) => x.value))
    const theme = words.sort((a, b) => words.filter((x) => x === b).length - words.filter((x) => x === a).length)[0] ?? '日常'
    const days = Math.max(1, Math.round((now - Number(anchors[anchors.length - 1].tFrom)) / 86_400_000))
    const digest = `${phase}：${days} 天内 ${anchors.length} 件有情绪的事，主题偏「${theme}」`

    const slots: MemCell['slots'] = [
      { role: 1, type: 'LIT', value: '我们' },
      { role: 3, type: 'LIT', value: 'narrative' },
      { role: 2, type: 'LIT', value: theme.slice(0, 24) },
      { role: 6, type: 'LIT', value: phase },
      { role: 8, type: 'LIT', value: String(anchors.length) },
    ]
    const sdr = mem.space.bundle(
      slots.map((x) => mem.space.bind(mem.space.identity('V:' + x.value.toLowerCase()), mem.space.role(String(x.role)))),
    )
    const cellId = cellIdFor('narrative:' + passId, [anchors.length], sdr)
    if (mem.store.getCell(cellId)) return { narrated: 0 }

    const cell: MemCell = {
      cellId,
      kind: KIND.narrative as MemCell['kind'],
      tier: 1,
      flags: FLAG.noDecay | (anchors.length >= 4 ? FLAG.milestone : 0),
      tFrom: BigInt(anchors[anchors.length - 1].tFrom),
      tTo: BigInt(now),
      tIngest: BigInt(now),
      tAccess: BigInt(now),
      accessCount: 0,
      stability: 365,
      importance: 0.85,
      valence: avg(anchors.map((c) => c.valence)),
      arousal: avg(anchors.map((c) => c.arousal)),
      dominance: 0.5,
      salience: Math.max(...anchors.map((c) => c.salience)),
      provenance: 4,
      trust: 160,
      sdr,
      emb: null,
      slots,
      edges: anchors.map((c) => ({ targetPrefix: Number(c.cellId & 0xffffffffn), dst: c.cellId, rel: REL.EVIDENCE, weight: 72 })),
      residual: null,
      confidence: 0.7,
      support: anchors.length,
      topic: 'narrative',
      digest,
      lens: 'story',
      scope: mem.scopeKey,
    }
    mem.store.putCell(cell)
    for (const a of anchors) {
      mem.store.putEdge({ src: cell.cellId, dst: a.cellId, rel: REL.EVIDENCE, weight: 72 })
      // 反向也连：从"那天的事"应该能想到"我们那段日子"（联想是双向的）
      mem.store.putEdge({ src: a.cellId, dst: cell.cellId, rel: REL.EVOKES, weight: 64 })
    }
    mem.store.setMeta('narrative:since', String(now))
    return { narrated: 1 }
  }

  /** 主动遗忘（§10.5）：按比例降权 + 弱边剪除。**不删 cell**。 */
  /**
   * 睡眠期选择性重放（v0.5，补 v0.4 方案 M2 未完成的一项）。
   *
   * ── 它解决什么问题 ────────────────────────────────────────────
   * v0.5 的降档终于会出手了，但"出手"不能只有单向：一条**重要**的记忆如果
   * 三个月没被提起，会被陈旧包络一路压到归档层，然后再也回不来。
   * 真实的睡眠不是只做遗忘——SWR（尖波涟漪）会按"显著度"挑选要重放的内容，
   * 把重要的旧记忆重新加固。这里就是那个选择器。
   *
   * ── 判据 ──────────────────────────────────────────────────────
   * 30 天以上没被访问、已经掉到 tier ≥ 2、保留度仍 ≥ 0.45 的记忆，往上抬一级（最高到温层）。
   * 抬一级而不是直接回热层：一次重放不足以让它重新变成"常用"，只是别让它滑进墓碑。
   *
   * 预算：最多 20 条 / 或候选的 5%，取分数最高的那批——重放是稀缺资源。
   */
  private runReplay(): { replayed: number } {
    const mem = this.memory
    const now = mem.nowMs()
    const preset = (mem.config.preset === 'custom' ? 'balanced' : mem.config.preset) as PresetName
    const weights = RETENTION_WEIGHTS[preset]
    const cands: Array<{ cell: MemCell; score: number }> = []
    mem.store.forEachCell((c) => {
      if (c.tier < 2 || c.tier >= 4) return
      if (now - Number(c.tAccess) < 30 * 86_400_000) return
      const r = evaluateRetention(c, { nowMs: now, weights })
      if (r.score >= 0.45) cands.push({ cell: c, score: r.score })
    })
    if (cands.length === 0) return { replayed: 0 }
    cands.sort((a, b) => b.score - a.score || Number(a.cell.tAccess) - Number(b.cell.tAccess))
    const budget = Math.min(20, Math.max(1, Math.ceil(cands.length * 0.05)))
    let replayed = 0
    for (const { cell } of cands.slice(0, budget)) {
      cell.tier = (cell.tier - 1) as MemCell['tier']
      cell.stability = Math.min(3650, cell.stability * 1.05)
      mem.store.putCell(cell)
      replayed++
    }
    return { replayed }
  }

  private runForget(): Pick<PassResult, 'pruned' | 'downscaled'> {
    const mem = this.memory
    const now = Date.now()
    const cutoff = this.config.pruneAfterDays * 86_400_000
    let pruned = 0
    let downscaled = 0
    for (const e of mem.store.allEdges()) {
      const w = Math.round(e.weight * this.config.gamma)
      if (w < this.config.pruneBelow) {
        const src = mem.store.getCell(e.src)
        const stale = src ? now - Number(src.tAccess) > cutoff : true
        if (stale) {
          mem.store.deleteEdge(e.src, e.dst, e.rel)
          pruned++
          continue
        }
      }
      mem.store.setEdgeWeight(e.src, e.dst, e.rel, Math.max(1, w))
      downscaled++
    }
    return { pruned, downscaled }
  }
}

function modeSlots(cells: MemCell[]): MemCell['slots'] {
  const byRole = new Map<number, Map<string, number>>()
  for (const c of cells) {
    for (const s of c.slots) {
      if (s.type === 'UNK') continue
      const m = byRole.get(s.role) ?? new Map<string, number>()
      m.set(s.value, (m.get(s.value) ?? 0) + 1)
      byRole.set(s.role, m)
    }
  }
  const out: MemCell['slots'] = []
  for (const [role, counts] of byRole) {
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const [value, n] = sorted[0]
    // 众数不占多数 → 该槽降为 UNK 并标记争议（§10.3）
    if (n * 2 < cells.length) out.push({ role, type: 'UNK', value: '' })
    else out.push({ role, type: 'LIT', value })
  }
  return out
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
}

export function apply(ctx: Context, config: Config) {
  const memory = ctx.get('memory') as MemoryService | undefined
  if (!memory) throw new Error('[mnemo-consolidator] 需要 ctx.memory')
  const consolidator = new Consolidator(memory, config)
  // 注册成服务，devkit / tools / 面板都能拿到同一个实例（而不是各 new 一个）
  ;(ctx as unknown as { provide(n: string, v: unknown): unknown }).provide?.('mnemoConsolidator', consolidator)
  let lastPassTurn = 0
  let lastPassCells = 0

  ctx.effect(() => {
    const off = ctx.on('agent/turn-stopping', async () => {
      const turns = memory.turnCount
      const due = consolidator.passDue({
        turnsSinceLastPass: turns - lastPassTurn,
        cellsSinceLastPass: memory.store.countCells() - lastPassCells,
        idleMs: 0,
        dirty: true,
      })
      if (!config.enabled || !due) return
      const passId = derivePassId('session', turns)
      try {
        consolidator.run(passId)
        lastPassTurn = turns
        lastPassCells = memory.store.countCells()
      } catch {
        // 失败留锁，等待 doctor --unlock；不阻断本轮
      }
    })
    return () => off()
  }, 'mnemo-consolidator: turn-stopping')

  // 空闲触发：低频轮询，避免每轮都算
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!config.enabled) return
      const turns = memory.turnCount
      if (turns - lastPassTurn >= memory.config.consolidation.everyTurns) {
        try {
          consolidator.run(derivePassId('idle', turns))
          lastPassTurn = turns
          lastPassCells = memory.store.countCells()
        } catch {
          /* 锁冲突时跳过 */
        }
      }
    }, 90_000)
    return () => clearInterval(timer)
  }, 'mnemo-consolidator: idle timer')

  ctx.logger('mnemo-consolidator').info(`consolidator ready (gamma=${config.gamma})`)
  return consolidator
}

export { Consolidator as MnemoConsolidator }
