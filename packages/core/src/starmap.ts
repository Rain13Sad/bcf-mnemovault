/**
 * 3D 记忆星图投影（v0.6 面板）
 *
 * ── 为什么放在 host 侧算 ────────────────────────────────────────
 * 星图要的是"相似的记忆挨在一起"。相似度的来源是 cell 的 64 维向量，
 * 而那份数据**不在面板快照里**（也不该在——快照已经有 20+ 字段了）。
 * 于是把 64 维投影成 3 维在 host 侧做，快照只传 x/y/z 三个数。
 *
 * ── 为什么是随机投影而不是 PCA ──────────────────────────────────
 * PCA 要协方差矩阵 + 特征分解，10 万 cell 上代价不可接受，而且**不稳定**：
 * 新写入一条记忆会改变主轴，整张星图会突然旋转——用户会以为记忆被改动了。
 * 随机投影（Johnson-Lindenstrauss）用的是**固定种子**的矩阵，
 * 所以新数据只增加点、不移动已有的点。这条性质比"多解释 3% 方差"重要得多。
 */

import type { MemCell } from './cell.js'
import { expandEmb } from './emb.js'
import type { PanelCellView, PanelStarMap, PanelStarNode } from './types.js'

/** 固定种子 → 三个投影向量。种子进常量，星图才是可复现的。 */
const PROJECTION_SEED = 0x5f3a91

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 投影向量缓存（v0.6.1 · 修 F9）。
 *
 * 种子是常量，结果必然相同——v0.6.0 却在 `project3()` 里每次重算：
 * 1200 个节点 = 1200 × (3 × 64 次 mulberry32 + 3 次 Float64Array 分配 + 归一化)。
 * 实测 4.0 ms/次，面板每 3 秒一次，纯浪费。现在按 dim 缓存。
 */
const PROJ_CACHE = new Map<number, [Float64Array, Float64Array, Float64Array]>()

function projectionVectors(dim: number): [Float64Array, Float64Array, Float64Array] {
  const hit = PROJ_CACHE.get(dim)
  if (hit) return hit
  const built = buildProjection(dim)
  PROJ_CACHE.set(dim, built)
  return built
}

function buildProjection(dim: number): [Float64Array, Float64Array, Float64Array] {
  const rnd = mulberry32(PROJECTION_SEED)
  const make = () => {
    const v = new Float64Array(dim)
    let norm = 0
    for (let i = 0; i < dim; i++) {
      // 稀疏随机投影：只让 1/3 的维度参与，降低"任何两个点都相似"的塌缩
      v[i] = rnd() < 0.34 ? rnd() * 2 - 1 : 0
      norm += v[i] * v[i]
    }
    const s = norm > 0 ? 1 / Math.sqrt(norm) : 0
    for (let i = 0; i < dim; i++) v[i] *= s
    return v
  }
  return [make(), make(), make()]
}

/**
 * 单条记忆 → 三维坐标 ∈ [−1, 1]。
 * 冷层 32 维 PQ 向量先展开到 64 维，保证"同一条记忆在不同层里位置不变"。
 */
export function project3(emb: Int8Array | null, dim = 64): [number, number, number] {
  if (!emb || emb.length === 0) return [0, 0, 0]
  /**
   * 维度不一致时**零填充到原位置**（v0.6.1 · 修 F8，但与审计稿的建议相反）。
   *
   * 先把事实说清楚：`pq32()` 是 `pq4()` 之后取**前 32 个 nibble**，
   * 也就是"前 32 维的 4 bit 量化"，不是语义 PQ 子空间。
   * 所以它的忠实逆变换是**按下标放回前 32 位、其余补 0**——
   * 这正是 v0.6.0 里 `Math.min(emb.length, dim)` 实际做的事
   * （代码注释写着"先展开到 64 维"，但代码里没有展开，注释是错的）。
   *
   * 审计稿建议改成 `expandEmb(emb, dim)`。实测（6 条真实记忆取平均）：
   *   零填充漂移 **0.031** · expandEmb 漂移 **0.467**（比原来更糟）。
   * 原因：`expandEmb` 的 32 维分支按"8 个子向量 × 4 字节"铺开，
   * 与 pq32 的"前 32 维"布局不是同一个解释，展开后反而把向量打散。
   *
   * 因此这里保留零填充，但**把语义写清楚**：冷层在星图上的位置 = 它前 32 维
   * 的方向。残余漂移来自 4 bit 量化本身（每维丢 4 bit），是压缩的固有代价，
   * 不是布局错位。`test/v061-starmap` 断言这个漂移有界。
   *
   * 待办（v0.7）：打分路径用的是 `expandEmb`，与这里的解释不一致。
   * 统一两者会改变召回分数，属于独立议题，不在补丁版里做。
   */
  let v: Int8Array
  if (emb.length === dim) {
    v = emb
  } else if (emb.length < dim) {
    v = new Int8Array(dim)
    v.set(emb)
  } else {
    // 更长的向量（例如 256 维）折到 64：与 foldEmb 同口径
    v = expandEmb(emb, dim)
  }
  const [vx, vy, vz] = projectionVectors(dim)
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < dim; i++) {
    const c = v[i] / 127
    x += c * vx[i]
    y += c * vy[i]
    z += c * vz[i]
  }
  // tanh 压缩：投影值集中在 0 附近，线性缩放会让所有点挤在中心
  return [Math.tanh(x * 1.8), Math.tanh(y * 1.8), Math.tanh(z * 1.8)]
}

/**
 * 构建星图。`maxNodes` 默认 1200：再多画布就只剩噪声，
 * 而且面板每 3 秒重建一次，节点数直接决定这个快照的成本。
 *
 * 采样是**按重要性加权**的：星图不是"全部记忆的目录"，是"记忆的星等"。
 * 被固定的、高重要性的、带情绪的必须出现；随机挑会让星图每次刷新都换一张脸。
 */
export function buildStarMap(
  cells: PanelCellView[],
  edgeList: Array<{ src: string; dst: string; weight: number }>,
  getCell: (id: string) => MemCell | null,
  maxNodes = 1200,
): PanelStarMap {
  const pool = [...cells]
  pool.sort((a, b) => starRank(b) - starRank(a) || b.tFrom - a.tFrom)
  const picked = pool.slice(0, maxNodes)
  const nodes: PanelStarNode[] = picked.map((c) => {
    const cell = getCell(c.cellId)
    const [x, y, z] = project3(cell?.emb ?? null)
    return {
      id: c.cellId,
      shortId: c.shortId,
      x,
      y,
      z,
      kind: c.kind,
      tier: c.tier,
      valence: c.valence,
      arousal: c.arousal,
      salience: c.salience,
      importance: c.importance,
      digest: c.digest.slice(0, 40),
      pinned: c.pinned,
      invalidated: c.invalidated,
    }
  })
  const keep = new Set(nodes.map((n) => n.id))
  const edges = edgeList
    .filter((e) => keep.has(e.src) && keep.has(e.dst))
    .slice(0, maxNodes * 2)
    .map((e) => [e.src, e.dst, e.weight] as [string, string, number])
  return { nodes, edges, projected: 'random3', sampled: pool.length > maxNodes ? maxNodes : pool.length, total: pool.length }
}

/** 星等：决定"谁配出现在星图上"。 */
export function starRank(c: PanelCellView): number {
  let s = c.importance * 2 + c.salience
  if (c.pinned) s += 2
  if (c.emotional) s += 1.2
  if (c.disputed) s += 0.8
  if (c.invalidated) s -= 1.5
  if (c.tier >= 4) s -= 3
  s += Math.min(1, c.accessCount / 8)
  return s
}
