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
import { FLAG, REL, foldEmb } from './cell.js'
import { retrievabilityFrom } from './forgetting.js'
import { estimateTokens, assignShortIds, renderAffectLine, renderSurface } from './render.js'
import type { SdrSpace, Sdr } from './sdr.js'
import { snapshotIdOf, type Store } from './store.js'
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
  /**
   * 向量索引（§9.1 Q1）。给了就用它取候选，没给就精确扫描。
   * 是否真的走 ANN 由 config.recall.annEnabled + annThreshold 决定——
   * 小库上精确扫描更快且无误差，这个判断在 service 里做，不在这里。
   */
  ann?: { search(vec: Int8Array, k: number, ef?: number): Array<{ id: bigint; score: number }> }
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
 *
 * ── v2（v0.3）做了什么、没做什么 ──────────────────────────────────
 * 诚实地说：这仍然**不是语义模型**。它没有词向量、没有上下文、不知道"深色"和"暗色"
 * 在向量空间里近。任何声称它"接近 bge-m3"的说法都是假的。
 *
 * 但 v1 有两个可以修的缺陷，修完同义改写的召回明显好于字符 bigram 哈希：
 *   1. **只有字符 bigram**：中文里"主题"与"主题色"共享 bigram，但"深色/暗色"完全不共享。
 *      同义改写靠一张词表兜底，词表外的说法一律漏。v2 增加**词级 + 同义词族**两个通道，
 *      同义族里的词映射到同一个规范 token，于是"暗色""深色""dark"落在同一个桶上。
 *   2. **没有权重区分**：整句里"的""我们"和"pnpm"一样重。v2 用 IDF 式的停止词降权 +
 *      sublinear TF，让罕见词主导方向。
 *
 * 仍然保持的三条硬性质（不可牺牲）：
 *   · 确定性：同文本任何进程、任何时间都得到同一向量（cell 幂等与重放依赖它）
 *   · 同步、无依赖：编码路径是同步的，不能 await 一个模型
 *   · 定长 int8：与 MC03 的 64 维落盘对齐
 *
 * 想真正语义化，接 `EmbeddingPort`（宿主 embedding 服务）——见 `embeddingFor`。
 */
export function hashEmbedding(text: string, dim = 256): Int8Array {
  const out = new Int8Array(dim)
  const s = text.toLowerCase()
  const feats = new Map<string, number>()
  const bump = (k: string, w = 1) => feats.set(k, (feats.get(k) ?? 0) + w)

  // ① 字符 bigram 骨架。这是 v1 的做法，实测最稳：中文没有词边界，
  //    bigram 天然覆盖"词的一部分"，且对错字/改写有一定容忍。
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2)
    if (!g.trim()) continue
    bump(g)
  }

  // ② 同义族桥接：只加"这一族出现过"这一个特征，不改动 bigram 骨架。
  //    这是 v1 缺的那块——"暗色"与"深色"字面零重叠，靠 bigram 永远连不起来。
  for (const fam of SYNONYM_FAMILIES) {
    for (const w of fam) {
      if (s.includes(w)) {
        bump('SYN:' + fam[0], 2)
        break
      }
    }
  }

  // ③ 标识符/技术词整体成词（ui.theme、pnpm、node:test）：
  //    它们的 bigram 会互相污染（ui.theme 与 ui.font 共享 'ui'），整体 token 才能区分。
  const ids = s.match(/[a-z_][a-z0-9_.\-:]{1,30}/g) ?? []
  for (const id of ids) bump('ID:' + id, 2)

  for (const [k, n] of feats) {
    const h = fnv32(k)
    const bucket = h % dim
    const sign = (h >>> 31) & 1 ? -1 : 1
    // sublinear TF：同一 bigram 出现 5 次不等于 5 倍重要
    const weight = 1 + Math.log(n)
    out[bucket] = clampInt8(out[bucket] + sign * Math.round(weight * 4))
  }
  return out
}

function clampInt8(x: number): number {
  return Math.max(-127, Math.min(127, x))
}

/** 停止词与虚词：保留清单供上层（面板标签、搜索）复用，向量路径已改用 bigram 骨架。 */
export const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '和', '与', '就', '也', '都', '很',
  '这', '那', '一个', '一下', '什么', '怎么', '可以', '还是', '就是', '因为', '所以', '但是',
  'the', 'a', 'an', 'is', 'are', 'was', 'to', 'of', 'and', 'or', 'it', 'this', 'that', 'i', 'we',
])

/**
 * 同义词族：把"说法不同、指的同一件事"映射到同一个规范 token。
 *
 * 这张表不是语义模型，是一条**显式的、可审计的**等价声明——
 * 每加一条都意味着"我认为这两个说法在检索时应当等价"。
 * 它的作用域只到向量通道；SDR 通道仍然按字面，两者互补。
 */
const SYNONYM_FAMILIES: string[][] = [
  ['深色', '暗色', '黑暗', '夜间', 'dark', 'night'],
  ['浅色', '亮色', '白天', 'light', 'day'],
  ['主题', '配色', '外观', '皮肤', 'theme', 'appearance'],
  ['字体', '字形', 'font', 'typeface'],
  ['等宽', 'monospace', 'mono'],
  ['无衬线', 'sans', 'sans-serif'],
  ['构建', '打包', '编译', 'build', 'bundle', 'compile'],
  ['测试', '单测', '用例', 'test', 'spec', 'unittest'],
  ['部署', '上线', '发布', 'deploy', 'release', 'ship'],
  ['数据库', '库', 'db', 'database'],
  ['缓存', '快取', 'cache'],
  ['索引', '倒排', 'index'],
  ['报错', '错误', '异常', '失败', 'error', 'exception', 'failure'],
  ['修复', '修', '改正', 'fix', 'repair', 'patch'],
  ['偏好', '喜欢', '习惯', '更愿意', 'prefer', 'like', 'favor'],
  ['讨厌', '不喜欢', '反感', 'dislike', 'hate'],
  ['决定', '定了', '确定', 'decide', 'settle'],
  ['任务', '待办', 'todo', 'task'],
  ['进度', '进展', 'progress'],
  ['知识', '资料', 'knowledge', 'doc'],
  ['项目', '工程', 'project', 'repo'],
  ['用户', '我', 'user', 'me'],
  ['记忆', '回忆', 'memory', 'recall'],
  ['情感', '情绪', '心情', 'emotion', 'mood', 'affect'],
]

const SYNONYM_INDEX = new Map<string, string>()
for (const fam of SYNONYM_FAMILIES) {
  const canon = fam[0]
  for (const w of fam) SYNONYM_INDEX.set(w, canon)
}

/** 把同义词族里的任一说法折成规范 token。导出是为了让测试能验证"这确实等价"。 */
export function canonicalToken(tok: string): string {
  return SYNONYM_INDEX.get(tok) ?? tok
}

function fnv32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h >>> 0
}

/**
 * 余弦相似度。**两个向量长度不同时按 PQ 语义比较**。
 *
 * 这是一个真 bug 的修复：冷层 cell 的 emb 会被 `pq32` 压到 32 维，
 * 而查询向量是 256 维，`a.length !== b.length → 0` 意味着
 * **冷层 cell 在语义路上永远拿 0 分**——越久远的记忆越检索不到，
 * 恰好与"长期记忆"的目的相反。现在短的一侧展开到长的一侧再算。
 */
export function cosine(a: Int8Array | null, b: Int8Array | null): number {
  if (!a || !b) return 0
  if (a.length !== b.length) {
    const n = Math.max(a.length, b.length)
    const ax = a.length === n ? a : expandEmb(a, n)
    const bx = b.length === n ? b : expandEmb(b, n)
    return cosineSame(ax, bx)
  }
  return cosineSame(a, b)
}

/** 把 8 段 × 4 值的 PQ 向量按段复制展开到目标维度（值域 ×16 还原）。 */
function expandEmb(v: Int8Array, dim: number): Int8Array {
  const out = new Int8Array(dim)
  if (v.length === 32) {
    const seg = Math.max(1, Math.floor(dim / 8))
    const perSub = Math.max(1, Math.floor(seg / 4))
    for (let s = 0; s < 8; s++) {
      for (let b = 0; b < 4; b++) {
        const val = (((v[s * 4 + b] << 28) >> 28) || 0) * 16
        for (let j = 0; j < perSub; j++) {
          const i = s * seg + b * perSub + j
          if (i < dim) out[i] = val
        }
      }
    }
    return out
  }
  const g = v.length / dim
  for (let i = 0; i < dim; i++) {
    const from = Math.floor(i * g)
    const to = Math.max(from + 1, Math.floor((i + 1) * g))
    let acc = 0
    for (let j = from; j < to && j < v.length; j++) acc += v[j]
    out[i] = Math.max(-127, Math.min(127, Math.round(acc / Math.max(1, to - from))))
  }
  return out
}

function cosineSame(a: Int8Array, b: Int8Array): number {
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

/**
 * 向量来源：宿主 embedding 服务可用就用它，否则本地哈希。
 *
 * 返回值里的 `source` 会被写进面板的"后端能力"，让"当前用的是真模型还是降级实现"
 * 这件事一眼可见——这是文档 §18 反复强调的那条规矩。
 */
export interface EmbeddingPort {
  readonly name: string
  embed(text: string): Promise<Float32Array | number[]>
}

export type EmbedSource = 'host' | 'hash'

export function embeddingFor(
  text: string,
  cfg: { embDim: number; embStoreDim?: number },
  port?: EmbeddingPort | null,
  precomputed?: Float32Array | number[] | null,
): { vec: Int8Array; source: EmbedSource } {
  const dim = cfg.embStoreDim ?? cfg.embDim
  if (precomputed && precomputed.length > 0) {
    const q = quantize(precomputed, dim)
    return { vec: q, source: 'host' }
  }
  if (port) {
    // 端口是异步的，编码路径是同步的：这里不阻塞，等异步侧回填。
    // 调用方（encoder.encodeTurnAsync）会传 precomputed。
    return { vec: hashEmbedding(text, dim), source: 'hash' }
  }
  return { vec: hashEmbedding(text, dim), source: 'hash' }
}

/** float 向量 → int8 定长（L2 归一后按最大绝对值缩放，避免长尾全挤在 0 附近）。 */
export function quantize(v: Float32Array | number[], dim: number): Int8Array {
  const out = new Int8Array(dim)
  let max = 0
  for (let i = 0; i < Math.min(v.length, dim); i++) max = Math.max(max, Math.abs(v[i]))
  const scale = max > 0 ? 127 / max : 0
  for (let i = 0; i < Math.min(v.length, dim); i++) out[i] = clampInt8(Math.round(v[i] * scale))
  return out
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
  // 查询向量与落盘向量必须走**同一条变换链**：先在 embDim 的哈希空间里算，
  // 再折叠到 embStoreDim。直接在 embStoreDim 上哈希会得到另一个向量空间
  // （折叠是"分组求和"，不是"换桶数"），两者不可比——实测会把 Recall@8 打到 0.23。
  const qEmb = foldEmb(hashEmbedding(q.text, config.embDim), config.embStoreDim ?? config.embDim)
  const timeRange = q.timeRange ?? parseTimeExpr(q.text, now)
  const goalSdr = q.goal ? buildQuerySdr(space, q.goal.sdrText) : undefined
  const mood: Pad = q.pad ?? { v: 0, a: 0, d: 0, s: 0 }

  // ── 候选收集：四路并行（这里串行执行，但每路独立，语义与并行一致） ──
  // 双时态可见性：默认只看"现在仍然为真"的版本；给 asOf 就按当时的口径看。
  const scopeKey = q.scopeKey ?? deps.scopeKey ?? 'user:local'
  const visible = (cell: MemCell): boolean => {
    // 视角过滤：'想听事实' 与 '想聊感受' 是两种不同的检索意图
    if (q.lens && (cell.lens ?? 'fact') !== q.lens) return false
    // 墓碑不参与召回（v0.5）。v0.4 里 tier 3 与 tier 4 都是"归档"，
    // 所以"墓碑"从来没能真正把一条记忆挡在检索之外——真正起作用的只有 tInvalid。
    if (!q.includeTombstones && cell.tier >= 4) return false
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

  // Q1 语义路：索引优先，索引缺席或库太小时精确扫描。
  // 两条路径返回的都是"cell 引用 + 相似度"，后续打分完全一致——
  // 差别只在候选集是否完备（ANN 是近似的，这是它唯一的代价）。
  const semScored: Array<{ c: MemCell; s: number }> = []
  const wantK = Math.max(8, weights.annTopK)
  if (deps.ann) {
    // 多取一倍：索引不知道作用域/视角/失效过滤，被滤掉的候选需要有余量补上
    for (const hit of deps.ann.search(qEmb, wantK * 2, Math.max(wantK * 2, weights.annEf ?? 64))) {
      const cell = store.getCell(hit.id)
      if (!cell) continue
      if (q.kinds && !q.kinds.includes(cell.kind)) continue
      if (!visible(cell)) continue
      if (hit.score > 0.12) semScored.push({ c: cell, s: hit.score })
    }
  } else {
    store.forEachCell((cell) => {
      if (q.kinds && !q.kinds.includes(cell.kind)) return
      if (!visible(cell)) return
      const s = cosine(qEmb, cell.emb)
      if (s > 0.12) semScored.push({ c: cell, s })
    })
  }
  semScored.sort((a, b) => b.s - a.s || Number(a.c.cellId - b.c.cellId))
  const semTop = semScored.slice(0, wantK)
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

  /**
   * Q2b 墓碑目录通道（v0.5.1）。
   *
   * v0.5 加了 `includeTombstones` 开关，但墓碑压实后 `emb` 与 `residual` 都没了：
   * 语义路 `cosine(null, …) = 0`，符号路又只吃实体 SDR——于是开关开不开都召不回，
   * 是个死开关。后果不是"少一个功能"，而是**一条墓碑如果忘了 id 就再也找不到**。
   *
   * 这里给它一条不依赖向量与原文的通道：拿 query 的分词和 `digest` 做覆盖率匹配。
   * 它只在显式要求 `includeTombstones` 时启用，得分被压在 0.85 以下——
   * 墓碑能"被找到"，但不该抢走热记忆的槽位。
   */
  if (q.includeTombstones) {
    const qTok = tokenSet(q.text)
    if (qTok.size > 0) {
      store.forEachCell((cell) => {
        if (cell.tier < 4) return
        if (q.kinds && !q.kinds.includes(cell.kind)) return
        const dTok = tokenSet(cell.digest ?? '')
        if (dTok.size === 0) return
        let hit = 0
        for (const t of qTok) if (dTok.has(t)) hit++
        if (hit < 2) return
        const cover = hit / Math.min(qTok.size, dTok.size)
        if (cover < 0.3) return
        const cand = touch(cell)
        cand.channels.add('symbolic')
        cand.simSymbolic = Math.max(cand.simSymbolic, Math.min(0.85, 0.45 + cover * 0.4))
      })
    }
  }

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
    // queryId 必须可复现：随机后缀会让"同一 query 两次调用"得到不同 id，
    // 而 recall_snapshots 是按 id 取内容的，重放审计会对不上。
    queryId: q.queryId ?? `q${now.toString(36)}${(fnv32(q.text + '|' + now + '|' + store.countCells()) % 46656).toString(36)}`,
    strategy,
    hits,
    rendered: rendered.text,
    tokens: rendered.tokens,
    surfaceMode: config.surfaceMode,
    // 内容寻址：与服务层的 putSnapshot 同源，裸调 runRecall 也能拿到可重放的 id
    snapshotId: snapshotIdOf(rendered.text),
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
    /**
     * 注意：这里**不再乘 moodW**。
     *
     * v0.3 之前 rawParts.affect = moodW × congruence，weights.affect = wAffect × moodW，
     * 两者相乘得到 wAffect × moodW² × congruence——心境的影响被平方放大，
     * 而 activeW 归一化分母只算一次，于是面板上「0.62 × 1.00」和实际贡献对不上，
     * 破坏了「显示的就是算的」这条承诺。现在 moodW 只在 weights 里乘一次。
     */
    affect: congruence,
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

/**
 * 轻量分词（v0.5.1）：拉丁词 + 中文单字。
 *
 * 不用 bigram 的原因：中文 digest 通常只有 6–12 个字，bigram 会把查询覆盖率压到 0.1 以下，
 * 阈值根本调不出来；单字 + 停用字过滤在这个粒度上更稳。
 * 它不是"语义匹配"，只是让墓碑有一条可发现的目录通道。
 */
const CJK_STOP = new Set('的了吗呢吧啊是在我你他她它们这那有和与就都也还不'.split(''))

function tokenSet(text: string): Set<string> {
  const out = new Set<string>()
  if (!text) return out
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length < 2) continue
    if (STOPWORDS.has(w)) continue
    out.add(w)
  }
  for (const ch of text) {
    if (/[\u4e00-\u9fa5]/.test(ch) && !CJK_STOP.has(ch)) out.add(ch)
  }
  return out
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
