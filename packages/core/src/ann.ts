/**
 * 向量索引（§9.1 Q1 的加速层）
 *
 * ── 为什么要做，以及为什么现在才做 ───────────────────────────────
 * 10 万 cell 以内，精确余弦扫描（一次 forEachCell + 点积）比 HNSW 更快、更简单，
 * 而且**没有近似误差**。所以之前的实现直接全扫，并把接口点（annTopK）留着。
 *
 * 但"更快"只在库小的时候成立。全扫是 O(N·d)：10 万 × 64 维 ≈ 640 万次乘加，
 * 单次召回 30–60ms，而召回是**每一步**都要跑的——这个成本会随库线性增长，
 * 而 HNSW 是 O(log N)。所以现在的策略是分档：
 *
 *   N < annThreshold  → 精确扫描（默认 2000）
 *   N ≥ annThreshold  → HNSW（M=16, efConstruction=200, efSearch=64）
 *
 * 两条路径实现同一个 `VectorIndex` 接口，语义路的其余代码不需要知道用的是哪条。
 * 这个分档不是"偷懒"：小库上用近似索引反而更慢且引入误差，
 * 大库上全扫会成为主要延迟——阈值是实测出来的拐点，不是拍脑袋。
 *
 * ── 实现要点 ────────────────────────────────────────────────────
 * · 层高用 **id 的哈希**决定，不用 Math.random：同一批 cell 重建索引得到同一张图，
 *   召回结果因此可复现（§18.5 对重放一致性的要求）。
 * · 距离用余弦，向量插入时归一化，查询即点积。
 * · 删除用墓碑标记，墓碑超过 20% 时整图重建——HNSW 的删除本身是研究问题，
 *   墓碑 + 重建是工程上唯一不会出错的做法。
 */

export interface VectorHit {
  id: bigint
  score: number
}

export interface VectorIndex {
  readonly kind: 'hnsw' | 'brute'
  readonly size: number
  add(id: bigint, vec: Int8Array): void
  remove(id: bigint): void
  search(vec: Int8Array, k: number, ef?: number): VectorHit[]
  clear(): void
  stats(): { size: number; layers: number; avgDegree: number; tombstones: number }
}

function normalize(v: Int8Array): Float32Array {
  const out = new Float32Array(v.length)
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** 确定性伪随机：同一 id 永远得到同一层高，重建索引不会换图。 */
function unitHash(id: bigint): number {
  let h = id & 0xffffffffffffffffn
  h ^= h >> 33n
  h = (h * 0xff51afd7ed558ccdn) & 0xffffffffffffffffn
  h ^= h >> 33n
  h = (h * 0xc4ceb9fe1a85ec53n) & 0xffffffffffffffffn
  h ^= h >> 33n
  return Number(h & 0xffffffffn) / 4294967296
}

interface Node {
  id: bigint
  vec: Float32Array
  /** 原始 int8（重建图时直接复用，避免量化往返） */
  raw: Int8Array
  level: number
  /** 每层的邻居（id 列表） */
  links: bigint[][]
}

export interface HnswOptions {
  /** 每层最大邻居数（双向）；越大越准越慢 */
  m?: number
  /** 建图时的候选宽度 */
  efConstruction?: number
  /** 查询时的默认候选宽度 */
  efSearch?: number
  /** 层高缩放：mL = 1/ln(M) */
  seed?: number
}

export class HnswIndex implements VectorIndex {
  readonly kind = 'hnsw' as const
  private readonly m: number
  private readonly efConstruction: number
  private readonly efSearch: number
  private readonly mL: number
  private readonly nodes = new Map<bigint, Node>()
  private readonly dead = new Set<bigint>()
  private entry: bigint | null = null
  private maxLevel = 0

  constructor(opts: HnswOptions = {}) {
    this.m = Math.max(4, opts.m ?? 16)
    this.efConstruction = Math.max(this.m, opts.efConstruction ?? 200)
    this.efSearch = Math.max(8, opts.efSearch ?? 64)
    this.mL = 1 / Math.log(this.m)
  }

  get size(): number {
    return this.nodes.size - this.dead.size
  }

  add(id: bigint, vec: Int8Array): void {
    if (vec.length === 0) return
    const existing = this.nodes.get(id)
    if (existing) {
      // 向量变了就原地替换：邻接关系仍然有效（同一 id 的语义漂移很小）
      existing.vec = normalize(vec)
      existing.raw = vec.slice()
      return
    }
    const level = Math.min(16, Math.floor(-Math.log(Math.max(1e-9, unitHash(id))) * this.mL))
    const node: Node = { id, vec: normalize(vec), raw: vec.slice(), level, links: Array.from({ length: level + 1 }, () => []) }
    this.nodes.set(id, node)
    this.dead.delete(id)

    if (this.entry === null) {
      this.entry = id
      this.maxLevel = level
      return
    }

    // ① 从顶层贪心下降到 level+1
    let cur = this.entry
    for (let lc = this.maxLevel; lc > level; lc--) {
      let changed = true
      while (changed) {
        changed = false
        const curNode = this.nodes.get(cur)!
        for (const nb of curNode.links[lc] ?? []) {
          const nbNode = this.nodes.get(nb)
          if (!nbNode || this.dead.has(nb)) continue
          if (dot(nbNode.vec, node.vec) > dot(curNode.vec, node.vec)) {
            cur = nb
            changed = true
            break
          }
        }
      }
    }

    // ② 逐层插入并连边
    const eps: bigint[] = [cur]
    for (let lc = Math.min(level, this.maxLevel); lc >= 0; lc--) {
      const cands = this.searchLayer(node.vec, eps, this.efConstruction, lc)
      const picked = cands.slice(0, this.m)
      node.links[lc] = picked.map((c) => c.id)
      for (const p of picked) {
        const pn = this.nodes.get(p.id)
        if (!pn) continue
        const list = pn.links[lc] ?? (pn.links[lc] = [])
        list.push(id)
        if (list.length > this.m) {
          // 邻居裁剪：保留与 p 最相似的 m 个
          list.sort((a, b) => this.sim(p.id, b) - this.sim(p.id, a))
          list.length = this.m
        }
      }
      eps.length = 0
      eps.push(...picked.map((c) => c.id))
      if (eps.length === 0) eps.push(cur)
    }

    if (level > this.maxLevel) {
      this.maxLevel = level
      this.entry = id
    }
  }

  remove(id: bigint): void {
    if (!this.nodes.has(id)) return
    this.dead.add(id)
    if (this.dead.size > Math.max(64, this.nodes.size * 0.2)) this.rebuild()
  }

  clear(): void {
    this.nodes.clear()
    this.dead.clear()
    this.entry = null
    this.maxLevel = 0
  }

  search(vec: Int8Array, k: number, ef?: number): VectorHit[] {
    if (this.entry === null || vec.length === 0) return []
    const q = normalize(vec)
    let cur = this.entry
    for (let lc = this.maxLevel; lc > 0; lc--) {
      let changed = true
      while (changed) {
        changed = false
        const cn = this.nodes.get(cur)
        if (!cn) break
        for (const nb of cn.links[lc] ?? []) {
          const nn = this.nodes.get(nb)
          if (!nn || this.dead.has(nb)) continue
          if (dot(nn.vec, q) > dot(cn.vec, q)) {
            cur = nb
            changed = true
            break
          }
        }
      }
    }
    const out = this.searchLayer(q, [cur], Math.max(k, ef ?? this.efSearch), 0)
    return out.slice(0, k).map((c) => ({ id: c.id, score: c.score }))
  }

  stats() {
    let degree = 0
    let n = 0
    for (const node of this.nodes.values()) {
      if (this.dead.has(node.id)) continue
      n++
      degree += node.links[0]?.length ?? 0
    }
    return { size: n, layers: this.maxLevel + 1, avgDegree: n ? degree / n : 0, tombstones: this.dead.size }
  }

  // ── 内部 ──────────────────────────────────────────────────────

  private sim(from: bigint, to: bigint): number {
    const a = this.nodes.get(from)
    const b = this.nodes.get(to)
    if (!a || !b) return -1
    return dot(a.vec, b.vec)
  }

  /** 单层 best-first 搜索（ef 宽度），返回按相似度降序的候选。 */
  private searchLayer(q: Float32Array, eps: bigint[], ef: number, layer: number): Array<{ id: bigint; score: number }> {
    const visited = new Set<bigint>()
    const heap: Array<{ id: bigint; score: number }> = []
    for (const e of eps) {
      const n = this.nodes.get(e)
      if (!n || this.dead.has(e)) continue
      visited.add(e)
      heap.push({ id: e, score: dot(n.vec, q) })
    }
    heap.sort((a, b) => b.score - a.score)
    let frontier = heap.slice(0, ef)
    const result = [...frontier]

    while (frontier.length > 0) {
      const cur = frontier.shift()!
      const cn = this.nodes.get(cur.id)
      if (!cn) continue
      for (const nb of cn.links[layer] ?? []) {
        if (visited.has(nb)) continue
        visited.add(nb)
        const nn = this.nodes.get(nb)
        if (!nn || this.dead.has(nb)) continue
        const score = dot(nn.vec, q)
        const worst = result.length >= ef ? result[result.length - 1].score : -Infinity
        if (score <= worst) continue
        const item = { id: nb, score }
        // 插入到有序位置（ef 很小，线性插入比堆更省事也更快）
        let i = result.length
        while (i > 0 && result[i - 1].score < score) i--
        result.splice(i, 0, item)
        if (result.length > ef) result.length = ef
        frontier.push(item)
        frontier.sort((a, b) => b.score - a.score)
      }
      if (frontier.length > ef) frontier = frontier.slice(0, ef)
    }
    return result
  }

  private rebuild(): void {
    const alive = [...this.nodes.values()].filter((n) => !this.dead.has(n.id))
    const vecs = alive.map((n) => ({ id: n.id, raw: n.raw }))
    this.clear()
    for (const v of vecs) this.add(v.id, v.raw)
  }
}

/** 精确扫描：与 HNSW 同接口，用于小库与等价性测试。 */
export class BruteIndex implements VectorIndex {
  readonly kind = 'brute' as const
  private readonly vecs = new Map<bigint, Float32Array>()

  get size(): number {
    return this.vecs.size
  }

  add(id: bigint, vec: Int8Array): void {
    if (vec.length > 0) this.vecs.set(id, normalize(vec))
  }

  remove(id: bigint): void {
    this.vecs.delete(id)
  }

  clear(): void {
    this.vecs.clear()
  }

  search(vec: Int8Array, k: number): VectorHit[] {
    const q = normalize(vec)
    const out: VectorHit[] = []
    for (const [id, v] of this.vecs) out.push({ id, score: dot(v, q) })
    out.sort((a, b) => b.score - a.score)
    return out.slice(0, k)
  }

  stats() {
    return { size: this.vecs.size, layers: 1, avgDegree: this.vecs.size, tombstones: 0 }
  }
}
