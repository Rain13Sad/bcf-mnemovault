/**
 * 确定性哈希。cell_id 必须确定性生成，否则同一事件重放会得到不同 id，破坏幂等（§15.6）。
 *
 * 实现说明：文档指定 blake3，此处用纯 JS 的 FNV-1a 64（BigInt）作为默认实现，
 * 目的是让 core 在 host / 浏览器 / 测试三处都能同步调用、无原生依赖。
 * 生产环境如需 blake3，替换 `hash64` 的 body 即可（接口不变），
 * 但**替换即等于换库**——旧 cell_id 全部失效，必须 /mnemo rebuild。
 */

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK64 = 0xffffffffffffffffn

export function hash64(input: string | Uint8Array): bigint {
  const bytes = typeof input === 'string' ? utf8(input) : input
  let h = FNV_OFFSET
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i])
    h = (h * FNV_PRIME) & MASK64
  }
  // 尾部扩散，避免短输入低位偏置
  h ^= h >> 33n
  h = (h * 0xff51afd7ed558ccdn) & MASK64
  h ^= h >> 33n
  return h
}

/** 128 位扩展，用于需要更低碰撞率的场合（残差去重键、快照 id）。 */
export function hash128(input: string | Uint8Array): bigint {
  const a = hash64(input)
  const b = hash64(typeof input === 'string' ? input + '\u0000salt' : concatSalt(input))
  return (a << 64n) | b
}

function concatSalt(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 5)
  out.set(bytes, 0)
  out.set([0, 0x73, 0x61, 0x6c, 0x74], bytes.length)
  return out
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function toHex(n: bigint, width = 16): string {
  return n.toString(16).padStart(width, '0').slice(-width)
}

export function bytesToHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export function hexToBytes(h: string): Uint8Array {
  const n = h.length >>> 1
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 32 B 摘要（残差 sha 字段）。 */
export function digest32(input: string | Uint8Array): Uint8Array {
  const out = new Uint8Array(32)
  const hi = hash128(input)
  for (let i = 0; i < 16; i++) {
    out[15 - i] = Number((hi >> BigInt(i * 8)) & 0xffn)
    out[31 - i] = Number((hi >> BigInt((i + 16) * 8)) & 0xffn)
  }
  return out
}

/** MRS 里用的 4 位 id 前缀（§9.4：长度在会话首轮确定，整会话不变）。 */
export function shortId(cellId: bigint, width = 4): string {
  return toHex(cellId, 16).slice(-width)
}
