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

import type { CellKind, MemCell } from './cell.js'
import { FLAG, REL, TAG, foldEmb } from './cell.js'
import { decayR } from './decay.js'
import { estimateTokens, assignShortIds, renderAffectLine, renderSurface } from './render.js'
import type { SdrSpace, Sdr } from './sdr.js'
import { snapshotIdOf, type Store } from './store.js'
import { extractEntities, normToken, parseTimeExpr } from './text.js'
import { minOverlapForContainment } from './inverted.js'
import { expandEmb } from './emb.js'
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
/**
 * 弃权阈值（v0.7.0）：最高相似度低于它就算"没有清晰记忆"。
 *
 * 0.30 的依据：实测真实语料里命中项的 sim 多在 0.6–1.0，
 * 而陷阱题（问一件从没发生过的事）最高 sim 只有 0.1–0.2。
 * 0.30 落在两簇之间的空档上，且离两侧都留了余量。
 */
export const ABSTAIN_SIM = 0.3
/**
 * 语义通道作为"证据"的最低绝对余弦（v0.7.0）。
 *
 * 见弃权判定处的注释：哈希 embedding 的绝对余弦没有区分力，
 * 只有接近"同一句话"时（0.75+）才值得当作"确实在讲这件事"的证据。
 */
export const SEMANTIC_EVIDENCE_FLOOR = 0.75

/**
 * 查询侧停用实体（v0.7.0）。
 *
 * `extractEntities` 为了覆盖中文会切出二元组，其中一半是"什么/怎么/哪个"这类
 * 疑问词——它们出现在几乎每个问句里，却对"在讲哪件事"毫无信息。
 * 用它们判弃权会让每条陷阱题都"命中"。
 */
const QUERY_STOP = new Set([
  '什么', '怎么', '怎样', '哪个', '哪些', '多少', '为什么', '如何', '是否',
  '我们', '你们', '他们', '这个', '那个', '现在', '之前', '上次', '下次',
  '一下', '可以', '还是', '就是', '因为', '所以', '但是', '然后', '这样', '那样',
])
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
   * 作用域模式（v0.7.1）。`per-session` 时不比较 scopeKey，改为**按会话过滤**——
   * 它给"多租户但暂时没有身份层"的部署一个一键档：不需要 userId，也不会跨会话泄漏。
   */
  scopeMode?: 'auto' | 'shared' | 'per-user' | 'per-session'
  /**
   * 向量索引（§9.1 Q1）。给了就用它取候选，没给就精确扫描。
   * 是否真的走 ANN 由 config.recall.annEnabled + annThreshold 决定——
   * 小库上精确扫描更快且无误差，这个判断在 service 里做，不在这里。
   */
  ann?: { search(vec: Int8Array, k: number, ef?: number): Array<{ id: bigint; score: number }> }
  /**
   * 向量矩阵（v0.5.2）。给了就顺序扫描内存矩阵，没给就 `forEachCell` 逐条解码。
   *
   * 两者的分数**逐位相同**（矩阵用的是同一个 `expandEmb` 与同一条 cosine 公式），
   * 差别只在"解码 10 万个 blob"还是"扫 12.8 MB 连续内存"。
   */
  embScan?: (q: Int8Array, visit: (id: bigint, score: number) => void) => void
  /**
   * SDR 倒排候选（v0.5.2）。返回 null 表示"索引不可用，请全扫"。
   *
   * 返回的是**超集**（由门限反推的最小重叠位），不是近似，所以接进来不会掉 Recall。
   */
  sdrCandidates?: (sdr: Sdr, minOverlap: number) => bigint[] | null
  /**
   * 语料词频查询（v0.6.2 · IDF）。缺席时不做剪枝，行为与 v0.6.1 完全一致。
   *
   * 注意它**只影响查询侧**：`hashEmbedding` 仍然是纯函数，
   * 落盘向量与 cellId 一个字节都不变。
   */
  tokenDf?: (tokens: readonly string[]) => { df: Map<string, number>; docs: number }
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
  /**
   * v0.7.0：**未归一化**的语义相似度（原始 cosine）。
   *
   * `simSemantic` 会按"本批最大值"归一化——这让分数跨轮可比，
   * 但也把绝对证据抹掉了：只有一个候选时它恒等于 1.0，
   * 于是陷阱题（问一件从没发生过的事）也会显示"完全匹配"。
   *
   * 弃权判定必须看绝对值，所以这里单独留一份。
   */
  rawSemantic: number
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
const BASE_SYNONYM_FAMILIES: string[][] = SYNONYM_FAMILIES.map((f) => [...f])

/** v0.7.3 U1（A13）：注入族后必须重建索引，否则"配了但没生效"。 */
function rebuildSynonymIndex(): void {
  SYNONYM_INDEX.clear()
  for (const fam of SYNONYM_FAMILIES) {
    const canon = fam[0]
    if (!canon) continue
    for (const w of fam) SYNONYM_INDEX.set(w, canon)
  }
}
rebuildSynonymIndex()

/** 追加查询侧同义词族。同名词以后注入的规范词为准。 */
export function configureSynonymFamilies(families: string[][]): void {
  for (const fam of families) {
    if (!Array.isArray(fam)) continue
    const clean = fam.filter((w): w is string => typeof w === 'string' && w.trim().length > 0).map((w) => w.trim())
    if (clean.length < 2) continue
    SYNONYM_FAMILIES.push(clean)
  }
  rebuildSynonymIndex()
}

export function resetSynonymFamilies(): void {
  SYNONYM_FAMILIES.length = 0
  SYNONYM_FAMILIES.push(...BASE_SYNONYM_FAMILIES.map((f) => [...f]))
  rebuildSynonymIndex()
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

/**
 * 查询向量（v0.6）。
 *
 * 一条硬约束：**查询向量与落盘向量必须同空间**。
 *   · 没预热到 provider 向量 → 哈希空间（默认，零依赖）
 *   · 预热到了 → provider 空间，且库里必须也已经是 provider 空间
 * 混用会让余弦相似度失去意义（不同模型的 64 维折叠结果不可比），
 * 而这种错误**不会报错**，只会让召回悄悄变差——所以由 `engine.status()`
 * 在调用前拦截，而不是在这里猜。
 */
export function queryEmbedding(
  text: string,
  cfg: { embDim: number; embStoreDim?: number },
  precomputed?: Float32Array | number[] | null,
): Int8Array {
  const dim = cfg.embStoreDim ?? cfg.embDim
  if (precomputed && precomputed.length > 0) {
    // 先按自身最大绝对值量化到 int8，再折叠到落盘维度——
    // 顺序不能反：先折叠会把不同量级的维度平均掉，归一化就失真了。
    return foldEmb(quantize(precomputed, precomputed.length), dim)
  }
  return foldEmb(hashEmbedding(text, cfg.embDim), dim)
}

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

/**
 * 查询 SDR：实体身份码的并集 + 话题码。稀疏、可解释、跨进程稳定。
 *
 * ── v0.7.0：命名空间必须与 cell 侧一致（这是一个真 bug 的修复）────────
 * cell 的 SDR 由 `buildSdr` 生成，用的是 `identity('V:' + normToken(value))`；
 * 而这里原来用 `identity('E:' + entity)`。**两个命名空间不相交**，
 * 于是 `containment(qSdr, cellSdr)` 恒等于噪声底——
 * "四路召回"里的符号路其实一直是空的，所有召回都靠语义路撑着。
 *
 * 这解释了独立审计里 B1（单跳精确事实）失败：问"生日是哪天"时，
 * 唯一能精确对上实体的那条通道根本没接上。
 *
 * 修法是把查询侧对齐到 `V:` + `normToken`（与 cell 完全同一条变换链），
 * 而不是改 cell 侧——改 cell 会让所有既有 cellId 与 SDR 失配（要 rebuild）。
 */
export function buildQuerySdr(space: SdrSpace, text: string, extraEntities: string[] = [], entities?: readonly string[]): Sdr {
  const ents = entsForQuery(entities ?? [...extractEntities(text), ...extraEntities])
  /**
   * 查询侧用**裸实体**（不 bind 角色），与 cell SDR 里的"bag 通道"对齐。
   *
   * 试过让查询也按角色展开（每个实体 bind 到 AGENT/PATIENT/MANNER 再 bundle），
   * 结果 containment 反而掉到 0.02：分母变成 3 倍，而 cell 里只有 1 个角色能对上。
   * 正确做法是**在 cell 侧加一条裸实体通道**（见 `Encoder.buildSdr`），
   * 让"这条记忆提到过哪些实体"变成一个可匹配的集合，角色绑定继续服务于解绑。
   */
  const items: Sdr[] = ents.map((e) => space.identity('V:' + normToken(e)))
  return space.bundle(items)
}

/** 查询实体截断：24 个实体 × 8 位 = 192 位，仍在 bundle 上限内。 */
function entsForQuery(ents: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const e of ents) {
    const k = normToken(e)
    if (!k || k.length < 2 || seen.has(k)) continue
    seen.add(k)
    out.push(e)
    if (out.length >= 24) break
  }
  return out
}

/**
 * 查询侧 IDF 剪枝（v0.6.2）。
 *
 * `containment(q,c) = |q∩c| / |q|` 对每个 token 等权，于是"我的""这个""是"
 * 这类几乎每条记忆都含的词，既抬高分母、又只在恰好含它的 cell 上加分——
 * 净效果是把真正有区分力的实体稀释掉。
 *
 * 三条保守约束（宁可不剪，不可剪错）：
 *   1. 文档数不足 `idfMinDocs` 时完全不剪（小库上 df 抖动比信号大）；
 *   2. 剪枝只剔除 `df/docs ≥ idfMaxDfRatio` 的 token，不做软加权——
 *      软加权需要改 `containment` 的返回值口径，会牵动所有既有断言；
 *   3. **绝不剪空**：全被剔除时保留 df 最小的那一个，
 *      否则查询 SDR 变成零向量，符号路直接失效（比不剪更糟）。
 */
export function pruneQueryEntities(
  ents: readonly string[],
  deps: Pick<RecallDeps, 'tokenDf'>,
  cfg: { idfEnabled: boolean; idfMinDocs: number; idfMaxDfRatio: number },
): string[] {
  if (!cfg.idfEnabled || !deps.tokenDf || ents.length <= 1) return [...ents]
  let stats: { df: Map<string, number>; docs: number }
  try {
    stats = deps.tokenDf(ents)
  } catch {
    // 词频表不可用（旧库未建表、只读快照）时安静退回不剪
    return [...ents]
  }
  if (stats.docs < cfg.idfMinDocs) return [...ents]
  const kept: string[] = []
  const scored: Array<{ e: string; ratio: number }> = []
  for (const e of ents) {
    const ratio = (stats.df.get(e) ?? 0) / stats.docs
    scored.push({ e, ratio })
    if (ratio < cfg.idfMaxDfRatio) kept.push(e)
  }
  if (kept.length > 0) return kept
  // 全被剔除：留最稀有的那个（df 最小；并列取原顺序第一个）
  scored.sort((a, b) => a.ratio - b.ratio)
  return scored.length > 0 ? [scored[0].e] : [...ents]
}

export function runRecall(deps: RecallDeps, q: RecallQuery): RecallResult {
  const t0 = Date.now()
  const { space, store, config } = deps
  const now = deps.now ?? t0
  const weights = config.recall

  // v0.6.2：查询实体先过 IDF 剪枝，再建查询 SDR。
  // 只剪"哪些实体参与符号路"，不动向量通道（hashEmbedding 必须保持纯函数）。
  const queryEnts = [...extractEntities(q.text), ...(q.goal?.entities ?? [])]
  const keptEnts = pruneQueryEntities(queryEnts, deps, config.index)
  const qSdr = buildQuerySdr(space, q.text, [], keptEnts)
  // 查询向量与落盘向量必须走**同一条变换链**：先在 embDim 的哈希空间里算，
  // 再折叠到 embStoreDim。直接在 embStoreDim 上哈希会得到另一个向量空间
  // （折叠是"分组求和"，不是"换桶数"），两者不可比——实测会把 Recall@8 打到 0.23。
  const qEmb = queryEmbedding(q.text, config, q.emb)
  const timeRange = q.timeRange ?? parseTimeExpr(q.text, now)
  const goalSdr = q.goal ? buildQuerySdr(space, q.goal.sdrText) : undefined
  const mood: Pad = q.pad ?? { v: 0, a: 0, d: 0, s: 0 }

  // ── 候选收集：四路并行（这里串行执行，但每路独立，语义与并行一致） ──
  // 双时态可见性：默认只看"现在仍然为真"的版本；给 asOf 就按当时的口径看。
  /**
   * v0.7.0：作用域只能由服务端决定。
   *
   * 审计实测的泄漏形态就是这一行——`q.scopeKey` 曾是普通参数，模型经工具调用
   * 声明 `scopeKey: 'user:bob'` 就能读到别人的记忆。现在默认忽略调用方的值；
   * 只有部署方显式打开 `security.allowScopeOverride`（宿主内部调用）才生效。
   */
  const scopeKey = (config.security.allowScopeOverride && q.scopeKey) || deps.scopeKey || 'user:local'
  /** `scope: 'global'` 是跨域全库检索，属于宿主/用户权限，不是模型权限。 */
  const wantGlobal = q.scope === 'global' && config.security.allowGlobalScope
  const isolateSemantic = config.security.sessionIsolateSemantic
  const perSession = deps.scopeMode === 'per-session'
  /**
   * 可见性判定（列口径）。
   *
   * 抽成"只看列"的版本，是为了让 Q1 语义路能在**不解 blob** 的前提下先过滤：
   * 见 `store.forEachEmbedding`。`visible(cell)` 只是它的一层包装，
   * 两条路径共用同一份判据——否则"过滤条件"会出现两份，早晚漂。
   */
  const visibleFields = (f: {
    lens?: string
    tier: number
    tFrom?: number
    tInvalid: number
    scope?: string
    kind: number
    session?: string
  }): boolean => {
    // 视角过滤：'想听事实' 与 '想聊感受' 是两种不同的检索意图
    if (q.lens && (f.lens ?? 'fact') !== q.lens) return false
    // 墓碑不参与召回（v0.5）。v0.4 里 tier 3 与 tier 4 都是"归档"，
    // 所以"墓碑"从来没能真正把一条记忆挡在检索之外——真正起作用的只有 tInvalid。
    if (!q.includeTombstones && f.tier >= 4) return false
    // 作用域隔离（§14.10 / §19.2）：情景记忆默认不跨会话，语义/图式全局共享。
    // 这是"A 用户的事被 B 用户问出来"这条事故的唯一防线。
    if (!wantGlobal) {
      /**
       * per-session（v0.7.1）：作用域键是共享的哨兵值，真正的边界是 `session`。
       * 没有 sessionId 时**一律不可见**——宁可查不到，也不退回"全库可见"。
       */
      if (perSession) {
        if (!q.sessionId || f.session !== q.sessionId) return false
      } else {
        const cellScope = f.scope ?? 'user:local'
        if (cellScope !== 'global' && cellScope !== scopeKey) return false
      }
      // v0.7.0：`sessionIsolateSemantic` 打开时，语义记忆也只在本会话可见。
      // 多租户部署无法保证 per-user scopeKey 时，这是最后一道防线。
      const scoped = f.kind === 0 || isolateSemantic
      if (scoped && q.sessionId && f.session && f.session !== q.sessionId) return false
    }
    if (q.asOf !== undefined) {
      if ((f.tFrom ?? 0) > q.asOf) return false
      return f.tInvalid === 0 || f.tInvalid > q.asOf
    }
    if (q.includeInvalidated) return true
    return f.tInvalid === 0
  }
  const visible = (cell: MemCell): boolean => {
    /**
     * v0.7.0：指令形态文本默认不进渲染。
     *
     * 记忆化提示注入的关键一步是"把用户说过的一句话，在后续每一轮当成系统指令注入回去"。
     *
     * v0.7.1 修正了一处**注释与实现不一致**：旧注释说"仍可被检索"，
     * 但这条 `return false` 是在候选收集阶段——它连 hits 都拿不到。
     * 现在按实现如实描述：**不进召回**（面板与 `/mnemo show` 仍能看原文），
     * 因为这正是"不让它每轮在场"的最直接做法。要检索它，只能显式关掉这个开关。
     */
    if (config.security.blockInstructionRendering && cell.tags?.includes(TAG.instruction)) return false
    return visibleFields({
      lens: cell.lens,
      tier: cell.tier,
      tFrom: Number(cell.tFrom),
      tInvalid: Number(cell.tInvalid ?? 0),
      scope: cell.scope,
      kind: cell.kind,
      session: cell.session,
    })
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
        rawSemantic: 0,
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
    /**
     * 精确扫描，但**只读向量列**（v0.5.2）。
     *
     * 原来这里是 `forEachCell` + `cosine`：为了算 128 次乘加，把每条 cell 的
     * MC03 blob 解一遍（SDR 反量化、槽位、边）。10 万 cell 下那是几十万次对象分配，
     * 而 cosine 本身只要 1 ms——**解码比计算贵两个数量级**。
     *
     * 现在先按列过滤 + 算分，只对 top-K 回表解 blob。语义完全等价：
     * 过滤条件与 `visible()` 共用 `visibleFields`，分数与打分阶段共用 `cosine`。
     */
    /**
     * 矩阵路径：先粗筛（分数 > 0.12），再过可见性——可见性要解 blob，
     * 所以顺序很重要：把便宜的算术放在前面，贵的过滤放在后面。
     *
     * v0.6：候选收集从"全收 + 排序"改成 **有界 Top-K 堆**。
     *
     * 为什么要改：哈希向量的余弦普遍偏高（它们大多是同号分量），
     * 1 万条里能过 0.12 门限的有**几乎全部**。于是每次召回都分配 1 万个对象再
     * `sort` 一遍——10k 次分配 + O(n log n) 比较，实测把 recall p50 从 12 ms 拖到 38 ms，
     * 而且全落在 GC 上（同一个库、同一段代码，在刚写完 1 万条 cell 的进程里更慢）。
     *
     * 现在只维护 `wantK * 2` 个名额：堆顶是"当前最差的入选者"，
     * 新候选先跟堆顶比一次就能被拒掉。**结果与全量排序逐条一致**——
     * 比较器完全一样（分数降序，同分按 id 升序），所以这不改变召回质量，
     * `test/v052-index` 的"索引结果 == 全扫结果"对拍仍然守着这一点。
     */
    const topK = new TopK(wantK * 2)
    if (deps.embScan) {
      deps.embScan(qEmb, (id, s) => {
        if (s > 0.12) topK.push(id, s)
      })
      for (const hit of topK.sorted()) {
        const cell = store.getCell(hit.id)
        if (!cell) continue
        if (q.kinds && !q.kinds.includes(cell.kind)) continue
        if (!visible(cell)) continue
        semScored.push({ c: cell, s: hit.s })
        if (semScored.length >= wantK) break
      }
    } else {
      store.forEachCell((cell) => {
        if (q.kinds && !q.kinds.includes(cell.kind)) return
        if (!visible(cell)) return
        const s = cosine(qEmb, cell.emb)
        if (s > 0.12) semScored.push({ c: cell, s })
      })
    }
  }
  semScored.sort((a, b) => b.s - a.s || Number(a.c.cellId - b.c.cellId))
  const semTop = semScored.slice(0, wantK)
  const semNorm = normalizeMax(semTop.map((x) => x.s))
  semTop.forEach((x, i) => {
    const cand = touch(x.c)
    cand.channels.add('semantic')
    cand.simSemantic = Math.max(cand.simSemantic, semNorm[i])
    // 绝对值单独留一份：归一化只服务打分排序，不能用来判"有没有证据"
    cand.rawSemantic = Math.max(cand.rawSemantic, x.s)
  })

  /**
   * Q2 符号路：query 的 SDR containment（精确事实类查询的主通道）。
   *
   * v0.5.2 走倒排：门限由 `simNorm > 0.05` 反推成"最少共享几位"，
   * 于是候选集是真实候选的**超集**——不损失召回，只是不再解全库的 blob。
   * 索引停用（超预算）时自动退回全扫，行为完全一致。
   */
  const visitSymbolic = (cell: MemCell) => {
    if (q.kinds && !q.kinds.includes(cell.kind)) return
    if (!visible(cell)) return
    const c = space.simNorm(qSdr, cell.sdr)
    if (c > 0.05) {
      const cand = touch(cell)
      cand.channels.add('symbolic')
      cand.simSymbolic = Math.max(cand.simSymbolic, c)
    }
  }
  const containFloor = SIM_FLOOR + 0.05 * (1 - SIM_FLOOR)
  const symCands = deps.sdrCandidates?.(qSdr, minOverlapForContainment(space.popcount(qSdr), containFloor)) ?? null
  if (symCands) {
    for (const id of symCands) {
      const cell = store.getCell(id)
      if (cell) visitSymbolic(cell)
    }
  } else {
    store.forEachCell(visitSymbolic)
  }

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

  // Q4 时间路：query 含时间表达式时按区间重叠。
  // v0.5.2：走 `idx_time` 区间查询，不再全表扫（`idx_time` 从 v0.2 就建着，只是没人用）。
  if (timeRange) {
    const span = Math.max(1, timeRange.to - timeRange.from)
    const visitTemporal = (cell: MemCell) => {
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
    }
    const ids = store.cellsInTimeRange(timeRange.from - span, timeRange.to + span)
    for (const id of ids) {
      const cell = store.getCell(id)
      if (cell) visitTemporal(cell)
    }
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

  /**
   * 弃权判定（v0.6.2 引入，v0.7.1 重构）。
   *
   * ── 为什么必须排在渲染之前 ────────────────────────────────────
   * v0.7.0 是"先渲染 5 条、再补一句'有模糊候选但未达置信阈值'"。
   * 那句话与下面 5 条内容是**自相矛盾**的：模型看到声明的同时也看到了素材，
   * 而模型的默认行为是从已有素材里凑一个答案——审计 R5 实测到的正是这一点。
   *
   * 现在反过来：先判，再决定给多少。weak 只留**证据最强的那一条**，
   * 声明与内容一致（"我有点印象，但不确定"），而不是"我不确定，这里是五条"。
   *
   * ── 判据的三次迭代 ──────────────────────────────────────────
   * ① 手动检索此前永不弃权（`manual` 跳过 ignition），陷阱题恒为 hit；
   * ② 不能用**总分**：近因/心境/情境是与问题无关的基线，无关记忆也有 ~0.28；
   * ③ 不能用 **SDR containment**：查询侧二元组把 |q| 稀释，真命中只有 0.01。
   * 最终用**实体重叠**——"查询里的实体有没有出现在这条记忆的槽位里"。
   */
  const qEntSet = new Set(
    keptEnts.map((e) => normToken(e)).filter((e) => e.length >= 2 && !QUERY_STOP.has(e)),
  )
  const entityEvidence = (cell: MemCell): number => {
    if (qEntSet.size === 0) return 0
    let hit = 0
    for (const s of cell.slots) {
      if (s.type !== 'LIT' || !s.value) continue
      if (qEntSet.has(normToken(s.value))) hit++
    }
    return hit > 0 ? Math.min(1, 0.5 + 0.5 * (hit / qEntSet.size)) : 0
  }
  const evidenceOf = (s: { cand: Candidate }): number =>
    Math.max(
      entityEvidence(s.cand.cell),
      s.cand.simGraph,
      s.cand.simTemporal,
      // 语义只在"近乎同一句"时算证据（哈希向量的绝对余弦没有区分力）
      s.cand.rawSemantic >= SEMANTIC_EVIDENCE_FLOOR ? s.cand.rawSemantic : 0,
    )
  /**
   * v0.7.3 S3：`Math.max` 里只要混进一个 NaN，结果就是 NaN，
   * 而 `NaN < ABSTAIN_SIM` 恒为 false → verdict 直接判成 'hit'，
   * **弃权声明被绕过**（陷阱题会拿着不相关记忆自信作答）。
   * 非法证据一律按"没有证据"处理：宁可弃权，不可编造。
   */
  const evidences = selected.map(evidenceOf).filter((n) => Number.isFinite(n))
  const bestEvidence = evidences.length ? Math.max(...evidences) : 0
  const verdict: 'hit' | 'weak' | 'none' =
    selected.length === 0 ? (pool.length > 0 ? 'weak' : 'none') : bestEvidence < ABSTAIN_SIM ? 'weak' : 'hit'

  /**
   * weak：只保留证据最强的一条。
   *
   * 留 1 条而不是 0 条，是因为"有个模糊印象"本身是有效信息
   * （用户可以据此追问"是不是 XX？"）；但留 5 条就等于把选择权
   * 偷偷交回给模型，而那正是要避免的。
   */
  if (verdict === 'weak' && selected.length > 1) {
    let best = selected[0]
    for (const s of selected) {
      const e = evidenceOf(s)
      const be = evidenceOf(best)
      if (e > be || (e === be && s.breakdown.score > best.breakdown.score)) best = s
    }
    selected.length = 0
    selected.push(best)
  }

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

  if (verdict !== 'hit') {
    // 在渲染结果里追加一行弃权声明——模型看到它就知道"这条不该编"
    const abstainLine = verdict === 'none'
      ? '〔记忆系统：未找到相关记忆〕'
      : '〔记忆系统：有模糊候选但未达置信阈值，可能未记录过此事〕'
    rendered.text = rendered.text.length > 0 ? abstainLine + '\n' + rendered.text : abstainLine
    rendered.tokens += estimateTokens(abstainLine)
  }

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
    verdict,
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
  const recency = decayR(cell, ctx.now)
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
    /**
     * v0.7.2 F4：reduce 的初值不能是 `arr[0]`。
     * 当 best 恰好是 arr[0] 时，旧写法把 best 自己当成第二名的候选初值，
     * 于是 second 永远等于 best、差值恒为 0，`dominantChannel` 恒返回 'mixed'
     * ——面板"为什么召回这条"显示的通道分类从上线起就是错的。
     */
    const rest = arr.filter((x) => x !== best)
    if (rest.length === 0) return best
    const second = rest.reduce((a, b) => (simOf(c, b) > simOf(c, a) ? b : a))
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

export function clamp01(x: number): number {
  // v0.7.3 S3：归一化里混进 NaN 会让整条打分链变 NaN，`score < ignition` 恒假，
  // 所有候选都被塞进槽位、verdict 也可能被绕过。非法值按 0（无证据）处理。
  if (!Number.isFinite(x)) return 0
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

/**
 * 有界 Top-K（v0.6）。
 *
 * 一个大小为 K 的二叉堆，堆顶是**当前入选者里最差的那个**：
 * 分数最低；分数相同则 id 最大（因为最终排序是同分按 id 升序）。
 * 于是"新候选能不能进"只需一次比较，绝大多数候选在第一关就被拒掉。
 *
 * 为什么不直接用 `Array.prototype.sort`：1 万条全量排序要分配 1 万个对象，
 * 而那些对象 99% 会在下一步被丢掉。堆把分配量压到 K 个。
 */
export class TopK {
  private readonly ids: bigint[] = []
  private readonly scores: number[] = []
  private readonly k: number

  constructor(k: number) {
    this.k = Math.max(1, k)
  }

  get size(): number {
    return this.ids.length
  }

  /** 更差者优先成为堆顶：分数低，或同分时 id 大。 */
  private worse(a: number, b: number): boolean {
    if (this.scores[a] !== this.scores[b]) return this.scores[a] < this.scores[b]
    return this.ids[a] > this.ids[b]
  }

  push(id: bigint, score: number): void {
    if (this.ids.length < this.k) {
      this.ids.push(id)
      this.scores.push(score)
      this.up(this.ids.length - 1)
      return
    }
    // 与堆顶比一次：不比它好就直接丢
    if (!this.betterThanRoot(id, score)) return
    this.ids[0] = id
    this.scores[0] = score
    this.down(0)
  }

  private betterThanRoot(id: bigint, score: number): boolean {
    const rs = this.scores[0]
    if (score !== rs) return score > rs
    return id < this.ids[0]
  }

  /** 堆顶是"最差"，所以上浮条件是"比父更差"。 */
  private up(i: number): void {
    let idx = i
    while (idx > 0) {
      const parent = (idx - 1) >> 1
      if (!this.worse(idx, parent)) break
      this.swap(idx, parent)
      idx = parent
    }
  }

  private down(i: number): void {
    let idx = i
    const n = this.ids.length
    for (;;) {
      const l = idx * 2 + 1
      const r = l + 1
      let worst = idx
      if (l < n && this.worse(l, worst)) worst = l
      if (r < n && this.worse(r, worst)) worst = r
      if (worst === idx) break
      this.swap(idx, worst)
      idx = worst
    }
  }

  private swap(a: number, b: number): void {
    const ti = this.ids[a]
    this.ids[a] = this.ids[b]
    this.ids[b] = ti
    const ts = this.scores[a]
    this.scores[a] = this.scores[b]
    this.scores[b] = ts
  }

  /** 按"分数降序、同分 id 升序"返回——与全量 sort 的比较器逐字一致。 */
  sorted(): Array<{ id: bigint; s: number }> {
    const out = this.ids.map((id, i) => ({ id, s: this.scores[i] }))
    out.sort((a, b) => b.s - a.s || Number(a.id - b.id))
    return out
  }
}

export { estimateTokens }
