/**
 * SDR 代数（v0.2 修正版，对应文档 §6.5 / §15.5）
 *
 * 稀疏集合语义，不是密集位向量语义：
 *   bind(f, role)     = permute(f, Π_role)      角色置换，不是 XOR
 *   unbind(x, role)   = permuteInv(x, Π_role)   逆置换，精确可逆
 *   bundle(xs)        = ⋃ xs，超密度 cap 才 kWTA  并集，不是多数表决
 *   jaccard(a,b)      = |a∩b| / |a∪b|           对称：cell ↔ cell（去重/合并）
 *   containment(q,c)  = |q∩c| / |q|             非对称：query → cell（检索）
 *
 * 三条不可违反的约束（见 §6.5）：
 *   1. 解绑只能用 argmax，不能用绝对阈值（n=24 时区分度只有 2.7×）
 *   2. bundle 之间的噪声底约 0.047，不是 0.002
 *   3. n>30 触发 WTA 后不可逆，被裁掉的位对应的成分无法解绑
 */

export type Sdr = Uint32Array

export const SIM_FLOOR = 0.09
export const BUNDLE_CAP = 0.12

function popcountWord(x0: number): number {
  let x = x0
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

export interface SdrSpaceOptions {
  dim?: number
  k?: number
  seed?: number
}

/**
 * 一个 SdrSpace 绑定一组 (dim, k)。维度是布局项，改了必须重建库（§12.8）。
 * 实例内部对 role 置换表做缓存——置换表生成是 O(D) Fisher-Yates，比一次 recall 还贵。
 */
export class SdrSpace {
  readonly dim: number
  readonly k: number
  readonly words: number
  readonly seed: number
  private readonly permCache = new Map<string, Uint16Array>()

  constructor(opts: SdrSpaceOptions = {}) {
    this.dim = opts.dim ?? 2048
    this.k = opts.k ?? 8
    if (this.dim % 32 !== 0) throw new Error(`sdrDim 必须是 32 的倍数，收到 ${this.dim}`)
    if (this.k < 1 || this.k > this.dim / 4) throw new Error(`sdrK 越界: ${this.k}`)
    this.words = this.dim / 32
    this.seed = opts.seed ?? 0x9e3779b9
  }

  zero(): Sdr {
    return new Uint32Array(this.words)
  }

  /** 稳定身份码。这是身份码，不是语义码——语义相似性由 E（embedding）承担。 */
  identity(token: string, k = this.k, seed = this.seed): Sdr {
    const out = this.zero()
    let h = seed
    for (let i = 0; i < token.length; i++) {
      h = Math.imul(h ^ token.charCodeAt(i), 0x01000193) >>> 0
    }
    let placed = 0
    let guard = 0
    while (placed < k) {
      h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0
      const bit = h % this.dim
      const w = bit >>> 5
      const m = 1 << (bit & 31)
      if ((out[w] & m) === 0) {
        out[w] |= m
        placed++
      }
      // 理论上一百万年也撞不到，但死循环比慢循环可怕
      if (++guard > this.dim * 8) throw new Error('identity: 无法放置足够的位，检查 k 与 dim')
    }
    return out
  }

  /** 角色置换表。必须哈希全部字——只哈希前两个字会让所有角色塌缩成同一张表（D-03c）。 */
  permTable(key: Sdr): Uint16Array {
    let h = 0x811c9dc5
    for (let i = 0; i < this.words; i++) h = Math.imul(h ^ key[i], 0x01000193) >>> 0
    let s = h || 1
    const p = new Uint16Array(this.dim)
    for (let i = 0; i < this.dim; i++) p[i] = i
    for (let i = this.dim - 1; i > 0; i--) {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      const j = s % (i + 1)
      const t = p[i]
      p[i] = p[j]
      p[j] = t
    }
    return p
  }

  /** 按角色名取置换表（带缓存）。角色名 → identity → permTable，跨进程稳定。 */
  role(roleName: string): Uint16Array {
    const hit = this.permCache.get(roleName)
    if (hit) return hit
    const p = this.permTable(this.identity('ROLE:' + roleName))
    this.permCache.set(roleName, p)
    return p
  }

  permute(a: Sdr, p: Uint16Array): Sdr {
    const o = this.zero()
    for (let i = 0; i < this.dim; i++) {
      if ((a[i >>> 5] >>> (i & 31)) & 1) {
        const j = p[i]
        o[j >>> 5] |= 1 << (j & 31)
      }
    }
    return o
  }

  permuteInv(a: Sdr, p: Uint16Array): Sdr {
    const inv = new Uint16Array(this.dim)
    for (let i = 0; i < this.dim; i++) inv[p[i]] = i
    const o = this.zero()
    for (let i = 0; i < this.dim; i++) {
      if ((a[i >>> 5] >>> (i & 31)) & 1) {
        const j = inv[i]
        o[j >>> 5] |= 1 << (j & 31)
      }
    }
    return o
  }

  /** 绑定 = 角色置换。参数顺序是 (填充值, 角色置换表)，不可交换。 */
  bind(filler: Sdr, role: Uint16Array): Sdr {
    return this.permute(filler, role)
  }

  unbind(bundle: Sdr, role: Uint16Array): Sdr {
    return this.permuteInv(bundle, role)
  }

  /** 叠加 = 并集；超密度上限才 kWTA。不是多数表决（D-01）。 */
  bundle(items: readonly Sdr[], cap = BUNDLE_CAP): Sdr {
    const o = this.zero()
    for (const it of items) for (let i = 0; i < this.words; i++) o[i] |= it[i]
    const limit = Math.floor(cap * this.dim)
    return this.popcount(o) <= limit ? o : this.kWTA(o, limit)
  }

  kWTA(a: Sdr, limit: number): Sdr {
    const idx: number[] = []
    for (let i = 0; i < this.dim; i++) if ((a[i >>> 5] >>> (i & 31)) & 1) idx.push(i)
    idx.sort((x, y) => x - y) // 稳定序，保证确定性
    const o = this.zero()
    for (let i = 0; i < Math.min(limit, idx.length); i++) {
      const b = idx[i]
      o[b >>> 5] |= 1 << (b & 31)
    }
    return o
  }

  popcount(a: Sdr): number {
    let n = 0
    for (let i = 0; i < this.words; i++) n += popcountWord(a[i])
    return n
  }

  /** Jaccard。对称比较用（cell↔cell 去重）。不是 1 − hamming/D（D-02）。 */
  sim(a: Sdr, b: Sdr): number {
    // 先只算交集并早退：噪声场景下 inter 常为 0，能省掉两次全码 popcount。
    // （试过"三累加器单趟"，在本机反而慢一倍——JIT 对这个循环更不友好，实测数据见 scripts/bench.mjs）
    let inter = 0
    for (let i = 0; i < this.words; i++) inter += popcountWord(a[i] & b[i])
    if (inter === 0) return 0
    const union = this.popcount(a) + this.popcount(b) - inter
    return union === 0 ? 0 : inter / union
  }

  /** containment。非对称检索用（query → cell）。完全包含时为 1，不被尺寸差压死。 */
  containment(q: Sdr, c: Sdr): number {
    let inter = 0
    let nq = 0
    for (let i = 0; i < this.words; i++) {
      const x = q[i]
      inter += popcountWord(x & c[i])
      nq += popcountWord(x)
    }
    if (nq === 0) return 0
    return inter / nq
  }

  /** 固定线性标定：噪声底 0.09 → 0，完全命中 → 1。不可用 min-max（会让跨轮不可比）。 */
  simNorm(q: Sdr, c: Sdr): number {
    const v = (this.containment(q, c) - SIM_FLOOR) / (1 - SIM_FLOOR)
    return Math.min(1, Math.max(0, v))
  }

  /** 打包成 256 B（dim=2048）小端字节，用于 cell 变长体。 */
  pack(a: Sdr): Uint8Array {
    const out = new Uint8Array(this.words * 4)
    const dv = new DataView(out.buffer)
    for (let i = 0; i < this.words; i++) dv.setUint32(i * 4, a[i], true)
    return out
  }

  unpack(bytes: Uint8Array): Sdr {
    const need = this.words * 4
    if (bytes.length < need) throw new Error(`SDR 字节不足: ${bytes.length} < ${need}`)
    const dv = new DataView(bytes.buffer, bytes.byteOffset, need)
    const out = this.zero()
    for (let i = 0; i < this.words; i++) out[i] = dv.getUint32(i * 4, true)
    return out
  }

  /**
   * 容量自检：按 §6.5 的实测口径，n 项叠加后能否 rank-1 解绑。
   * 工程建议上限 24。超过不报错，只是退化（这是可测的退化，不是 bug）。
   */
  measureCapacity(n: number): { rank1: number; minCorrect: number; maxWrong: number } {
    const roles = Array.from({ length: n }, (_, i) => this.role('CAP_R' + i))
    const fills = Array.from({ length: n }, (_, i) => this.identity('CAP_F' + i))
    const p = this.bundle(roles.map((r, i) => this.bind(fills[i], r)))
    let rank1 = 0
    let minCorrect = 1
    let maxWrong = 0
    for (let i = 0; i < n; i++) {
      const q = this.unbind(p, roles[i])
      const scored = fills.map((f, j) => ({ j, s: this.sim(q, f) })).sort((x, y) => y.s - x.s)
      if (scored[0].j === i) rank1++
      minCorrect = Math.min(minCorrect, scored.find((s) => s.j === i)!.s)
      for (const s of scored) if (s.j !== i) maxWrong = Math.max(maxWrong, s.s)
    }
    return { rank1, minCorrect, maxWrong }
  }
}

export const DEFAULT_SPACE = new SdrSpace({ dim: 2048, k: 8 })
