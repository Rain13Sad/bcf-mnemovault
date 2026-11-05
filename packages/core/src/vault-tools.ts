/**
 * v0.7.2 · 落地工具链（评判报告 §13 / §14：E2 / E6 / E10 / D6 / D11）
 *
 * 这一层**只读** store / MemoryService，不改 MC03 布局、不引第三方依赖、
 * 不做任何隐式写库。它补的是评判报告里"技术能力有、产品化工具没有"的那一截：
 *
 *   ① exportBundle    机器可读的数据可携带格式（追问 30 / E6）
 *   ② verifyPurge     删除彻底性的**独立**穷举校验（E2；回执之外再查一次）
 *   ③ metricsText     Prometheus 文本导出（D6）
 *   ④ accessAuditLine 原始记忆访问的标准留痕形状（E10，由 store 落盘）
 *
 * 明确不做的（保持诚实，不写"假装有"的代码）：把 bundle 原样导回成同 id 的晶格。
 * 那需要重算 SDR / 向量 / 内容寻址 id，属于 `rebuild --from-log` 的职责。
 * 这里只承诺"拿得走、看得懂、校验得了、能备份恢复"。
 */

import type { MemoryService } from './service.js'
import type { Store } from './store.js'

export const BUNDLE_FORMAT = 'mnemo-vault-bundle'
export const BUNDLE_SCHEMA = 1
export const BUNDLE_VERSION = '0.7.2'

export interface VaultBundle {
  format: typeof BUNDLE_FORMAT
  schema: number
  version: string
  exportedAt: string
  counts: { cells: number; edges: number; logs: number; residuals: number; snapshots: number; evictions: number }
  /** 完整 cell（含 slots / sdr / emb / 双时态 / 情感读数），bigint 与 TypedArray 已转成可 JSON 化形状 */
  cells: unknown[]
  edges: unknown[]
  sessionLog: unknown[]
  evictLog: unknown[]
  /** 渲染过的记忆文本快照——删干净与否的关键证据 */
  snapshots: unknown[]
  /** 残差原文（brotli 解压后的 UTF-8）；includeRaw=false 时只留长度 */
  residuals: Array<{ off: number; text: string | null; bytes: number }>
  meta: Record<string, string | null>
  /** 完整性校验和（FNV-1a 双路 64 位）。不是加密，也不是防篡改签名。 */
  checksum: string
}

/** JSON 安全转换：bigint → 十进制串，TypedArray → 数字数组，其余递归。 */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString()
  if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>)
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v)) o[k] = jsonSafe(val)
    return o
  }
  return v
}

/**
 * FNV-1a 双路 64 位（位运算后一律 `>>> 0`，项目硬契约：JS 的 `^` 是有符号 32 位，
 * 不归一会让负数下标/哈希静默错位）。
 */
function checksumOf(s: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c >>> 8), 0x85ebca6b) >>> 0
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

/** 计算 bundle 校验和（排除 checksum 字段本身）。 */
export function bundleChecksum(b: Omit<VaultBundle, 'checksum'> | VaultBundle): string {
  const { checksum: _ignored, ...rest } = b as VaultBundle
  return checksumOf(JSON.stringify(rest))
}

/** 校验一个外部 bundle 的形状与完整性。返回问题列表，空数组 = 可用。 */
export function validateBundle(raw: unknown): { ok: boolean; issues: string[]; checksum: string } {
  const issues: string[] = []
  const b = raw as Partial<VaultBundle> | null
  if (!b || typeof b !== 'object') return { ok: false, issues: ['不是对象'], checksum: '' }
  if (b.format !== BUNDLE_FORMAT) issues.push(`format 不是 ${BUNDLE_FORMAT}`)
  if (b.schema !== BUNDLE_SCHEMA) issues.push(`schema ${b.schema} 不受支持（本版 ${BUNDLE_SCHEMA}）`)
  if (!Array.isArray(b.cells)) issues.push('cells 不是数组')
  if (!Array.isArray(b.sessionLog)) issues.push('sessionLog 不是数组')
  if (!Array.isArray(b.edges)) issues.push('edges 不是数组')
  let checksum = ''
  if (typeof b.checksum === 'string' && b.checksum.length === 16) {
    checksum = bundleChecksum(b as VaultBundle)
    if (checksum !== b.checksum) issues.push(`校验和不匹配：文件 ${b.checksum} ≠ 计算 ${checksum}`)
  } else issues.push('缺少 checksum（无法确认文件完整性）')
  if (Array.isArray(b.cells) && Array.isArray(b.sessionLog)) {
    const declared = b.counts?.cells
    if (Number.isFinite(declared) && declared !== b.cells.length) issues.push(`counts.cells=${declared} 与实际 ${b.cells.length} 不符`)
  }
  return { ok: issues.length === 0, issues, checksum }
}

/**
 * 导出全部用户数据为机器可读 JSON 对象。
 *
 * 为什么不做"导回"：cell id 是 `hash(sessionId‖seqs‖sdr)` 的内容寻址结果，
 * 原样写回必然要重算向量与 SDR，那正是 rebuild 的语义。把导回做成静默重建
 * 会让用户以为 id/边/版本链都保住了——那是假的。
 */
export function exportBundle(mem: MemoryService, opts: { includeRaw?: boolean } = {}): VaultBundle {
  const store = mem.store
  const cells: unknown[] = []
  const offs = new Set<number>()
  store.forEachCell((c) => {
    cells.push(jsonSafe(c))
    const r = c.residual as { off?: number } | null
    if (r && Number.isFinite(r.off)) offs.add(Number(r.off))
  })
  const residuals = [...offs].map((off) => {
    const raw = store.getResidual(off)
    return {
      off,
      text: opts.includeRaw === false || !raw ? null : new TextDecoder().decode(raw),
      bytes: raw?.length ?? 0,
    }
  })
  const edges = jsonSafe(store.allEdges()) as unknown[]
  const sessionLog = jsonSafe(store.listLog()) as unknown[]
  const evictLog = jsonSafe(store.recentEvicts(1_000_000)) as unknown[]
  const snapshots = jsonSafe(store.listSnapshots(1_000_000)) as unknown[]
  const meta: Record<string, string | null> = {}
  for (const k of ['layout', 'embSpace', 'consolidate:open', 'token_df.docs']) meta[k] = store.meta(k)
  const base: Omit<VaultBundle, 'checksum'> = {
    format: BUNDLE_FORMAT,
    schema: BUNDLE_SCHEMA,
    version: BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      cells: cells.length,
      edges: edges.length,
      logs: sessionLog.length,
      residuals: residuals.length,
      snapshots: snapshots.length,
      evictions: evictLog.length,
    },
    cells,
    edges,
    sessionLog,
    evictLog,
    snapshots,
    residuals,
    meta,
  }
  return { ...base, checksum: bundleChecksum(base) }
}

export interface PurgeAudit {
  ok: boolean
  cells: number
  edges: number
  orphanResiduals: number
  snapshots: number
  evictions: number
  sessionLog: number
  /** 来源映射指向已不存在的会话日志行（关联断了，无法再回链原文） */
  danglingSources: number
  issues: string[]
}

/**
 * 删除彻底性的**独立**校验（E2）。
 *
 * `purge()` 自己报的行数是"我删了多少"，不是"盘上还剩多少"。
 * 这个工具从零重新数一遍所有派生表，两者都为零才算真的删干净。
 * 只读，绝不顺手修复——验证与修复分开，才不会把证据一起抹掉。
 */
export function verifyPurge(store: Store, opts: { session?: string } = {}): PurgeAudit {
  const issues: string[] = []
  let cells = 0
  const liveIds = new Set<string>()
  store.forEachCell((c) => {
    cells++
    liveIds.add(String(c.cellId))
  })
  const edges = store.allEdges().length
  const orphanResiduals = store.orphanResiduals().length
  const snapshots = store.listSnapshots(1_000_000).length
  const evictions = store.recentEvicts(1_000_000).length
  const logs = store.listLog(opts.session)
  const logKeys = new Set(logs.map((l) => `${l.session}#${l.seq}`))
  let danglingSources = 0
  for (const id of liveIds) {
    for (const s of store.sourcesOf(BigInt(id))) {
      if (!logKeys.has(`${s.session}#${s.seq}`)) danglingSources++
    }
  }
  const fields: Array<[string, number]> = [
    ['cell', cells],
    ['边', edges],
    ['孤儿残差', orphanResiduals],
    ['渲染快照', snapshots],
    ['驱逐记录', evictions],
    ['会话日志', logs.length],
    ['悬空来源映射', danglingSources],
  ]
  for (const [name, n] of fields) if (n > 0) issues.push(`仍有 ${n} 条${name}`)
  return {
    ok: issues.length === 0,
    cells,
    edges,
    orphanResiduals,
    snapshots,
    evictions,
    sessionLog: logs.length,
    danglingSources,
    issues,
  }
}

/** Prometheus 文本格式（D6）。纯函数，无依赖、无网络、无定时器。 */
export function metricsText(mem: MemoryService): string {
  const s = mem.store.stats()
  const c = mem.store.counts()
  const out: string[] = [
    '# HELP mnemo_cells_total 记忆晶胞总数',
    '# TYPE mnemo_cells_total gauge',
    `mnemo_cells_total ${s.cells}`,
    '# HELP mnemo_edges_total 类型化超边总数',
    '# TYPE mnemo_edges_total gauge',
    `mnemo_edges_total ${s.edges}`,
    '# HELP mnemo_residuals_total 残差块总数',
    '# TYPE mnemo_residuals_total gauge',
    `mnemo_residuals_total ${s.residuals}`,
    '# HELP mnemo_bytes_total 晶格占用字节',
    '# TYPE mnemo_bytes_total gauge',
    `mnemo_bytes_total ${s.bytes}`,
    '# HELP mnemo_snapshots_total 召回快照总数',
    '# TYPE mnemo_snapshots_total gauge',
    `mnemo_snapshots_total ${mem.store.listSnapshots(1_000_000).length}`,
  ]
  for (const [kind, n] of Object.entries(c.byKind)) out.push(`mnemo_cells_by_kind{kind="${kind}"} ${n}`)
  for (const [tier, n] of Object.entries(c.byTier)) out.push(`mnemo_cells_by_tier{tier="${tier}"} ${n}`)
  const layout = mem.store.meta('layout') ?? 'unknown'
  out.push(`mnemo_layout_info{layout="${layout.replace(/"/g, '')}"} 1`)
  return out.join('\n') + '\n'
}

export interface AccessAuditEntry {
  at: number
  actor: string
  action: 'expand' | 'export' | 'purge' | 'doctor' | 'recall'
  /** cell 短 id / session id / 'all' */
  target: string
  chars?: number
  reason?: string
}

/** 访问审计的标准记录形状（E10）。一行一条 JSONL，便于宿主流式落盘。 */
export function accessAuditLine(e: AccessAuditEntry): string {
  return JSON.stringify({
    at: Number.isFinite(e.at) ? e.at : 0,
    actor: String(e.actor ?? 'unknown').slice(0, 64),
    action: e.action,
    target: String(e.target ?? '').slice(0, 128),
    chars: Number.isFinite(e.chars) ? e.chars : 0,
    reason: e.reason ? String(e.reason).slice(0, 200) : undefined,
  })
}
