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
  /**
   * 成对常量的稀疏随机投影（v0.6.2）。
   *
   * 为什么每**相邻两维共用一个权重**：冷层用 `pq4` 压到 4 bit，
   * 而 `pq4` 在 dim=64 时 `perSub = 2`——也就是**每两个维度共用一个 nibble**，
   * 展开后这两维被强制相等（成对取均值）。
   * 如果投影基在每一维上独立随机，成对均值会改变投影方向，降档时星星就跳；
   * 让一对维度共用权重后，`w·(a+b)/2` 与 `w·(a+b)` 只差一个常数倍，
   * L2 归一化把它消掉——**降档漂移因此从 0.289 降到 0.130**（实测，12 条样本）。
   *
   * 代价：独立系数减半（64 维 → 32 个）。三维可视化不需要更多自由度，
   * 实测语义保距（余弦 × 投影距离的相关性）反而略好：0.0159 vs 0.0150。
   */
  const make = () => {
    const v = new Float64Array(dim)
    let norm = 0
    for (let i = 0; i < dim; i += 2) {
      // 稀疏随机投影：只让约 1/3 的"维度对"参与，降低"任何两个点都相似"的塌缩
      const w = rnd() < 0.34 ? rnd() * 2 - 1 : 0
      v[i] = w
      if (i + 1 < dim) v[i + 1] = w
      norm += w * w * (i + 1 < dim ? 2 : 1)
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
 *
 * ── v0.6.2：按 L2 范数归一（修星图塌缩） ─────────────────────────
 *
 * v0.6.1 及之前按 `v[i] / 127` 缩放——127 是 int8 的满量程，但**实际存的向量
 * 只有 ±4…±8**（哈希 embedding 的 sublinear TF 权重，见 `hashEmbedding`）。
 * 于是每个分量被压到 ±0.06，投影后的坐标全部落在 ±0.03 内：
 * 星图上 1200 条记忆塌成一个点。这不是"视觉问题"，是**投影把方向信息丢了**。
 *
 * 修法：先算向量的 L2 范数，按范数归一成单位向量再投影。
 * 余弦与随机投影都只关心**方向**，归一化不损失任何检索语义，
 * 而且让"哈希向量（±8）"与"provider 向量（±127）"落在同一个尺度上——
 * 否则同一批记忆在切换向量源后会整体缩放。
 */
export function project3(emb: Int8Array | null, dim = 64): [number, number, number] {
  if (!emb || emb.length === 0) return [0, 0, 0]
  /**
   * 维度不一致时用 `expandEmb` 展开——**与打分路径同一份逻辑**（v0.6.2 统一）。
   *
   * 这里纠正了 v0.6.0/v0.6.1 的两处错误结论：
   *
   * ① v0.6.0 的注释写"先展开到 64 维"，但代码是 `Math.min(emb.length, dim)` 零填充，
   *    注释与实现不符。v0.6.1 把注释改成了"零填充才是忠实逆变换"，
   *    并记下"expandEmb 漂移 0.467 > 零填充 0.031"。
   *
   * ② 那组实测是在**塌缩尺度**上量的：当时按 `v[i]/127` 缩放，坐标全在 ±0.03 内，
   *    两个都贴原点的点之间距离自然"很小"。0.031 这个数字度量的是"两个点都塌了"，
   *    而不是"两个点重合"。F8 断言 `漂移 ≤ 0.08` 在塌缩下恒真，正好盖住了真问题。
   *
   * 事实上 `pq4`（dim=64）的布局是 seg=8 / perSub=2，而 `expandEmb` 的 32 维分支
   * 正是"8 段 × 4 字节、每字节铺 2 维"——**它才是 pq32 的精确逆变换**。
   * 归一化后重新实测：expandEmb 漂移 0.130，零填充 0.500。方向反了。
   *
   * 顺带解决了原先记在 v0.7 待办里的"打分用 expandEmb、星图用零填充，两套解释不一致"。
   */
  const v = emb.length === dim ? emb : expandEmb(emb, dim)

  // L2 归一：只保留方向。范数为 0 的向量（空记忆）落在原点。
  let norm = 0
  for (let i = 0; i < dim; i++) norm += v[i] * v[i]
  if (norm === 0) return [0, 0, 0]
  const inv = 1 / Math.sqrt(norm)

  const [vx, vy, vz] = projectionVectors(dim)
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < dim; i++) {
    const c = v[i] * inv
    x += c * vx[i]
    y += c * vy[i]
    z += c * vz[i]
  }
  // tanh 压缩：单位向量与随机单位向量的点积通常落在 ±0.5 内，
  // 乘 1.8 后 tanh 给出约 ±0.6 的分布——既不塌缩也不贴边。
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
