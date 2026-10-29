/**
 * MemCell 七元组 ⟨σ,E,G,Φ,A,R,τ⟩ 的二进制布局与编解码（对应 §5.1 / §6.1 / §6.2 / §15.6）
 *
 * ── MC03（v0.3）为什么要重排 ─────────────────────────────────────────
 * MC02 的固定基底是 192 B 头 + 256 B SDR 位图 + 256 B int8 向量 = 704 B。
 * 而一轮 800 字对话的原文约 2.3 KB、常产出 1–2 条命题 cell，
 * 于是"每条 cell 的定长成本"直接决定了存储比——实测 2.50×，远高于文档 0.45–0.60×。
 * 三项改动都是**无损或近无损**的重新编码，不改变任何检索语义：
 *
 *   1. 头 192 → 112 B：时间戳从 i64 降到 u48（毫秒够用 8900 年），
 *      浮点量按各自量纲降到 u16/i8/u8，槽位/边计数降到 u8（上限 255，够用）。
 *   2. SDR 从定长位图（2048 bit = 256 B）改为**稀疏索引 + 变长整数差分**：
 *      k=64 时约 100 B，且不随 sdrDim 线性膨胀。
 *   3. 向量从 int8×256 折叠到 int8×64（分组求和，随机投影的一种），
 *      语义相似度基本保持（见 bench 的 Recall@8 前后对照），省 192 B。
 *
 * 合计 704 → 约 370 B（含 6 槽 3 边）。布局版本升到 3，**旧库需 /mnemo rebuild**。
 * decodeCell 仍能读 MC02（用于迁移期的只读排查），但不再写入。
 *
 * 与文档的一处有意偏差：运行时 `sdr` 用 Uint32Array 而非 Uint8Array。
 * 位运算在 Uint8Array 上要么慢要么错（JS 的位运算按 32 位做），
 * 因此运行时保持 32 位视图，只在 encode/decode 的边界上做字节转换。
 */

import { crc32 } from './crc32.js'
import { digest32, hash64, toHex } from './hash.js'
import type { Sdr } from './sdr.js'
import { SdrSpace } from './sdr.js'

export const HEADER_SIZE = 112
export const MAGIC = 'MC03'
export const LAYOUT_VERSION = 3
/** MC02 的常量：只为兼容读取而保留。 */
export const HEADER_SIZE_V2 = 192
export const MAGIC_V2 = 'MC02'
const Q14 = 16384

export type CellKind = 0 | 1 | 2 | 3 | 4 | 5 | 6
export type CellTier = 0 | 1 | 2 | 3
export type Provenance = 0 | 1 | 2 | 3 | 4

export const KIND = {
  episodic: 0,
  semantic: 1,
  procedure: 2,
  schema: 3,
  persona: 4,
  relational: 5,
  /** 叙事：关系故事线上的节点（里程碑、日记、阶段小结）。不是事实，是"我们之间发生过什么" */
  narrative: 6,
} as const

export const KIND_NAME: Record<number, string> = {
  0: 'episodic',
  1: 'semantic',
  2: 'procedure',
  3: 'schema',
  4: 'persona',
  5: 'relational',
  6: 'narrative',
}

export const TIER_NAME: Record<number, string> = { 0: 'hot', 1: 'warm', 2: 'cold', 3: 'archive' }

export const PROV_NAME: Record<number, string> = { 0: 'u', 1: 'a', 2: 't', 3: 'w', 4: 'i' }

/** trust 按来源赋值（§19.1）。用户 240 / 工具 160 / 网络 80 / 推断 60。 */
export const TRUST_BY_PROVENANCE: Record<Provenance, number> = { 0: 240, 1: 200, 2: 160, 3: 80, 4: 60 }

export const FLAG = {
  /** bit0 有残差 */
  residual: 1 << 0,
  /** bit1 不可衰减（人格锚 / 用户 pin） */
  noDecay: 1 << 1,
  /** bit2 有争议（存在 CONTRADICTS） */
  disputed: 1 << 2,
  /** bit3 含 PII */
  pii: 1 << 3,
  /** bit4 已脱敏 */
  redacted: 1 << 4,
  /** bit5 网络来源 */
  web: 1 << 5,
  /**
   * bit6 情感记忆（闪光灯记忆）。
   * 触发条件：|valence| ≥ 0.45 或 salience ≥ 0.75。
   * 语义是"这条不许被时间抹平"——巩固期跳过情绪衰减、遗忘曲线把 S 放大 3 倍、
   * 最多降到温层。陪伴场景里，用户记住的往往不是事实，而是"那天你怎么说"。
   */
  emotional: 1 << 6,
  /** bit7 里程碑（关系叙事里的锚点：第一次、那次争吵、那个约定） */
  milestone: 1 << 7,
} as const

/** 关系类型词表（§5.3），u8 可扩展。 */
export const REL = {
  IS_A: 0x01,
  PART_OF: 0x02,
  CAUSES: 0x03,
  BEFORE: 0x04,
  SAME_AS: 0x05,
  CONTRADICTS: 0x06,
  SUPERSEDES: 0x07,
  ABOUT: 0x08,
  PREFERS: 0x09,
  ROLE_AGENT: 0x0a,
  ROLE_PATIENT: 0x0b,
  ROLE_TIME: 0x0c,
  EVIDENCE: 0x0d,
  ASSOC: 0x0e,
  EVOKES: 0x0f,
} as const

export const REL_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [v, k]),
) as Record<number, string>

/** 8 个语义槽位 + POLARITY（§7.6 的否定/肯定，作为第 9 个扩展槽）。 */
export const SLOT_ROLE = {
  AGENT: 1,
  PATIENT: 2,
  PRED: 3,
  TIME: 4,
  PLACE: 5,
  MANNER: 6,
  GOAL: 7,
  QTY: 8,
  POLARITY: 9,
} as const

export const SLOT_ROLE_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(SLOT_ROLE).map(([k, v]) => [v, k]),
) as Record<number, string>

/**
 * 记忆视角（多角度检索的抓手）。同一条记忆可以从四个角度看：
 *   fact    事实：'用户用 pnpm'         —— 中性、可验证
 *   feeling 感受：'聊到部署时他有点烦'   —— 带效价
 *   bond    关系：'我们一起熬过那次上线' —— 涉及"我们"
 *   story   故事：里程碑/日记           —— kind=6
 * 视角在写入时算好并存列，检索时可按视角过滤或加权。
 */
export type Lens = 'fact' | 'feeling' | 'bond' | 'story'

export const LENS_NAME: Record<Lens, string> = {
  fact: '事实',
  feeling: '感受',
  bond: '关系',
  story: '故事',
}

export type SlotType = 'REF' | 'LIT' | 'UNK'

export interface Slot {
  role: number
  type: SlotType
  /** REF: 8 字节 cell id 的 hex；LIT: 字面量；UNK: 空串 */
  value: string
}

export interface Edge {
  /** 目标 cell id 的低 32 位（前缀索引，§6.2）。 */
  targetPrefix: number
  rel: number
  /** i8 尺度：−128..127，弱边剪除阈值 8。 */
  weight: number
}

export interface ResidualRef {
  sha: Uint8Array
  off: bigint
  rawLen: number
}

export interface MemCell {
  cellId: bigint
  kind: CellKind
  tier: CellTier
  flags: number
  tFrom: bigint
  tTo: bigint
  tIngest: bigint
  tAccess: bigint
  accessCount: number
  stability: number
  importance: number
  valence: number
  arousal: number
  dominance: number
  salience: number
  provenance: Provenance
  trust: number
  sdr: Sdr
  emb: Int8Array | null
  slots: Slot[]
  edges: Edge[]
  residual: ResidualRef | null
  /** 双置信度（§5.4）：编码时自评 / 独立证据计数。两者禁止相乘合并。 */
  confidence: number
  support: number
  /** 话题指纹（tail 8 B 的 hex），用于情境线索键 cueMatch。 */
  topic: string
  /**
   * 双时态的事务时间一侧：这一条**什么时候不再为真**（0 = 仍然有效）。
   * 与 t_from/t_to（事件时间）配对，构成 Zep/Graphiti 式的 bi-temporal：
   * "上周我们用什么字体"（事件时间）与"上周我们**当时**认为用什么字体"（事务时间）
   * 是两个不同的问题，只存一个时间戳就答不了后一个。
   * 不进 MC02 头（头是 v0.2 定死的），作为列承载，和 support/confidence 同处。
   */
  tInvalid?: bigint
  /** 作用域键（'user:local' / 'user:<id>' / 'global'）。不进 MC02 头，列承载。 */
  scope?: string
  /** 首次写入的会话 id。情景记忆的隔离判据（§14.10）。 */
  session?: string
  /** 记忆视角（多角度检索），列承载 */
  lens?: Lens
  /** 渲染时是否加 ↑（存在 SUPERSEDES 入边或 flags.bit2）。 */
  changed?: boolean
  /** 人类可读摘要，仅用于面板与日志，不进 MRS 正文（MRS 走 slots）。 */
  digest?: string
}

export interface CellRow {
  cell_id: string
  kind: number
  tier: number
  flags: number
  t_from: number
  t_to: number
  t_ingest: number
  t_access: number
  access_cnt: number
  stability: number
  importance: number
  valence: number
  arousal: number
  dominance: number
  salience: number
  provenance: number
  trust: number
  sdr: Uint8Array
  emb: Uint8Array | null
  slots: Uint8Array
  residual_sha: Uint8Array | null
  residual_off: number
  residual_len: number
  confidence: number
  support: number
  topic: string
  digest: string
  t_invalid: number
  scope: string
  session: string
  lens: string
}

/** 变长体布局（MC03）：sdrSparse | emb | slots | edges | tail(8) */
export function encodeBody(c: MemCell): Uint8Array {
  return buildBody(c, packEmb(c.emb, c.tier))
}

function buildBody(c: MemCell, packed: { bytes: Uint8Array; kind: number }): Uint8Array {
  const sdrBytes = encodeSdrSparse(c.sdr)
  const embBytes = packed.bytes
  const slotsBytes = encodeSlots(c.slots)
  const edgesBytes = encodeEdges(c.edges)
  const out = new Uint8Array(sdrBytes.length + embBytes.length + slotsBytes.length + edgesBytes.length + 8)
  let o = 0
  out.set(sdrBytes, o)
  o += sdrBytes.length
  out.set(embBytes, o)
  o += embBytes.length
  out.set(slotsBytes, o)
  o += slotsBytes.length
  out.set(edgesBytes, o)
  o += edgesBytes.length
  const tail = new DataView(out.buffer, out.byteOffset + o, 8)
  tail.setBigUint64(0, topicHash(c.topic), true)
  return out
}

/** u48（毫秒）—— 2^48 ms ≈ 8900 年，比 i64 省 2 B × 4 个时间戳。 */
function writeU48(dv: DataView, off: number, v: bigint): void {
  const x = v > 0n ? v : 0n
  dv.setUint32(off, Number(x & 0xffffffffn), true)
  dv.setUint16(off + 4, Number((x >> 32n) & 0xffffn), true)
}

function readU48(dv: DataView, off: number): bigint {
  return (BigInt(dv.getUint16(off + 4, true)) << 32n) | BigInt(dv.getUint32(off, true))
}

export function encodeCell(c: MemCell): Uint8Array {
  const packed = packEmb(c.emb, c.tier)
  const body = buildBody(c, packed)
  const buf = new Uint8Array(HEADER_SIZE + body.length)
  const dv = new DataView(buf.buffer)

  buf.set([0x4d, 0x43, 0x30, 0x33], 0) // "MC03"
  buf[4] = LAYOUT_VERSION
  buf[5] = c.kind
  buf[6] = c.tier
  buf[7] = c.flags
  dv.setBigUint64(0x08, c.cellId, true)
  writeU48(dv, 0x10, c.tFrom)
  writeU48(dv, 0x16, c.tTo)
  writeU48(dv, 0x1c, c.tIngest)
  writeU48(dv, 0x22, c.tAccess)
  dv.setUint16(0x28, Math.max(0, Math.min(65535, Math.round(c.stability * 100))), true)
  dv.setUint16(0x2a, Math.max(0, Math.min(65535, Math.round(c.importance * 65535))), true)
  buf[0x2c] = q8(c.valence)
  buf[0x2d] = q8(c.arousal)
  buf[0x2e] = q8(c.dominance)
  buf[0x2f] = Math.max(0, Math.min(255, Math.round(c.salience * 255)))
  buf[0x30] = c.provenance
  buf[0x31] = c.trust
  buf[0x32] = Math.min(255, c.slots.length)
  buf[0x33] = Math.min(255, c.edges.length)
  dv.setUint32(0x34, c.accessCount, true)
  const rawLen = c.residual?.rawLen ?? 0
  buf[0x38] = rawLen & 0xff
  buf[0x39] = (rawLen >>> 8) & 0xff
  buf[0x3a] = (rawLen >>> 16) & 0xff
  buf[0x3b] = packed.kind
  if (c.residual) {
    dv.setBigUint64(0x3c, c.residual.off, true)
    buf.set(c.residual.sha.subarray(0, 32), 0x44)
  }
  dv.setUint16(0x64, c.sdr.length * 32, true)
  dv.setUint16(0x66, Math.min(65535, popcountSdr(c.sdr)), true)
  // embDim 记的是**逻辑维度**（还原后长度），pq4 时实际字节只有 32。
  // 用 u16 而不是 u8：256 维是合法的计算维度，u8 装不下会静默截断成 255，
  // 解码时整条 body 会错位一格（这个 bug 被往返测试当场抓住）。
  dv.setUint16(0x68, c.emb ? Math.min(65535, c.emb.length) : 0, true)
  dv.setUint32(0x6c, crc32(buf.subarray(0, 0x6c)), true)
  // 0x70 起为 body

  buf.set(body, HEADER_SIZE)
  return buf
}

function q8(x: number): number {
  return Math.max(-127, Math.min(127, Math.round(x * 127)))
}

export function decodeCell(bytes: Uint8Array, space: SdrSpace): MemCell {
  const magic = bytes.length >= 4 ? String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) : ''
  if (magic === MAGIC_V2) return decodeCellV2(bytes, space)
  if (bytes.length < HEADER_SIZE) throw new Error(`cell 字节不足: ${bytes.length}`)
  if (magic !== MAGIC) throw new Error(`magic 不匹配: ${magic} ≠ ${MAGIC}（需 /mnemo rebuild）`)
  const version = bytes[4]
  if (version !== LAYOUT_VERSION) throw new Error(`布局版本不匹配: ${version} ≠ ${LAYOUT_VERSION}`)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  const crc = dv.getUint32(0x6c, true)
  const expect = crc32(bytes.subarray(0, 0x6c))
  if (crc !== expect) throw new Error('头部 CRC32 校验失败')

  const sdrDim = dv.getUint16(0x64, true)
  if (sdrDim !== space.dim) throw new Error(`SDR 维度不匹配: cell=${sdrDim} 配置=${space.dim}（需 rebuild）`)
  const sdrK = dv.getUint16(0x66, true)
  const embDim = dv.getUint16(0x68, true)
  const embKind = bytes[0x3b]
  const slotCount = bytes[0x32]
  const edgeCount = bytes[0x33]

  let o = HEADER_SIZE
  const sdrDec = decodeSdrSparse(bytes, o, sdrK, sdrDim)
  const sdr = sdrDec.sdr
  o = sdrDec.next
  let emb: Int8Array | null = null
  if (embDim > 0) {
    emb =
      embKind === 2
        ? expandPq4(bytes.subarray(o, o + 32), embDim)
        : new Int8Array(bytes.buffer, bytes.byteOffset + o, embDim).slice()
    o += embKind === 2 ? 32 : embDim
  }
  const { slots, next } = decodeSlots(bytes, o, slotCount)
  o = next
  const { edges, next: n2 } = decodeEdges(bytes, o, edgeCount)
  o = n2
  const topic = dv.getBigUint64(o, true)
  const rawLen = bytes[0x38] | (bytes[0x39] << 8) | (bytes[0x3a] << 16)

  return {
    cellId: dv.getBigUint64(0x08, true),
    kind: bytes[5] as CellKind,
    tier: bytes[6] as CellTier,
    flags: bytes[7],
    tFrom: readU48(dv, 0x10),
    tTo: readU48(dv, 0x16),
    tIngest: readU48(dv, 0x1c),
    tAccess: readU48(dv, 0x22),
    accessCount: dv.getUint32(0x34, true),
    stability: dv.getUint16(0x28, true) / 100,
    importance: dv.getUint16(0x2a, true) / 65535,
    valence: bytes[0x2c] / 127,
    arousal: bytes[0x2d] / 127,
    dominance: bytes[0x2e] / 127,
    salience: bytes[0x2f] / 255,
    provenance: bytes[0x30] as Provenance,
    trust: bytes[0x31],
    sdr,
    emb,
    slots,
    edges,
    residual: rawLen > 0 ? { sha: bytes.subarray(0x44, 0x64).slice(), off: dv.getBigUint64(0x3c, true), rawLen } : null,
    confidence: 0,
    support: 1,
    topic: toHex(topic, 16),
  }
}

/** MC02 只读兼容：旧库不 rebuild 也能被 doctor / export 读出来排查。 */
function decodeCellV2(bytes: Uint8Array, space: SdrSpace): MemCell {
  if (bytes.length < HEADER_SIZE_V2) throw new Error(`cell 字节不足: ${bytes.length}`)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  const sdrDim = dv.getUint16(0x78, true)
  if (sdrDim !== space.dim) throw new Error(`SDR 维度不匹配: cell=${sdrDim} 配置=${space.dim}（需 rebuild）`)
  const embDim = dv.getUint16(0x7c, true)
  const slotCount = dv.getUint16(0x46, true)
  const edgeCount = dv.getUint32(0x48, true)
  let o = HEADER_SIZE_V2
  const sdr = unpackSdr(bytes.subarray(o, o + sdrDim / 8))
  o += sdrDim / 8
  let emb: Int8Array | null = null
  if (embDim > 0) {
    emb = new Int8Array(bytes.buffer, bytes.byteOffset + o, embDim).slice()
    o += embDim
  }
  const { slots, next } = decodeSlots(bytes, o, slotCount)
  o = next
  const { edges, next: n2 } = decodeEdges(bytes, o, edgeCount)
  o = n2
  return {
    cellId: dv.getBigUint64(0x08, true),
    kind: bytes[5] as CellKind,
    tier: bytes[6] as CellTier,
    flags: bytes[7],
    tFrom: dv.getBigInt64(0x10, true),
    tTo: dv.getBigInt64(0x18, true),
    tIngest: dv.getBigInt64(0x20, true),
    tAccess: dv.getBigInt64(0x28, true),
    accessCount: dv.getUint32(0x30, true),
    stability: dv.getFloat32(0x34, true),
    importance: dv.getFloat32(0x38, true),
    valence: dv.getInt16(0x3c, true) / Q14,
    arousal: dv.getInt16(0x3e, true) / Q14,
    dominance: dv.getInt16(0x40, true) / Q14,
    salience: dv.getInt16(0x42, true) / Q14,
    provenance: bytes[0x44] as Provenance,
    trust: bytes[0x45],
    sdr,
    emb,
    slots,
    edges,
    residual:
      dv.getUint32(0x4c, true) > 0
        ? { sha: bytes.subarray(0x50, 0x70).slice(), off: dv.getBigUint64(0x70, true), rawLen: dv.getUint32(0x4c, true) }
        : null,
    confidence: 0,
    support: 1,
    topic: toHex(dv.getBigUint64(o, true), 16),
  }
}

/** cellId 必须确定性生成，否则同一事件重放会得到不同 id，破坏幂等（§15.6）。 */
export function deriveCellId(sessionId: string, seqs: number[], sdrBytes: Uint8Array): bigint {
  const h = hash64(`${sessionId}|${seqs.join(',')}|${toHex(hash64(sdrBytes), 16)}`)
  return h
}

export function topicHash(topic: string): bigint {
  return hash64('TOPIC:' + (topic || ''))
}

export function topicOf(text: string): string {
  const norm = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  // 取前 6 个词做指纹，够稳定也够区分
  return norm.slice(0, 6).join('-')
}

// ── 行映射（存储层与二进制层之间的桥） ────────────────────────────────

export function cellToRow(c: MemCell): CellRow {
  return {
    cell_id: toHex(c.cellId, 16),
    kind: c.kind,
    tier: c.tier,
    flags: c.flags,
    t_from: Number(c.tFrom),
    t_to: Number(c.tTo),
    t_ingest: Number(c.tIngest),
    t_access: Number(c.tAccess),
    access_cnt: c.accessCount,
    stability: c.stability,
    importance: c.importance,
    valence: c.valence,
    arousal: c.arousal,
    dominance: c.dominance,
    salience: c.salience,
    provenance: c.provenance,
    trust: c.trust,
    sdr: packSdr(c.sdr),
    emb: c.emb ? new Uint8Array(c.emb.buffer, c.emb.byteOffset, c.emb.length).slice() : null,
    slots: encodeSlots(c.slots),
    residual_sha: c.residual ? c.residual.sha : null,
    residual_off: c.residual ? Number(c.residual.off) : 0,
    residual_len: c.residual ? c.residual.rawLen : 0,
    confidence: c.confidence,
    support: c.support,
    topic: c.topic,
    digest: c.digest ?? '',
    t_invalid: Number(c.tInvalid ?? 0),
    scope: c.scope ?? 'user:local',
    session: c.session ?? '',
    lens: c.lens ?? 'fact',
  }
}

export function rowToCell(r: CellRow, space: SdrSpace): MemCell {
  const { slots } = decodeSlots(r.slots, 0, 0xffff)
  return {
    cellId: BigInt('0x' + r.cell_id),
    kind: r.kind as CellKind,
    tier: r.tier as CellTier,
    flags: r.flags,
    tFrom: BigInt(r.t_from),
    tTo: BigInt(r.t_to),
    tIngest: BigInt(r.t_ingest),
    tAccess: BigInt(r.t_access),
    accessCount: r.access_cnt,
    stability: r.stability,
    importance: r.importance,
    valence: r.valence,
    arousal: r.arousal,
    dominance: r.dominance,
    salience: r.salience,
    provenance: r.provenance as Provenance,
    trust: r.trust,
    sdr: unpackSdr(r.sdr),
    emb: r.emb ? new Int8Array(r.emb.buffer, r.emb.byteOffset, r.emb.length).slice() : null,
    slots,
    edges: [],
    residual: r.residual_sha ? { sha: r.residual_sha, off: BigInt(r.residual_off), rawLen: r.residual_len } : null,
    confidence: r.confidence,
    support: r.support,
    topic: r.topic,
    digest: r.digest,
    tInvalid: BigInt(r.t_invalid ?? 0),
    scope: r.scope || 'user:local',
    session: r.session || '',
    lens: (r.lens as Lens) || 'fact',
  }
}

// ── 内部编解码 ──────────────────────────────────────────────────────

function q14(x: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(x * Q14)))
}

export function packSdr(a: Sdr): Uint8Array {
  const out = new Uint8Array(a.length * 4)
  const dv = new DataView(out.buffer)
  for (let i = 0; i < a.length; i++) dv.setUint32(i * 4, a[i], true)
  return out
}

export function unpackSdr(bytes: Uint8Array): Sdr {
  const words = bytes.length >>> 2
  const dv = new DataView(bytes.buffer, bytes.byteOffset, words * 4)
  const out = new Uint32Array(words)
  for (let i = 0; i < words; i++) out[i] = dv.getUint32(i * 4, true)
  return out
}

// ── MC03：稀疏 SDR ──────────────────────────────────────────────────
//
// 2048 bit 里只有 k=64 个 1，定长位图 256 B 里 97% 是零。
// 稀疏索引（有序下标 + 差分变长整数）在 k=64 时约 100 B，且**与 sdrDim 无关**——
// 以后把 SDR 加宽到 8192 bit 也不会让存储线性膨胀。这是无损编码。

function writeVarint(out: number[], v: number): void {
  let x = v >>> 0
  while (x >= 0x80) {
    out.push((x & 0x7f) | 0x80)
    x >>>= 7
  }
  out.push(x)
}

function readVarint(bytes: Uint8Array, o: number): { v: number; next: number } {
  let v = 0
  let shift = 0
  while (o < bytes.length) {
    const b = bytes[o++]
    v |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 28) break
  }
  return { v: v >>> 0, next: o }
}

export function encodeSdrSparse(a: Sdr): Uint8Array {
  const out: number[] = []
  const idx: number[] = []
  for (let w = 0; w < a.length; w++) {
    let x = a[w]
    while (x !== 0) {
      const bit = 31 - Math.clz32(x & -x)
      idx.push(w * 32 + bit)
      x &= x - 1
    }
  }
  writeVarint(out, idx.length)
  let prev = 0
  for (const i of idx) {
    writeVarint(out, i - prev)
    prev = i
  }
  return Uint8Array.from(out)
}

export function decodeSdrSparse(bytes: Uint8Array, offset: number, _k: number, dimBits: number): { sdr: Sdr; next: number } {
  const out = new Uint32Array(Math.ceil(dimBits / 32))
  const head = readVarint(bytes, offset)
  let o = head.next
  let idx = 0
  for (let i = 0; i < head.v; i++) {
    const d = readVarint(bytes, o)
    o = d.next
    idx += d.v
    if (idx < dimBits) out[idx >>> 5] |= 1 << (idx & 31)
  }
  return { sdr: out, next: o }
}

// ── MC03：向量折叠与 4 bit 压缩 ────────────────────────────────────

/**
 * 分组求和折叠：256 → 64 维（随机投影，Johnson–Lindenstrauss 意义下保距）。
 * 余弦相似度基本保持，检索排序不变——bench 的 Recall@8 是这条断言的唯一依据。
 */
export function foldEmb(emb: Int8Array, dim: number): Int8Array {
  if (emb.length === dim) return emb
  if (emb.length < dim) {
    const out = new Int8Array(dim)
    out.set(emb)
    return out
  }
  const out = new Int8Array(dim)
  const g = emb.length / dim
  for (let i = 0; i < dim; i++) {
    let acc = 0
    const from = Math.floor(i * g)
    const to = Math.max(from + 1, Math.floor((i + 1) * g))
    for (let j = from; j < to; j++) acc += emb[j]
    out[i] = Math.max(-127, Math.min(127, Math.round(acc / (to - from))))
  }
  return out
}

/**
 * 冷层用：int8 → 8 段 × 4 bit = 32 B（值域 −8..7，还原时 ×16）。
 *
 * **必须先按最大绝对值归一化**：哈希 embedding 的分量只有 ±4…±8，
 * 直接 `avg/16` 会把每个 nibble 都取整成 0——整条冷层向量变成零向量，
 * 于是"冷记忆永远检索不到"。余弦只关心方向，所以归一化不损失任何检索信息。
 */
export function pq4(emb: Int8Array): Uint8Array {
  let maxAbs = 0
  for (let i = 0; i < emb.length; i++) maxAbs = Math.max(maxAbs, Math.abs(emb[i]))
  const k = maxAbs > 0 ? 127 / maxAbs : 0
  const seg = Math.floor(emb.length / 8) || 1
  const perSub = Math.max(1, Math.floor(seg / 4))
  const out = new Uint8Array(32)
  for (let s = 0; s < 8; s++) {
    for (let b = 0; b < 4; b++) {
      let acc = 0
      const from = s * seg + b * perSub
      const to = Math.min(emb.length, from + perSub)
      for (let i = from; i < to; i++) acc += emb[i] * k
      const avg = acc / Math.max(1, to - from)
      out[s * 4 + b] = Math.max(-8, Math.min(7, Math.round(avg / 16))) & 0x0f
    }
  }
  return out
}

export function expandPq4(bytes: Uint8Array, dim: number): Int8Array {
  const out = new Int8Array(dim)
  const seg = Math.max(1, Math.floor(dim / 8))
  const perSub = Math.max(1, Math.floor(seg / 4))
  for (let s = 0; s < 8; s++) {
    for (let b = 0; b < 4; b++) {
      const v = (((bytes[s * 4 + b] << 28) >> 28) || 0) * 16
      for (let j = 0; j < perSub; j++) {
        const i = s * seg + b * perSub + j
        if (i < dim) out[i] = v
      }
    }
  }
  return out
}

function packEmb(emb: Int8Array | null, tier: number): { bytes: Uint8Array; kind: number } {
  if (!emb) return { bytes: new Uint8Array(0), kind: 0 }
  // 冷层/归档层已经过 pq32 降级，直接按 32 B 存；热温层保持 int8 原样，
  // 只有 tier ≥ 2 且维度大于 32 时才落到 4 bit（每组 8 维一个值）。
  if (emb.length <= 32) return { bytes: new Uint8Array(emb.buffer, emb.byteOffset, emb.length).slice(), kind: 1 }
  if (tier >= 2) return { bytes: pq4(emb), kind: 2 }
  return { bytes: new Uint8Array(emb.buffer, emb.byteOffset, emb.length).slice(), kind: 1 }
}

function popcountSdr(a: Sdr): number {
  let n = 0
  for (let i = 0; i < a.length; i++) {
    let x = a[i]
    x = x - ((x >>> 1) & 0x55555555)
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
    x = (x + (x >>> 4)) & 0x0f0f0f0f
    n += Math.imul(x, 0x01010101) >>> 24
  }
  return n
}

export function encodeSlots(slots: readonly Slot[]): Uint8Array {
  const enc = slots.map((s) => {
    const payload = s.type === 'REF' ? hexToBytesLocal(s.value) : new TextEncoder().encode(s.value)
    return { s, payload: payload.subarray(0, Math.min(payload.length, 65535)) }
  })
  const total = enc.reduce((n, e) => n + 4 + e.payload.length, 0)
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  let o = 0
  for (const e of enc) {
    out[o] = e.s.role
    out[o + 1] = e.s.type === 'REF' ? 0 : e.s.type === 'LIT' ? 1 : 2
    dv.setUint16(o + 2, e.payload.length, true)
    out.set(e.payload, o + 4)
    o += 4 + e.payload.length
  }
  return out
}

export function decodeSlots(bytes: Uint8Array, offset: number, count: number): { slots: Slot[]; next: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  const slots: Slot[] = []
  let o = offset
  const n = count === 0xffff ? Number.MAX_SAFE_INTEGER : count
  while (slots.length < n && o + 4 <= bytes.length) {
    const role = bytes[o]
    const t = bytes[o + 1]
    const len = dv.getUint16(o + 2, true)
    const payload = bytes.subarray(o + 4, o + 4 + len)
    const type: SlotType = t === 0 ? 'REF' : t === 1 ? 'LIT' : 'UNK'
    slots.push({
      role,
      type,
      value: type === 'REF' ? bytesToHexLocal(payload) : new TextDecoder().decode(payload),
    })
    o += 4 + len
    if (count === 0xffff && o >= bytes.length) break
  }
  return { slots, next: o }
}

export function encodeEdges(edges: readonly Edge[]): Uint8Array {
  const out = new Uint8Array(edges.length * 6)
  const dv = new DataView(out.buffer)
  edges.forEach((e, i) => {
    dv.setUint32(i * 6, e.targetPrefix >>> 0, true)
    out[i * 6 + 4] = e.rel & 0xff
    out[i * 6 + 5] = e.weight & 0xff
  })
  return out
}

export function decodeEdges(bytes: Uint8Array, offset: number, count: number): { edges: Edge[]; next: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  const edges: Edge[] = []
  let o = offset
  for (let i = 0; i < count && o + 6 <= bytes.length; i++) {
    edges.push({
      targetPrefix: dv.getUint32(o, true),
      rel: bytes[o + 4],
      weight: (bytes[o + 5] << 24) >> 24, // i8
    })
    o += 6
  }
  return { edges, next: o }
}

function hexToBytesLocal(h: string): Uint8Array {
  const out = new Uint8Array(h.length >>> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16) || 0
  return out
}

function bytesToHexLocal(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export function shaOf(text: string): Uint8Array {
  return digest32(text)
}
