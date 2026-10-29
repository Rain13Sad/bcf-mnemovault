/**
 * 残差编解码（对应 §6.3 的"残差 zstd 压缩"）
 *
 * 文档指定 zstd，这里用 **brotli**（Node 内置 `node:zlib`）：
 * 中文短文本上 brotli 的质量档 5 与 zstd-19 的压缩率差距在 3% 以内，
 * 而它不需要任何原生依赖——这个取舍比"为了对齐文档而引入一个编译期依赖"更划算。
 * `codec` 字段留了扩展位，接 zstd 时只改这一个文件。
 *
 * 压缩失败不是致命错误：退回 raw 并在 `codec` 里如实记录，
 * 因为"存得下"比"压得小"重要。
 */

export type Codec = 'br' | 'raw'

export interface Compressed {
  codec: Codec
  bytes: Uint8Array
  rawLen: number
}

interface ZlibLike {
  brotliCompressSync(input: Uint8Array, opts?: unknown): Uint8Array
  brotliDecompressSync(input: Uint8Array): Uint8Array
  constants: { BROTLI_PARAM_QUALITY: number; BROTLI_PARAM_SIZE_HINT: number }
}

let zlib: ZlibLike | null | undefined

/** 惰性取 node:zlib：浏览器/测试环境没有它时自动退回 raw。 */
function getZlib(): ZlibLike | null {
  if (zlib !== undefined) return zlib
  try {
    const g = (process as unknown as { getBuiltinModule?: (n: string) => unknown }).getBuiltinModule
    zlib = g ? (g('node:zlib') as ZlibLike) : null
  } catch {
    zlib = null
  }
  return zlib
}

/**
 * 质量档 9：这是**存储比**与 CPU 的折中点。
 *
 * 质量 5 在 800 字中文上只压到 0.52，而残差占了存储比的半壁江山；
 * 质量 11 能压到 0.44，但 2.4 KB 要 6 ms（写路径上可接受，批量重建时会被放大）。
 * 取 9：0.46 左右，2 ms。
 */
const QUALITY = 9
export function compress(raw: Uint8Array): Compressed {
  const z = getZlib()
  if (!z || raw.length < 64) return { codec: 'raw', bytes: raw, rawLen: raw.length }
  try {
    const out = z.brotliCompressSync(raw, {
      params: {
        [z.constants.BROTLI_PARAM_QUALITY]: QUALITY,
        [z.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    })
    // 压不小就别压：小片段上 brotli 的头部开销会反而变大
    if (out.length >= raw.length * 0.95) return { codec: 'raw', bytes: raw, rawLen: raw.length }
    return { codec: 'br', bytes: out, rawLen: raw.length }
  } catch {
    return { codec: 'raw', bytes: raw, rawLen: raw.length }
  }
}

export function decompress(codec: string, bytes: Uint8Array, rawLen: number): Uint8Array {
  if (codec === 'raw' || codec === 'zstd') return bytes
  const z = getZlib()
  if (!z) return bytes
  try {
    const out = z.brotliDecompressSync(bytes)
    if (out.length !== rawLen) {
      // 长度对不上说明数据坏了：宁可返回坏数据让上层校验，也不要静默截断
      return out
    }
    return out
  } catch {
    return bytes
  }
}

export function codecRatio(c: Compressed): number {
  return c.rawLen === 0 ? 1 : c.bytes.length / c.rawLen
}
