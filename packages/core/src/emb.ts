/**
 * 向量矩阵（v0.5.2，D5 的语义路那一半）。
 *
 * ── 为什么不能靠 SQL 列 ───────────────────────────────────────────
 * `emb` 只存在 MC03 blob 里，没有列。方案原本想"只读向量列"，但实测发现：
 * 给它加一列 = 每条 cell 多 128 B，而整条 cell 才 341 B——存储比会从 0.839
 * 直接涨到 1.1 以上，等于用一个被验收过的指标去换一个没被验收过的指标。
 *
 * ── 所以：内存矩阵 ────────────────────────────────────────────────
 * 和 SDR 倒排同一个思路：懒构建、增量维护、超预算退化为全扫并上报。
 * 但这里的收益比倒排更大，因为它顺手解决了**内存布局**问题：
 *
 *   forEachCell + 每条一个 Int8Array  →  10 万次指针跳转 + 10 万次解码
 *   一块连续的 Int8Array              →  顺序扫描，10 万 × 128 次乘加 ≈ 1 ms
 *
 * 冷层向量（pq32 之后 32 维）在**写入索引时**就展开到统一维度，
 * 用的是与 `cosine()` 完全相同的 `expandEmb`——所以索引给出的分数
 * 与逐条 `cosine()` 逐位相同，不是"近似索引"。
 */

/**
 * 把 PQ 压缩后的短向量展开到目标维度。
 *
 * 从 recall.ts 移出来（v0.5.2）：现在有两个调用方——打分路径与向量矩阵，
 * 它们必须用**同一份**展开逻辑，否则"索引算的分"与"逐条算的分"会不一致，
 * 而这种不一致只在冷层出现，最难发现。
 */
export function expandEmb(v: Int8Array, dim: number): Int8Array {
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

export interface EmbIndexStats {
  cells: number
  dim: number
  bytes: number
  disabled: boolean
}

/**
 * 定长向量矩阵。稠密下标 + 连续缓冲。
 *
 * 删除留墓碑（`ids[d] = 0n`）而不是压缩缓冲：压缩要把后面所有行前移，
 * 一次删除就是 O(n·dim) 的拷贝。删除是低频操作，留墓碑更划算。
 */
export class EmbIndex {
  private buf: Int8Array
  private norms: Float32Array
  private readonly ids: bigint[] = []
  private readonly denseOf = new Map<bigint, number>()
  private live = 0
  private disabled = false

  constructor(
    readonly dim: number,
    private readonly maxCells = 200_000,
  ) {
    const cap = Math.min(1024, maxCells)
    this.buf = new Int8Array(cap * dim)
    this.norms = new Float32Array(cap)
  }

  get size(): number {
    return this.live
  }

  add(cellId: bigint, emb: Int8Array | null): void {
    if (this.disabled || !emb || emb.length === 0) return
    const v = emb.length === this.dim ? emb : expandEmb(emb, this.dim)
    const existing = this.denseOf.get(cellId)
    const d = existing ?? this.ids.length
    if (existing === undefined) {
      if (this.live >= this.maxCells) {
        this.clear()
        this.disabled = true
        return
      }
      this.ensure(d + 1)
      this.ids.push(cellId)
      this.denseOf.set(cellId, d)
      this.live++
    }
    this.buf.set(v, d * this.dim)
    let sq = 0
    for (let i = 0; i < this.dim; i++) sq += v[i] * v[i]
    this.norms[d] = Math.sqrt(sq)
  }

  remove(cellId: bigint): void {
    const d = this.denseOf.get(cellId)
    if (d === undefined) return
    this.denseOf.delete(cellId)
    this.ids[d] = 0n
    this.norms[d] = 0
    this.live--
  }

  /**
   * 全库余弦。`visit` 只收到 score > 0 的条目——与 `cosine()` 的返回口径一致
   * （长度为 0 或零向量时它返回 0，这里直接跳过）。
   */
  scan(q: Int8Array, visit: (id: bigint, score: number) => void): void {
    if (this.disabled) return
    const dim = this.dim
    const qv = q.length === dim ? q : expandEmb(q, dim)
    let qs = 0
    for (let i = 0; i < dim; i++) qs += qv[i] * qv[i]
    if (qs === 0) return
    const qn = Math.sqrt(qs)
    const buf = this.buf
    const norms = this.norms
    for (let d = 0; d < this.ids.length; d++) {
      const nn = norms[d]
      if (nn === 0) continue
      const base = d * dim
      let dot = 0
      for (let i = 0; i < dim; i++) dot += qv[i] * buf[base + i]
      if (dot === 0) continue
      const s = dot / (qn * nn)
      if (s > 0) visit(this.ids[d], s)
    }
  }

  clear(): void {
    const cap = Math.min(1024, this.maxCells)
    this.buf = new Int8Array(cap * this.dim)
    this.norms = new Float32Array(cap)
    this.ids.length = 0
    this.denseOf.clear()
    this.live = 0
  }

  reset(): void {
    this.clear()
    this.disabled = false
  }

  stats(): EmbIndexStats {
    return {
      cells: this.live,
      dim: this.dim,
      bytes: this.ids.length * this.dim + this.ids.length * 4,
      disabled: this.disabled,
    }
  }

  private ensure(rows: number): void {
    if (rows * this.dim <= this.buf.length) return
    const cap = Math.max(rows, this.buf.length / this.dim) * 2
    const nextBuf = new Int8Array(cap * this.dim)
    nextBuf.set(this.buf)
    const nextNorms = new Float32Array(cap)
    nextNorms.set(this.norms)
    this.buf = nextBuf
    this.norms = nextNorms
  }
}
