/**
 * MRS 渲染（对应 §9.4 / 附录 A）
 *
 * 渲染是唯一花 token 的环节，因此是整个设计的经济核心。五条原则：
 *   1. 图例一次，正文极简（首轮 140 token，可被 prefix cache 命中）
 *   2. 列式优于行式
 *   3. 数值优于自然语言
 *   4. **字节稳定**：同 cell 同 query 必须逐字节一致，否则 prefix cache 失效
 *   5. 可逆指针：每行带 cell_id 前缀，模型可调 memory_expand 展开
 *
 * 字节稳定性靠三件事保证：字段顺序固定、浮点两位去尾零、id 长度整会话固定。
 * 任何"按当前数据决定格式"的写法都会破坏它——包括 v0.1 的"冲突时自动加长到 6 位"。
 */

import { KIND_NAME, PROV_NAME, SLOT_ROLE_NAME, type MemCell, type Slot } from './cell.js'
import type { Pad, RecallHit, SurfaceMode } from './types.js'

export const LEGEND_ROWS = `[MEM v2] 每行一条记忆，字段以 | 分隔。
M=id前缀 T=时间(MMDD) P=来源(u用户/a助手/t工具/w网络/i推断)
F=帧类型 K=键值 V=效价[-1,1] S=显著度 C=置信度 ↑=有过变更`

export const LEGEND_COMPACT = `[MEM v2] 列式：M[ids]|T[MMDD]|P[u/a/t/w/i]|F[帧]|K[k=v]|V[效价]|S[显著度]|C[置信度]`

/**
 * token 估算。宿主有 tokenizer 时以宿主为准；此处给一个稳定的启发式：
 * CJK 每字 ≈ 1 token，ASCII 每 4 字符 ≈ 1 token，标点按 0.5 计。
 * 它只用于预算控制，不用于对外声称成本——对外数字必须来自 TokenLedger。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let ascii = 0
  let punct = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c >= 0x2e80) cjk++
    else if (/[A-Za-z0-9]/.test(ch)) ascii++
    else punct++
  }
  return Math.ceil(cjk + ascii / 4 + punct * 0.5)
}

/** 浮点两位、去尾零（附录 A 的硬约束，不是美观）。 */
export function fmt2(x: number): string {
  const v = Math.round(x * 100) / 100
  const s = v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return s === '-0' ? '0' : s
}

export function fmtSigned(x: number): string {
  const s = fmt2(x)
  return s.startsWith('-') || s === '0' ? s : '+' + s
}

export function mmdd(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 帧类型：kind 决定大类，PRED 细化（pref 是 fact 的子类，但检索时语义不同）。 */
export function frameOf(cell: MemCell): string {
  const pred = slotLit(cell.slots, 'PRED')?.toLowerCase() ?? ''
  if (/prefer|like|dislike|讨厌|喜欢|偏好|倾向/.test(pred)) return 'pref'
  switch (cell.kind) {
    case 0:
      return 'event'
    case 1:
      return 'fact'
    case 2:
      return 'proc'
    case 3:
      return 'schema'
    case 4:
      return 'persona'
    case 5:
      return 'rel'
    default:
      return 'fact'
  }
}

export function slotLit(slots: readonly Slot[], roleName: string): string | undefined {
  const role = Object.entries(SLOT_ROLE_NAME).find(([, n]) => n === roleName)?.[0]
  if (!role) return undefined
  const s = slots.find((x) => x.role === Number(role) && x.type !== 'UNK')
  return s?.value
}

/**
 * K 段：从槽位抽取 key=value，最多 3 对。
 * PATIENT 作键、PRED 作值是最常见的"实体-属性"形态（ui.theme=dark）。
 * 缺 PATIENT 时退化为 AGENT=PRED，再缺则用 digest 的短摘要（不引文字进正文的例外，
 * 因为 digest 本身就是结构化产物）。
 */
export function kvPairs(cell: MemCell): Array<[string, string]> {
  const agent = slotLit(cell.slots, 'AGENT')
  const patient = slotLit(cell.slots, 'PATIENT')
  const pred = slotLit(cell.slots, 'PRED')
  const qty = slotLit(cell.slots, 'QTY')
  const time = slotLit(cell.slots, 'TIME')
  const out: Array<[string, string]> = []
  const clean = (s: string) => s.replace(/[|\s]+/g, '_').slice(0, 32)
  const manner = slotLit(cell.slots, 'MANNER')
  // 偏好帧与动宾帧都读作 '话题=取值'（字体=等宽、部署=pnpm），比 '等宽=prefers' 更接近人话
  const isPreference = pred === 'prefers' || pred === 'dislikes'
  const isUses = pred === 'uses' || pred === 'changes' || pred === 'deploys'
  if ((isPreference || isUses) && patient && manner) {
    out.push([clean(manner), clean(patient)])
    if (qty) out.push(['qty', clean(qty)])
    return out.slice(0, 3)
  }
  if (isPreference && patient) {
    out.push([clean(pred === 'dislikes' ? 'dislike' : 'pref'), clean(patient)])
    return out.slice(0, 3)
  }
  if (patient && pred) out.push([clean(patient), clean(pred)])
  else if (agent && pred) out.push([clean(agent), clean(pred)])
  else if (pred) out.push(['pred', clean(pred)])
  if (qty) out.push(['qty', clean(qty)])
  if (time && out.length < 3) out.push(['t', clean(time)])
  if (out.length === 0 && cell.digest) out.push(['k', cell.digest.replace(/[|\s]+/g, '_').slice(0, 28)])
  return out.slice(0, 3)
}

/** 单条行式渲染。字段顺序固定，不得重排。 */
export function renderRow(cell: MemCell, shortId: string): string {
  const parts = [
    `M:${shortId}`,
    `T:${mmdd(Number(cell.tFrom))}`,
    `P:${PROV_NAME[cell.provenance] ?? 'i'}`,
    `F:${frameOf(cell)}`,
    `K:${kvPairs(cell)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')}`,
    `V:${fmtSigned(cell.valence)}`,
    `S:${fmt2(cell.salience)}`,
    `C:${fmt2(cell.confidence)}`,
  ]
  // ↑ 的出现条件：显式 changed，或 flags.bit2（有争议/被取代）——附录 A 的约束
  if (cell.changed || (cell.flags & 4) !== 0) parts.push('↑')
  return parts.join('|')
}

/**
 * 列式渲染。同三条 42 token vs 行式 68 token，只在 surfaceMode=compact 时用。
 * 每条 cell 的 K 段可能有多对，列式下用 ; 分隔，保持可解析。
 */
export function renderCompact(cells: Array<{ cell: MemCell; shortId: string }>): string {
  if (cells.length === 0) return ''
  const col = (prefix: string, values: string[]) => `${prefix}[${values.join(',')}]`
  return [
    col('M', cells.map((c) => c.shortId)),
    col('T', cells.map((c) => mmdd(Number(c.cell.tFrom)))),
    col('P', cells.map((c) => PROV_NAME[c.cell.provenance] ?? 'i')),
    col('F', cells.map((c) => frameOf(c.cell))),
    col(
      'K',
      cells.map((c) =>
        kvPairs(c.cell)
          .map(([k, v]) => `${k}=${v}`)
          .join(';'),
      ),
    ),
    col('V', cells.map((c) => fmtSigned(c.cell.valence).replace('+', ''))),
    col('S', cells.map((c) => fmt2(c.cell.salience))),
    col('C', cells.map((c) => fmt2(c.cell.confidence))),
  ].join('|')
}

/** prose 降级：弱模型解析不了 MRS 时用。token 约 2.5×，仍优于 RAG。 */
export function renderProse(cell: MemCell, shortId: string): string {
  const kv = kvPairs(cell)
    .map(([k, v]) => `${k} 是 ${v}`)
    .join('，')
  const when = new Date(Number(cell.tFrom)).toISOString().slice(0, 10)
  const val = cell.valence > 0.15 ? '，当时反应正面' : cell.valence < -0.15 ? '，当时反应负面' : ''
  return `- [${shortId}] ${when} 记录的${KIND_NAME[cell.kind] ?? '事实'}：${kv}${val}（置信 ${fmt2(cell.confidence)}）。`
}

/** 情感状态行（§9.4），约 28 token。 */
export function renderAffectLine(mood: Pad, trust: number, familiarity: number, policy: { verbosity: number; temperatureDelta: number; clarification: number }): string {
  const signed = (x: number) => fmtSigned(x)
  const pol: string[] = []
  if (policy.verbosity < 0) pol.push('verb-1')
  else if (policy.verbosity > 0) pol.push('verb+1')
  if (policy.temperatureDelta !== 0) pol.push(`temp${signed(policy.temperatureDelta)}`)
  if (policy.clarification > 0) pol.push(`clar+${policy.clarification}`)
  return `A|mood:${signed(mood.v)}/${fmt2(mood.a)}/${fmt2(mood.d)}|rel:trust.${fmt2(trust * 100)},fam.${fmt2(
    familiarity * 100,
  )}|pol:${pol.length ? pol.join(',') : 'none'}`
}

export interface RenderInput {
  cells: Array<{ cell: MemCell; shortId: string }>
  mode: SurfaceMode
  includeLegend: boolean
  maxTokens: number
  affectLine?: string
}

export interface RenderOutput {
  text: string
  tokens: number
  rows: number
  dropped: number
  mode: SurfaceMode
}

/**
 * 渲染主入口。预算硬上限：超出时从尾部丢条目（保留图例），并如实报告 dropped。
 * 绝不截断半行——半行会破坏字节稳定与可解析性。
 */
export function renderSurface(input: RenderInput): RenderOutput {
  const { cells, mode, includeLegend, maxTokens, affectLine } = input
  const legend = includeLegend ? (mode === 'compact' ? LEGEND_COMPACT : LEGEND_ROWS) : ''
  const head = [legend, affectLine ?? ''].filter(Boolean).join('\n')

  const build = (n: number): string => {
    const slice = cells.slice(0, n)
    let body = ''
    if (mode === 'compact') body = renderCompact(slice)
    else if (mode === 'prose') body = slice.map((c) => renderProse(c.cell, c.shortId)).join('\n')
    else body = slice.map((c) => renderRow(c.cell, c.shortId)).join('\n')
    return [head, body].filter(Boolean).join('\n')
  }

  let n = cells.length
  let text = build(n)
  let tokens = estimateTokens(text)
  while (tokens > maxTokens && n > 0) {
    n--
    text = build(n)
    tokens = estimateTokens(text)
  }
  // 图例本身就超预算时，退化为"只给图例"，不返回半截正文
  if (n === 0 && tokens > maxTokens) {
    text = legend
    tokens = estimateTokens(text)
  }
  return { text, tokens, rows: n, dropped: cells.length - n, mode }
}

/** 面板与解释器用的短 id（整会话固定 4 位，冲突时追加序号但不改长度）。 */
export function assignShortIds(cells: Array<{ cell: MemCell }>, width = 4): string[] {
  const seen = new Map<string, number>()
  return cells.map(({ cell }) => {
    const base = (cell.cellId & 0xffffn).toString(16).padStart(16, '0').slice(-width)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}#${count}`
  })
}

/** 对话流内卡片的一行摘要（§12.7）。默认折叠，不做默认展开。 */
export function recallCardSummary(hits: RecallHit[], tokens: number, elapsedMs: number): string {
  const kinds = new Map<string, number>()
  for (const h of hits) kinds.set(h.channel, (kinds.get(h.channel) ?? 0) + 1)
  const parts = [...kinds.entries()].map(([k, n]) => `${k} ${n}`).join(' · ')
  return `记忆 · ${hits.length} 条　${parts}　${tokens} token · ${(elapsedMs / 1000).toFixed(1)}s`
}
