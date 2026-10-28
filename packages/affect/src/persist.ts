/**
 * 情感状态的持久化与离线抽象（对应 §11.5 / §11.7 / §11.8）
 *
 * 三个环路里，只有"快环"是纯内存的：
 *   快环（每轮）  → 本轮 PAD 与策略，写 affect/appraisal 事件
 *   慢环（每会话）→ mood / 关系模型 / persona，**必须落盘**，否则重启就忘
 *   离线环（每 N 轮）→ 用户 schema（kind=3），"这个人是什么样"
 *
 * 落盘方式是"用记忆库自己的格式"而不是另建一张表：
 *   kind=5 关系模型 → 一条 cell（flags.bit1 不衰减）
 *   kind=4 人格锚   → 一条 cell（不可合并、不可衰减）
 *   kind=3 用户图式 → 由离线环产出，可被后续 pass 继续合并
 *
 * 这样做的好处是"热重载可重建"（§14.7）：情感服务挂了重启，从这三类 cell 读回来即可，
 * 不需要额外的状态存储，也不需要和主库做一致性维护。
 */

import {
  FLAG,
  KIND,
  TRUST_BY_PROVENANCE,
  cellIdFor,
  hashEmbedding,
  type MemCell,
  type MemoryService,
  type Pad,
  type RelationalSnapshot,
  type Slot,
} from '@rain13sad/dsh-mnemo-core'

const REL_KIND = KIND.relational
const PERSONA_KIND = KIND.persona
const SCHEMA_KIND = KIND.schema

export interface PersonaState {
  vector: number[]
  rev: number
}

/** 关系模型 → 一条 kind=5 cell。槽位承载数值，digest 只写摘要（不进 MRS 正文）。 */
export function relationalCell(memory: MemoryService, rel: RelationalSnapshot, persona: PersonaState, now: number): MemCell {
  const slots: Slot[] = [
    { role: 1, type: 'LIT', value: '用户' },
    { role: 3, type: 'LIT', value: 'relational' },
    { role: 2, type: 'LIT', value: `trust=${rel.trust.toFixed(3)}` },
    { role: 6, type: 'LIT', value: `fam=${rel.familiarity.toFixed(3)},attune=${rel.attunement.toFixed(3)},debt=${rel.repairDebt}` },
    { role: 8, type: 'LIT', value: `turns=${rel.turns},rev=${persona.rev}` },
  ]
  // 边界单独一条槽位，语义上它是硬约束（只增不减）
  if (rel.boundaries.length) slots.push({ role: 7, type: 'LIT', value: rel.boundaries.slice(-8).join('；') })
  const sdr = memory.space.bundle(
    slots.filter((s) => s.value).map((s) => memory.space.bind(memory.space.identity('V:' + s.value.toLowerCase()), memory.space.role(String(s.role)))),
  )
  return {
    cellId: cellIdFor('affect:relational', [persona.rev], sdr),
    kind: REL_KIND,
    tier: 1,
    flags: FLAG.noDecay,
    tFrom: BigInt(now),
    tTo: BigInt(now),
    tIngest: BigInt(now),
    tAccess: BigInt(now),
    accessCount: 0,
    stability: 365,
    importance: 0.9,
    valence: 0,
    arousal: 0,
    dominance: rel.trust,
    salience: 0.5,
    provenance: 4,
    trust: TRUST_BY_PROVENANCE[4],
    sdr,
    emb: hashEmbedding(`trust ${rel.trust} fam ${rel.familiarity} attune ${rel.attunement}`, memory.config.embDim),
    slots,
    edges: [],
    residual: null,
    confidence: 0.9,
    support: 1,
    topic: 'affect-relational',
    digest: `关系模型 trust=${rel.trust.toFixed(2)} attune=${rel.attunement.toFixed(2)} turns=${rel.turns}`,
  }
}

/** 人格锚 → kind=4 cell，flags.bit1（不可衰减），不参与合并。 */
export function personaCell(memory: MemoryService, persona: PersonaState, now: number): MemCell {
  const slots: Slot[] = [
    { role: 1, type: 'LIT', value: '助手' },
    { role: 3, type: 'LIT', value: 'persona' },
    { role: 2, type: 'LIT', value: `rev=${persona.rev}` },
    { role: 8, type: 'LIT', value: persona.vector.map((x) => x.toFixed(3)).join(',') },
  ]
  const sdr = memory.space.bundle(slots.map((s) => memory.space.bind(memory.space.identity('V:' + s.value.toLowerCase()), memory.space.role(String(s.role)))))
  return {
    cellId: cellIdFor('affect:persona', [persona.rev], sdr),
    kind: PERSONA_KIND,
    tier: 1,
    flags: FLAG.noDecay,
    tFrom: BigInt(now),
    tTo: BigInt(now),
    tIngest: BigInt(now),
    tAccess: BigInt(now),
    accessCount: 0,
    stability: 3650,
    importance: 1,
    valence: 0,
    arousal: 0,
    dominance: 0.5,
    salience: 0.4,
    provenance: 4,
    trust: TRUST_BY_PROVENANCE[4],
    sdr,
    emb: hashEmbedding(`persona ${persona.rev}`, memory.config.embDim),
    slots,
    edges: [],
    residual: null,
    confidence: 1,
    support: 1,
    topic: 'affect-persona',
    digest: `人格锚 rev=${persona.rev}`,
  }
}

export interface SchemaPattern {
  topic: string
  pattern: string
  confidence: number
  support: number
}

/**
 * 离线环：把散落在几十轮里的情感反应，抽象成一条关于"这个人"的图式。
 * 这是整套系统里唯一真正的"学习"——它反过来成为下次评价的先验。
 *
 * 判据刻意保守：样本 < 3 不产结论，置信度按样本量折算。
 * 宁可第一次猜不准，也不要拿一条 3 个样本的"规律"去改变行为。
 */
export function deriveUserSchema(
  history: Array<{ turn: number; topic: string; pad: Pad; strain: number; corrected: boolean }>,
  minSamples = 3,
): SchemaPattern[] {
  const byTopic = new Map<string, Array<{ pad: Pad; strain: number; corrected: boolean }>>()
  for (const h of history) {
    if (!h.topic) continue
    const arr = byTopic.get(h.topic) ?? []
    arr.push({ pad: h.pad, strain: h.strain, corrected: h.corrected })
    byTopic.set(h.topic, arr)
  }
  const out: SchemaPattern[] = []
  for (const [topic, rows] of byTopic) {
    if (rows.length < minSamples) continue
    const strain = avg(rows.map((r) => r.strain))
    const valence = avg(rows.map((r) => r.pad.v))
    const corrections = rows.filter((r) => r.corrected).length
    const conf = Math.min(0.9, 0.4 + rows.length * 0.05)
    if (strain > 0.45) {
      out.push({ topic, pattern: `追问「${topic}」时张力上升（strain ${strain.toFixed(2)}）`, confidence: conf, support: rows.length })
    } else if (valence > 0.3) {
      out.push({ topic, pattern: `谈到「${topic}」时情绪正向（V ${valence.toFixed(2)}）`, confidence: conf, support: rows.length })
    }
    if (corrections >= Math.max(2, rows.length * 0.5)) {
      out.push({ topic, pattern: `「${topic}」上纠正频繁（${corrections}/${rows.length}）：需要更多前置确认`, confidence: conf, support: rows.length })
    }
  }
  return out.slice(0, 6)
}

/** 图式 → kind=3 cell（可被后续 NREM pass 继续合并）。 */
export function schemaCell(memory: MemoryService, p: SchemaPattern, now: number): MemCell {
  const slots: Slot[] = [
    { role: 1, type: 'LIT', value: '用户' },
    { role: 3, type: 'LIT', value: 'schema' },
    { role: 2, type: 'LIT', value: p.topic.slice(0, 24) },
    { role: 6, type: 'LIT', value: p.pattern.slice(0, 48) },
    { role: 8, type: 'LIT', value: String(p.support) },
  ]
  const sdr = memory.space.bundle(slots.map((s) => memory.space.bind(memory.space.identity('V:' + s.value.toLowerCase()), memory.space.role(String(s.role)))))
  return {
    cellId: cellIdFor('affect:schema:' + p.topic, [p.support], sdr),
    kind: SCHEMA_KIND,
    tier: 1,
    flags: 0,
    tFrom: BigInt(now),
    tTo: BigInt(now),
    tIngest: BigInt(now),
    tAccess: BigInt(now),
    accessCount: 0,
    stability: 60,
    importance: 0.7,
    valence: 0,
    arousal: 0,
    dominance: 0.5,
    salience: 0.5,
    provenance: 4,
    trust: TRUST_BY_PROVENANCE[4],
    sdr,
    emb: hashEmbedding(p.pattern, memory.config.embDim),
    slots,
    edges: [],
    residual: null,
    confidence: p.confidence,
    support: p.support,
    topic: 'schema:' + p.topic,
    digest: p.pattern,
  }
}

/** 从库里读回最近一条关系模型 / 人格锚（热重载与重启后的恢复路径）。 */
export function readPersisted(memory: MemoryService): { relational?: RelationalSnapshot; persona?: PersonaState } {
  const relCells = memory.store.listCells({ kind: REL_KIND, limit: 1, order: 'recent' })
  const personaCells = memory.store.listCells({ kind: PERSONA_KIND, limit: 1, order: 'recent' })
  const out: { relational?: RelationalSnapshot; persona?: PersonaState } = {}

  const rel = relCells[0]
  if (rel) {
    const get = (prefix: string) => rel.slots.find((s) => s.value.startsWith(prefix))?.value ?? ''
    const trust = Number(get('trust=').slice(6)) || 0
    const famPart = get('fam=').slice(4).split(',')
    const familiarity = Number(famPart[0]) || 0
    const attunement = Number((famPart.find((x) => x.startsWith('attune=')) ?? 'attune=0.5').slice(7)) || 0.5
    const repairDebt = Number((famPart.find((x) => x.startsWith('debt=')) ?? 'debt=0').slice(5)) || 0
    const turns = Number((rel.slots.find((s) => s.value.startsWith('turns='))?.value ?? 'turns=0').slice(6)) || 0
    const boundary = rel.slots.find((s) => s.role === 7)?.value
    out.relational = {
      trust,
      familiarity,
      attunement,
      repairDebt,
      turns,
      boundaries: boundary ? boundary.split('；').filter(Boolean) : [],
    }
  }

  const persona = personaCells[0]
  if (persona) {
    const rev = Number((persona.slots.find((s) => s.value.startsWith('rev='))?.value ?? 'rev=0').slice(4)) || 0
    const vec = (persona.slots.find((s) => s.role === 8)?.value ?? '').split(',').map(Number).filter((x) => !Number.isNaN(x))
    out.persona = { rev, vector: vec.length ? vec : [0.5, 0.5, 0.5, 0.5] }
  }
  return out
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
}
