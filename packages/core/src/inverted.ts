/**
 * SDR 倒排索引（v0.5.2，对应方案 §3.1 / D4 / D5）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────
 * `ingest` 为了找"最像的那条"要全表比一遍 Jaccard，`findConflict` 再全表比一遍；
 * `recall` 的符号路与时间路又各扫一遍。于是**每轮耗时随库规模线性增长**：
 * 实测 200 轮 3.24 ms/轮、400 轮 4.76、800 轮 9.45 —— 造库总耗时 O(T²)。
 *
 * ── 为什么是倒排而不是"再来一次 ANN" ──────────────────────────────
 * 去重与冲突判定要的是**精确**结论（"这两条是同一件事吗"），近似索引给不了。
 * 而 SDR 的稀疏性让精确倒排反而更便宜：2048 维、k=8..64，实测 popcount
 * 中位数 40（密度 1.93%），一次查询只碰 `|q|` 个 posting list。
 *
 * ── 阈值不是拍的，是算的 ──────────────────────────────────────────
 * 候选集占比服从泊松尾 P(X ≥ τ) = 1 − e^(−λ)·Σ(λⁱ/i!)，λ = |q|·|c|/dim ≈ 0.76。
 * 但**阈值必须由"要判定的相似度门限"反推**，否则会静默漏召回：
 *
 *   Jaccard  J = o/(|a|+|b|−o)  ⟹  o = J(|a|+|b|)/(1+J) ≥ J·|a|/(1+J)
 *   containment C = o/|a|       ⟹  o = C·|a|
 *
 * 于是 `minOverlapForJaccard/Containment` 给的是**必要条件**（不是启发式）：
 * 凡是满足门限的 pair 一定在候选集里，所以索引**不损失召回**，
 * 只把"绝不可能满足门限"的 cell 提前排除。这一点和 ANN 有本质区别，
 * 也是这里敢把它接进去重路径（写错会丢数据）的理由。
 *
 * ── 为什么在内存里而不是落表 ──────────────────────────────────────
 * 方案原文设想落 `idx_sdr` 表。实测之后改成内存：10 万 cell × 40 bit = **400 万行**，
 * 而重启时把 400 万行读回内存，比"一次全扫解码 10 万条 blob"更慢
 * （前者要建 400 万个对象，后者是顺序解码）。落表只在"进程频繁重启且库极大"时才有优势，
 * 而那种场景下 `open()` 本来就要做一次完整性检查。
 * 所以：内存倒排 + **懒构建**（首次用到时一次全扫，耗时上报 `RuntimeStatus`），
 * 增量维护，超预算（`config.sdrIndex.maxCells`）时整体退化为全扫并如实上报。
 */

import type { Sdr, SdrSpace } from './sdr.js'

/** 遍历 SDR 里所有置位（bit 下标，0..dim-1）。 */
export function forEachBit(sdr: Sdr, fn: (bit: number) => void): void {
  for (let w = 0; w < sdr.length; w++) {
    let x = sdr[w]
    while (x !== 0) {
      // 取最低置位：`x & -x`，再用 31 - clz 得到下标
      const low = x & -x
      fn((w << 5) + (31 - Math.clz32(low)))
      x ^= low
    }
  }
}

/**
 * Jaccard 门限 → 最小重叠位数的**必要**条件。
 *
 * 由 `o = J(|a|+|b|)/(1+J)` 且 `|b| ≥ 1` 得 `o > J·n/(1+J)`（n = 本方位数）。
 * 取 floor+1 保证严格大于。这不是"经验阈值"：任何 J ≥ 门限的 pair 必然 o ≥ 返回值，
 * 所以候选集是真实候选的**超集**。
 */
export function minOverlapForJaccard(size: number, jaccard: number): number {
  if (size <= 0) return 1
  return Math.max(1, Math.floor((jaccard * size) / (1 + jaccard)) + 1)
}

/** containment 门限 → 最小重叠位数：`C = o/|q|` ⟹ `o = C·|q|`。同样是必要条件。 */
export function minOverlapForContainment(size: number, containment: number): number {
  if (size <= 0) return 1
  return Math.max(1, Math.floor(containment * size) + 1)
}

export interface InvertedStats {
  /** 索引里有多少条 cell */
  cells: number
  /** 维度（bit 数） */
  bits: number
  /** posting 条目总数 = Σ 每条 cell 的位数 */
  postings: number
  /** 估算内存字节（posting 4 B/条 + 索引表开销） */
  bytes: number
  /** 是否因超预算而停用 */
  disabled: boolean
}

/** 候选：带重叠位数与自身位数，调用方可以**不解 blob** 直接算出精确 Jaccard。 */
export interface SdrCandidate {
  id: bigint
  /** 与查询共享的位数 */
  overlap: number
  /** 该 cell 的位数（|b|） */
  size: number
  /** 该 cell 的 kind（去重只在同 kind 之间做） */
  kind: number
}

export interface InvertedIndex {
  readonly space: SdrSpace
  /**
   * 与 query 共享 ≥ minOverlap 个位的 cell。
   *
   * 返回**重叠位数**而不只是 id：Jaccard = o/(|a|+|b|−o)，而 |a|、|b|、o 三者
   * 索引都知道。于是去重可以在**完全不回表**的情况下算出精确相似度，
   * 只在真正要合并时才 `getCell` 一次。v0.5.2 第一版只返回 id，
   * 结果 400 个候选就要 400 次 blob 解码——那是这一版最贵的遗留。
   */
  candidatesByOverlap(sdr: Sdr, minOverlap: number): SdrCandidate[]
  add(cellId: bigint, sdr: Sdr, kind?: number): void
  remove(cellId: bigint, sdr: Sdr): void
  has(cellId: bigint): boolean
  clear(): void
  stats(): InvertedStats
}

/**
 * 位 → 倒排表。
 *
 * posting 里存的是**稠密整数**而不是 bigint：10 万 cell × 40 bit 用 bigint 要 ~63 MB，
 * 用稠密下标（V8 的 SMI 数组）约 16 MB。差值不是微优化——它决定了默认预算
 * 是 32 MB 还是 64 MB，也就决定了"10 万 cell 能不能默认开着索引"。
 */
export class BitInvertedIndex implements InvertedIndex {
  private readonly postings = new Map<number, number[]>()
  private readonly ids: bigint[] = []
  private readonly denseOf = new Map<bigint, number>()
  private readonly bitsOf: number[][] = []
  private readonly sizes: number[] = []
  private readonly kinds: number[] = []
  /** 计数用的复用缓冲（按需增长，见 ensureScratch） */
  private scratch = new Int32Array(1024)
  private touched: number[] = []
  private disabled = false
  private postingsCount = 0

  constructor(
    readonly space: SdrSpace,
    private readonly maxCells = 200_000,
  ) {}

  get size(): number {
    return this.denseOf.size
  }

  add(cellId: bigint, sdr: Sdr, kind = 0): void {
    if (this.disabled) return
    const bits: number[] = []
    forEachBit(sdr, (b) => bits.push(b))

    const existing = this.denseOf.get(cellId)
    if (existing !== undefined) {
      // 同 id 重复写入：SDR 没变就什么都不做；变了就在原稠密槽位上换位
      const prev = this.bitsOf[existing]
      if (prev && prev.length === bits.length && prev.every((b, i) => b === bits[i])) return
      this.detach(existing, prev ?? [])
      this.bitsOf[existing] = bits
      this.sizes[existing] = bits.length
      this.kinds[existing] = kind
      this.attach(existing, bits)
      return
    }

    if (this.denseOf.size >= this.maxCells) {
      // 超预算：整体停用，调用方退回全扫。**不静默降级**——stats().disabled 会被上报。
      this.clear()
      this.disabled = true
      return
    }
    const dense = this.ids.length
    this.ids.push(cellId)
    this.denseOf.set(cellId, dense)
    this.bitsOf[dense] = bits
    this.sizes[dense] = bits.length
    this.kinds[dense] = kind
    this.attach(dense, bits)
    this.ensureScratch(dense + 1)
  }

  private attach(dense: number, bits: number[]): void {
    for (const b of bits) {
      const list = this.postings.get(b)
      if (list) list.push(dense)
      else this.postings.set(b, [dense])
      this.postingsCount++
    }
  }

  private detach(dense: number, bits: number[]): void {
    for (const b of bits) {
      const list = this.postings.get(b)
      if (!list) continue
      const i = list.indexOf(dense)
      if (i >= 0) {
        list.splice(i, 1)
        this.postingsCount--
      }
      if (list.length === 0) this.postings.delete(b)
    }
  }

  private ensureScratch(n: number): void {
    if (n <= this.scratch.length) return
    const next = new Int32Array(Math.max(n, this.scratch.length * 2))
    next.set(this.scratch)
    this.scratch = next
  }

  remove(cellId: bigint, _sdr?: Sdr): void {
    const dense = this.denseOf.get(cellId)
    if (dense === undefined) return
    const bits = this.bitsOf[dense] ?? []
    this.detach(dense, bits)
    this.bitsOf[dense] = []
    // ids[dense] 留成 0n 作为墓碑：稠密下标不复用，避免"删了又加"让旧 posting 复活
    this.ids[dense] = 0n
    this.denseOf.delete(cellId)
  }

  has(cellId: bigint): boolean {
    return this.denseOf.has(cellId)
  }

  clear(): void {
    this.postings.clear()
    this.ids.length = 0
    this.denseOf.clear()
    this.bitsOf.length = 0
    this.touched = []
    this.postingsCount = 0
    this.scratch = new Int32Array(1024)
  }

  /** 重新启用（改配置后由 service 调用，重建前清掉停用标记）。 */
  reset(): void {
    this.clear()
    this.disabled = false
  }

  /**
   * 取与 sdr 共享 ≥ minOverlap 个位的 cell。
   *
   * 用一块复用的 `Int32Array` 计数、并用 `touched` 只清理碰过的槽位：
   * 每次查询都 `new Map()` 在 10 万 cell 下会产生几十万临时对象，
   * 这条路径在每次 ingest / 每次 recall 都会走，GC 压力会盖过收益。
   */
  candidatesByOverlap(sdr: Sdr, minOverlap: number): SdrCandidate[] {
    if (this.disabled || this.denseOf.size === 0) return []
    const threshold = Math.max(1, minOverlap)
    const hit: number[] = []
    this.touched.length = 0
    forEachBit(sdr, (b) => {
      const list = this.postings.get(b)
      if (!list) return
      for (let i = 0; i < list.length; i++) {
        const d = list[i]
        if (d >= this.scratch.length) continue
        const n = ++this.scratch[d]
        if (n === 1) this.touched.push(d)
        if (n === threshold) hit.push(d)
      }
    })
    // 真正的重叠位数要等所有位走完才知道——第一版在这里直接写了 `threshold`，
    // 于是所有候选的 overlap 都等于门限，Jaccard 被算成一个小得多的值，去重静默失效
    // （测试当场抓住：同一句说两次产生了两个 cell）。
    const out: SdrCandidate[] = []
    for (const d of hit) {
      out.push({ id: this.ids[d], overlap: this.scratch[d], size: this.sizes[d] ?? 0, kind: this.kinds[d] ?? 0 })
    }
    for (const d of this.touched) this.scratch[d] = 0
    return out
  }

  stats(): InvertedStats {
    return {
      cells: this.denseOf.size,
      bits: this.space.dim,
      postings: this.postingsCount,
      bytes: this.postingsCount * 4 + this.denseOf.size * 40,
      disabled: this.disabled,
    }
  }
}
