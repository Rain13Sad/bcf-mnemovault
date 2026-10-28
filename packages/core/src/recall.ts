/**
 * 检索路径（对应 §9.1–§9.3 / §15.7）
 *
 * 四路并行召回 → 合并去重 → 归一化打分 → 4±1 槽位竞争 → 渲染。
 *
 * 三个必须守住的点：
 *   1. `sim` 用 containment 并做固定标定（§6.5）。尺寸悬殊时 Jaccard 上界只有 0.087，
 *      用它做检索会让完美匹配永远排不进槽位。
 *   2. 分数**按激活权重归一化**（§9.2，修 D-04）。七项权重之和约 2.5，用 0.45 做阈值
 *      等于没有阈值；归一化到 [0,1] 后 ignition=0.42 才有意义。
 *   3. 空槽合法。宁可只给 2 条也不凑满——直接省 token，也避免无关记忆污染上下文。
 */

import type { MemCell } from './cell.js'
import { FLAG, REL } from './cell.js'
import { retrievabilityFrom } from './forgetting.js'
import { estimateTokens, assignShortIds, renderAffectLine, renderSurface } from './render.js'
import type { SdrSpace, Sdr } from './sdr.js'
import type { Store } from './store.js'
import { extractEntities, parseTimeExpr } from './text.js'
import type {
  MnemoConfig,
  Pad,
  RecallChannel,
  RecallHit,
  RecallQuery,
  RecallResult,
  ScoreBreakdown,
  ScoreParts,
} from './types.js'

export const SIM_FLOOR = 0.09
const MAX_CANDIDATES = 200

export interface RecallDeps {
  space: SdrSpace
  store: Store
  config: MnemoConfig
  now?: number
  /** 工作记忆（§8.2）：本轮刚摸过的 cell 有启动效应加成 */
  working?: { activation(cellId: bigint): number }
  /** 当前作用域键（§14.10） */
  scopeKey?: string
}

interface Candidate {
  cell: MemCell
  channels: Set<RecallChannel>
  simSemantic: number
  simSymbolic: number
  simGraph: number
  simTemporal: number
  hop: number
  web: boolean
  /** 工作记忆里的激活度（0 = 本轮没碰过） */
  activation: number
}

/**
 * 本地哈希 embedding（§7.4 的降级路径）。
 * 文档要求"优先用宿主已配置的 embedding 能力；否则本地 bge-m3 量化版"。
 * 参考实现里两者都不可用时，用字符 n-gram 哈希到 int8 桶——它能提供**稳定的近似**，
 * 但必须诚实标注：这不是语义模型，同义改写召回明显弱于真 embedding。
 */
export function hashEmbedding(text: string, dim = 256): Int8Array {
  const out = new Int8Array(dim)
  const s = text.toLowerCase()
  const grams: string[] = []
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2))
  if (grams.length === 0) grams.push(s)
  for (const g of grams) {
    let h = 0x811c9dc5
    for (let i = 0; i < g.length; i++) h = Math.imul(h ^ g.charCodeAt(i), 0x01000193) >>> 0
    const bucket = h % dim
    const sign = (h >>> 31) & 1 ? -1 : 1
    out[bucket] = clampInt8(out[bucket] + sign * 3)
  }
  return out
}

function clampInt8(x: number): number {
  return Math.max(-127, Math.min(127, x))
}

export function cosine(a: Int8Array | null, b: Int8Array | null): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** 查询 SDR：实体身份码的并集 + 话题码。稀疏、可解释、跨进程稳定。 */
export function buildQuerySdr(space: SdrSpace, text: string, extraEntities: string[] = []): Sdr {
  const ents = [...extractEntities(text), ...extraEntities]
  const items: Sdr[] = ents.slice(0, 24).map((e) => space.identity('E:' + e))
  return space.bundle(items)
}

export function runRecall(deps: RecallDeps, q: RecallQuery): RecallResult {
  const t0 = Date.now()
  const { space, store, config } = deps
  const now = deps.now ?? t0
  const weights = config.recall

  const qSdr = buildQuerySdr(space, q.text, q.goal?.entities ?? [])
  const qEmb = hashEmbedding(q.text, config.embDim)
  const timeRange = q.timeRange ?? parseTimeExpr(q.text, now)
  const goalSdr = q.goal ? buildQuerySdr(space, q.goal.sdrText) : undefined
  const mood: Pad = q.pad ?? { v: 0, a: 0, d: 0, s: 0 }

  // ── 候选收集：四路并行（这里串行执行，但每路独立，语义与并行一致） ──
  // 双时态可见性：默认只看"现在仍然为真"的版本；给 asOf 就按当时的口径看。
  const scopeKey = q.scopeKey ?? deps.scopeKey ?? 'user:local'
  const visible = (cell: MemCell): boolean => {
    // 视角过滤：'想听事实' 与 '想聊感受' 是两种不同的检索意图
    if (q.lens && (cell.lens ?? 'fact') !== q.lens) return false
    // 作用域隔离（§14.10 / §19.2）：情景记忆默认不跨会话，语义/图式全局共享。
    // 这是"A 用户的事被 B 用户问出来"这条事故的唯一防线。
    if (q.scope !== 'global') {
      const cellScope = cell.scope ?? 'user:local'
      if (cellScope !== 'global' && cellScope !== scopeKey) return false
      if (cell.kind === 0 && q.sessionId && cell.session && cell.session !== q.sessionId) return false
    }
    const invalidAt = Number(cell.tInvalid ?? 0)
    if (q.asOf !== undefined) {
      if (Number(cell.tFrom) > q.asOf) return false
      return invalidAt === 0 || invalidAt > q.asOf
    }
    if (q.includeInvalidated) return true
    return invalidAt === 0
  }

  const cands = new Map<string, Candidate>()
  const key = (id: bigint) => id.toString(16).padStart(16, '0')
  const touch = (cell: MemCell): Candidate => {
    const k = key(cell.cellId)
    let c = cands.get(k)
    if (!c) {
      c = {
        cell,
        channels: new Set(),
        simSemantic: 0,
        simSymbolic: 0,
        simGraph: 0,
        simTemporal: 0,
        hop: 99,
        web: (cell.flags & FLAG.web) !== 0,
        activation: deps.working?.activation(cell.cellId) ?? 0,
      }
      cands.set(k, c)
    }
    return c
  }

  // Q1 语义路：精确余弦扫描。HNSW 是生产规模下的加速，不是语义差异；
  // 参考实现在 10 万 cell 以内用全扫更快且结果确定（无近似误差）。
  const semScored: Array<{ c: MemCell; s: number }> = []
  store.forEachCell((cell) => {
    if (q.kinds && !q.kinds.includes(cell.kind)) return
    if (!visible(cell)) return
    const s = cosine(qEmb, cell.emb)
    if (s > 0.12) semScored.push({ c: cell, s })
  })
  semScored.sort((a, b) => b.s - a.s || Number(a.c.cellId - b.c.cellId))
  const semTop = semScored.slice(0, Math.max(8, weights.annTopK))
  const semNorm = normalizeMax(semTop.map((x) => x.s))
  semTop.forEach((x, i) => {
    const cand = touch(x.c)
    cand.channels.add('semantic')
    cand.simSemantic = Math.max(cand.simSemantic, semNorm[i])
  })

  // Q2 符号路：query 的 SDR containment（精确事实类查询的主通道）
  store.forEachCell((cell) => {
    if (q.kinds && !q.kinds.includes(cell.kind)) return
    if (!visible(cell)) return
    const c = space.simNorm(qSdr, cell.sdr)
    if (c > 0.05) {
      const cand = touch(cell)
      cand.channels.add('symbolic')
      cand.simSymbolic = Math.max(cand.simSymbolic, c)
    }
  })

  // Q3 图路：以 Q1/Q2 的 top 8 为种子，k 跳加权扩散
  const seeds = [...cands.values()]
    .sort((a, b) => Math.max(b.simSemantic, b.simSymbolic) - Math.max(a.simSemantic, a.simSymbolic))
    .slice(0, 8)
  const hops = Math.max(1, weights.graphHops)
  let frontier = seeds.map((s) => ({ id: s.cell.cellId, w: 1, hop: 0 }))
  const seen = new Set(frontier.map((f) => f.id.toString(16)))
  for (let hop = 1; hop <= hops; hop++) {
    const next: Array<{ id: bigint; w: number; hop: number }> = []
    for (const f of frontier) {
      for (const e of store.edgesFrom(f.id)) {
        const idk = e.dst.toString(16)
        if (seen.has(idk)) continue
        seen.add(idk)
        const w = f.w * Math.pow(weights.graphDecay, hop) * (Math.max(1, e.weight) / 64)
        next.push({ id: e.dst, w, hop })
      }
    }
    for (const n of next) {
      const cell = store.getCell(n.id)
      if (!cell) continue
      if (q.kinds && !q.kinds.includes(cell.kind)) continue
      if (!visible(cell)) continue
      const cand = touch(cell)
      cand.channels.add('graph')
      if (n.hop < cand.hop) cand.hop = n.hop
      cand.simGraph = Math.max(cand.simGraph, 1 / (1 + n.hop) * Math.min(1, n.w))
    }
    frontier = next
    if (frontier.length === 0) break
  }

  // Q4 时间路：query 含时间表达式时按区间重叠
  if (timeRange) {
    const span = Math.max(1, timeRange.to - timeRange.from)
    store.forEachCell((cell) => {
      if (!visible(cell)) return
      const tf = Number(cell.tFrom)
      if (tf < timeRange.from - span || tf > timeRange.to + span) return
      const overlap = Math.max(0, Math.min(tf + 1, timeRange.to) - Math.max(tf, timeRange.from)) / span
      const near = 1 - Math.min(1, Math.abs(tf - (timeRange.from + span / 2)) / (span * 2))
      const s = Math.max(overlap, near * 0.6)
      if (s <= 0.05) return
      const cand = touch(cell)
      cand.channels.add('temporal')
      cand.simTemporal = Math.max(cand.simTemporal, s)
    })
  }

  // 候选池截断（§9.1：≤200）
  let pool = [...cands.values()]
  if (pool.length > MAX_CANDIDATES) {
    pool.sort((a, b) => peakSim(b) - peakSim(a))
    pool = pool.slice(0, MAX_CANDIDATES)
  }

  // ── 打分（不含 interference；interference 依赖"已入选"集合） ──
  const base = pool.map((c) => ({ cand: c, parts: scoreCandidate(c, { q, mood, goalSdr, now, config }) }))
  base.sort((a, b) => b.parts.score - a.parts.score || Number(a.cand.cell.cellId - b.cand.cell.cellId))

  // ── 4±1 槽位竞争（§9.3） ──
  const selected: Array<{ cand: Candidate; breakdown: ScoreBreakdown }> = []
  const slots: Array<{ count: number; capacity: number }> = Array.from({ length: config.maxSlots }, () => ({ count: 0, capacity: 1 }))
  let entries = 0

  for (const b of base) {
    if (entries >= config.maxEntriesPerTurn) break
    // 网络来源默认拒绝进槽位（§19.1 隔离，V-05）
    if (b.cand.web && !q.manual) continue

    // 冗余惩罚：与已入选槽位的最大 Jaccard（对称比较用 Jaccard，§6.5）
    let interf = 0
    let worst: MemCell | undefined
    for (const s of selected) {
      const j = space.sim(b.cand.cell.sdr, s.cand.cell.sdr)
      if (j > interf) {
        interf = j
        worst = s.cand.cell
      }
    }
    const withInterf = scoreCandidate(b.cand, { q, mood, goalSdr, now, config }, interf)

    // 空槽合法：低于 ignition 就不注入，宁可少给
    if (!q.manual && withInterf.score < weights.ignition) continue

    // 选槽：优先有剩余容量的最低编号槽
    let slotIdx = -1
    for (let i = 0; i < slots.length; i++) {
      if (slots[i].count < slots[i].capacity) {
        slotIdx = i
        break
      }
    }
    if (slotIdx < 0) continue
    const slot = slots[slotIdx]
    if (slot.count === 0) slot.capacity = Math.min(3, Math.max(1, 1 + Math.floor(withInterf.score * 2)))

    slot.count++
    entries++
    withInterf.slot = slotIdx
    withInterf.notes = []
    if (worst) withInterf.notes.push(`与 ${worst.cellId.toString(16).slice(-4)} 冗余 ${interf.toFixed(2)}`)
    if (b.cand.web) withInterf.notes.push('网络来源，默认隔离')
    selected.push({ cand: b.cand, breakdown: withInterf })
  }

  // 槽内按分数降序，槽间按槽号（渲染顺序稳定）
  selected.sort((a, b) => a.breakdown.slot - b.breakdown.slot || b.breakdown.score - a.breakdown.score)

  const picked = selected.map((s) => s.cand.cell)
  const shortIds = assignShortIds(picked.map((cell) => ({ cell })))
  const includeLegend = !q.manual
  const affectLine = q.pad
    ? renderAffectLine(mood, q.relational?.trust ?? 0, q.relational?.familiarity ?? 0, { verbosity: 0, temperatureDelta: 0, clarification: 0 })
    : undefined

  const rendered = renderSurface({
    cells: picked.map((cell, i) => ({ cell, shortId: shortIds[i] })),
    mode: config.surfaceMode,
    includeLegend,
    maxTokens: q.budget || config.maxSurfaceTokens,
    affectLine: includeLegend ? affectLine : undefined,
  })

  const hits: RecallHit[] = selected.map((s, i) => ({
    cellId: s.cand.cell.cellId.toString(16).padStart(16, '0'),
    shortId: shortIds[i],
    score: s.breakdown.score,
    slot: s.breakdown.slot,
    channel: dominantChannel(s.cand),
  }))

  const strategy = dominantStrategy(selected.map((s) => s.cand))

  return {
    queryId: q.queryId ?? `q${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    strategy,
    hits,
    rendered: rendered.text,
    tokens: rendered.tokens,
    surfaceMode: config.surfaceMode,
    snapshotId: '',
    breakdowns: selected.map((s) => s.breakdown),
    candidates: pool.length,
    elapsedMs: Date.now() - t0,
    slotsUsed: slots.filter((s) => s.count > 0).length,
    emptySlots: slots.filter((s) => s.count === 0).length,
  }
}

interface ScoreCtx {
  q: RecallQuery
  mood: Pad
  goalSdr?: Sdr
  now: number
  config: MnemoConfig
}

/**
 * 归一化打分（§9.2）。`Σ_active_weights` 只累加当前可用的项，
 * 因此"无 goal 时不计 w_goal"，不同上下文下的分数仍可比。
 */
export function scoreCandidate(cand: Candidate, ctx: ScoreCtx, interference = 0): ScoreBreakdown {
  const w = ctx.config.recall
  const cell = cand.cell
  const sim = Math.max(cand.simSemantic, cand.simSymbolic, cand.simGraph, cand.simTemporal)
  const recency = retrievabilityFrom(Number(cell.tAccess), cell.stability, ctx.now)
  // 复述强化与启动效应取较大者：前者是长期统计，后者是"这轮刚摸过"
  const freqLong = Math.min(1, Math.log1p(cell.accessCount) / Math.log1p(100))
  const freq = Math.max(freqLong, Math.min(1, (cand.activation ?? 0) * 0.85))
  const moodW = clamp01((ctx.mood.v + 0.5) / 0.5)
  const congruence = 1 - Math.abs(cell.valence - ctx.mood.v) / 2
  const goalRel = ctx.goalSdr ? goalRelOf(cand, ctx) : 0
  const cue = cueMatchOf(cell, ctx.q.topic)

  const rawParts: Record<keyof ScoreParts, number> = {
    sim,
    recency,
    freq,
    affect: moodW * congruence,
    goal: goalRel,
    cue,
    interf: interference,
  }
  const weights: Record<keyof ScoreParts, number> = {
    sim: w.wSim,
    recency: w.wRecency,
    freq: w.wFreq,
    affect: w.wAffect * moodW,
    goal: ctx.goalSdr ? w.wGoal : 0,
    cue: w.wCue,
    interf: w.wInterf,
  }
  const parts: ScoreParts = {
    sim: weights.sim * rawParts.sim,
    recency: weights.recency * rawParts.recency,
    freq: weights.freq * rawParts.freq,
    affect: weights.affect * rawParts.affect,
    goal: weights.goal * rawParts.goal,
    cue: weights.cue * rawParts.cue,
    interf: -weights.interf * rawParts.interf,
  }
  const activeW =
    weights.sim + weights.recency + weights.freq + weights.affect + weights.goal + weights.cue + weights.interf
  const rawSum = parts.sim + parts.recency + parts.freq + parts.affect + parts.goal + parts.cue + parts.interf
  return {
    cellId: cell.cellId.toString(16).padStart(16, '0'),
    parts,
    raw: rawParts,
    weights,
    rawSum,
    activeW,
    score: activeW === 0 ? 0 : clamp01(rawSum / activeW),
    slot: -1,
    channel: dominantChannel(cand),
    notes: [],
  }
}

function goalRelOf(cand: Candidate, ctx: ScoreCtx): number {
  if (!ctx.goalSdr) return 0
  // 查询 SDR 与 cell SDR 的重叠已由 symbolic 路算过；这里用 goal 实体交集补强
  const ents = ctx.q.goal?.entities ?? []
  if (ents.length === 0) return 0
  const text = cand.cell.slots.map((s) => s.value).join(' ')
  let hit = 0
  for (const e of ents) if (e && text.toLowerCase().includes(e.toLowerCase())) hit++
  return Math.min(1, hit / ents.length)
}

function cueMatchOf(cell: MemCell, topic?: string): number {
  if (!topic) return 0.3
  if (!cell.topic) return 0.2
  if (cell.topic === topic) return 1
  const a = new Set(cell.topic.split('-'))
  const b = new Set(topic.split('-'))
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter === 0 ? 0 : Math.min(0.9, inter / Math.max(a.size, b.size))
}

function peakSim(c: Candidate): number {
  return Math.max(c.simSemantic, c.simSymbolic, c.simGraph, c.simTemporal)
}

export function dominantChannel(c: Candidate): RecallChannel | 'mixed' {
  if (c.channels.size > 1) {
    const arr = [...c.channels]
    const best = arr.reduce((a, b) => (simOf(c, b) > simOf(c, a) ? b : a))
    const second = arr.filter((x) => x !== best).reduce((a, b) => (simOf(c, b) > simOf(c, a) ? b : a), arr[0])
    if (Math.abs(simOf(c, best) - simOf(c, second)) < 0.05) return 'mixed'
    return best
  }
  return [...c.channels][0] ?? 'semantic'
}

function simOf(c: Candidate, ch: RecallChannel): number {
  switch (ch) {
    case 'semantic':
      return c.simSemantic
    case 'symbolic':
      return c.simSymbolic
    case 'graph':
      return c.simGraph
    case 'temporal':
      return c.simTemporal
  }
}

function dominantStrategy(cands: Candidate[]): RecallResult['strategy'] {
  const counts = new Map<string, number>()
  for (const c of cands) {
    const ch = dominantChannel(c)
    counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  if (counts.size === 0) return 'mixed'
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return best as RecallResult['strategy']
}

function normalizeMax(xs: number[]): number[] {
  const max = Math.max(...xs, 1e-6)
  return xs.map((x) => clamp01(x / max))
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

/** 解释器输出（§12.5）。与打分共用同一份 breakdown，避免"显示的和算的不一致"。 */
export function formatBreakdown(b: ScoreBreakdown, threshold: number): string {
  const label: Record<keyof ScoreParts, string> = {
    sim: 'sim     ',
    recency: 'recency ',
    freq: 'freq    ',
    affect: 'affect  ',
    goal: 'goal    ',
    cue: 'cue     ',
    interf: 'interf  ',
  }
  const lines = (Object.keys(b.parts) as Array<keyof ScoreParts>).map((k) => {
    const raw = b.raw[k]
    const w = b.weights[k]
    const contrib = b.parts[k]
    const sign = k === 'interf' ? '' : ' '
    return `  ${label[k]} ${raw.toFixed(2)} × ${w.toFixed(2)} = ${sign}${contrib.toFixed(2)}`
  })
  return [
    `cell ${b.cellId.slice(-4)}  总分 ${b.score.toFixed(2)}（阈值 ${threshold.toFixed(2)}，槽位 ${b.slot + 1}）`,
    ...lines,
    '  ─────────────────────────────',
    `  raw ${b.rawSum.toFixed(2)} / Σw ${b.activeW.toFixed(2)} = ${b.score.toFixed(2)}`,
    ...b.notes.map((n) => `  · ${n}`),
  ].join('\n')
}

export { estimateTokens }
