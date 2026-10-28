/**
 * MemCell 七元组 ⟨σ,E,G,Φ,A,R,τ⟩ 的二进制布局与编解码（对应 §5.1 / §6.1 / §6.2 / §15.6）
 *
 * 布局要点：定长头 192 B，任何字段按偏移直接寻址，无需解析、无需反序列化、无需分配对象。
 * 变长体 = sdr(256) + emb(256 或 32) + slots + edges + tail(8)。
 * 固定部分 704 B，加 12 条边与 6 个槽位后约 812 B。
 *
 * 与文档的一处有意偏差：运行时 `sdr` 用 Uint32Array 而非 Uint8Array。
 * 位运算在 Uint8Array 上要么慢要么错（JS 的位运算按 32 位做），
 * 因此运行时保持 32 位视图，只在 encode/decode 的边界上做字节转换。
 */

import { crc32 } from './crc32.js'
import { digest32, hash64, toHex } from './hash.js'
import type { Sdr } from './sdr.js'
import { SdrSpace } from './sdr.js'

export const HEADER_SIZE = 192
export const MAGIC = 'MC02'
export const LAYOUT_VERSION = 2
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

/** 变长体布局：sdr | emb | slots | edges | tail */
export function encodeBody(c: MemCell): Uint8Array {
  const sdrBytes = packSdr(c.sdr)
  const embBytes = c.emb ? new Uint8Array(c.emb.buffer, c.emb.byteOffset, c.emb.length) : new Uint8Array(0)
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

export function encodeCell(c: MemCell): Uint8Array {
  const body = encodeBody(c)
  const buf = new Uint8Array(HEADER_SIZE + body.length)
  const dv = new DataView(buf.buffer)

  buf.set([0x4d, 0x43, 0x30, 0x32], 0) // "MC02"
  buf[4] = LAYOUT_VERSION
  buf[5] = c.kind
  buf[6] = c.tier
  buf[7] = c.flags
  dv.setBigUint64(0x08, c.cellId, true)
  dv.setBigInt64(0x10, c.tFrom, true)
  dv.setBigInt64(0x18, c.tTo, true)
  dv.setBigInt64(0x20, c.tIngest, true)
  dv.setBigInt64(0x28, c.tAccess, true)
  dv.setUint32(0x30, c.accessCount, true)
  dv.setFloat32(0x34, c.stability, true)
  dv.setFloat32(0x38, c.importance, true)
  dv.setInt16(0x3c, q14(c.valence), true)
  dv.setInt16(0x3e, q14(c.arousal), true)
  dv.setInt16(0x40, q14(c.dominance), true)
  dv.setInt16(0x42, q14(c.salience), true)
  buf[0x44] = c.provenance
  buf[0x45] = c.trust
  dv.setUint16(0x46, c.slots.length, true)
  dv.setUint32(0x48, c.edges.length, true)
  dv.setUint32(0x4c, c.residual?.rawLen ?? 0, true)
  if (c.residual) {
    buf.set(c.residual.sha.subarray(0, 32), 0x50)
    dv.setBigUint64(0x70, c.residual.off, true)
  }
  dv.setUint16(0x78, c.sdr.length * 32, true)
  dv.setUint16(0x7a, Math.min(65535, popcountSdr(c.sdr)), true)
  dv.setUint16(0x7c, c.emb ? c.emb.length : 0, true)
  dv.setUint16(0x7e, 0, true)
  dv.setUint32(0x80, crc32(buf.subarray(0, 0x80)), true)
  // 0x84..0xBF reserved，必须清零（Uint8Array 已保证）

  buf.set(body, HEADER_SIZE)
  return buf
}

export function decodeCell(bytes: Uint8Array, space: SdrSpace): MemCell {
  if (bytes.length < HEADER_SIZE) throw new Error(`cell 字节不足: ${bytes.length}`)
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== MAGIC) throw new Error(`magic 不匹配: ${magic} ≠ ${MAGIC}（需 /mnemo rebuild）`)
  const version = bytes[4]
  if (version !== LAYOUT_VERSION) throw new Error(`布局版本不匹配: ${version} ≠ ${LAYOUT_VERSION}`)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  const crc = dv.getUint32(0x80, true)
  const expect = crc32(bytes.subarray(0, 0x80))
  if (crc !== expect) throw new Error('头部 CRC32 校验失败')

  const sdrDim = dv.getUint16(0x78, true)
  if (sdrDim !== space.dim) throw new Error(`SDR 维度不匹配: cell=${sdrDim} 配置=${space.dim}（需 rebuild）`)
  const embDim = dv.getUint16(0x7c, true)
  const slotCount = dv.getUint16(0x46, true)
  const edgeCount = dv.getUint32(0x48, true)

  let o = HEADER_SIZE
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
  const topic = dv.getBigUint64(o, true)

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
    topic: toHex(topic, 16),
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
