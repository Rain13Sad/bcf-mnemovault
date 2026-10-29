/**
 * v0.4.0 新增能力的回归：保留度六档、再巩固、神经调制、生命周期抽象、情绪事件机。
 *
 * 这一组的判据都是**可证伪的行为**，不是"字段存在"：
 *   · 重要但不常提的事，90 天后不该掉进墓碑
 *   · 情感记忆不该被自动降档
 *   · 被纠正过的记忆，置信度要下降
 *   · 没被接住的情绪，强度要**上升**而不是下降
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLAG,
  KIND,
  MemoryStore,
  RETENTION_WEIGHTS,
  SdrSpace,
  actrActivation,
  activationNorm,
  abstractCandidates,
  createStore,
  disposition,
  evaluateRetention,
  graphHopsFor,
  hashEmbedding,
  neuromodulate,
  nextTier,
  onRetrieved,
  protectedFromDeletion,
  retentionScore,
  retrievalTemperature,
  tierForDisposition,
} from './helpers.mjs'
import {
  acknowledge,
  classifyEmotion,
  decayEpisode,
  neglectQueue,
  openEpisode,
} from '../packages/affect/lib/index.js'
import { createHarness } from '../packages/devkit/lib/index.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const space = new SdrSpace({ dim: 2048, k: 8 })

function mkCell(over = {}) {
  const slots = [
    { role: 1, type: 'LIT', value: '用户' },
    { role: 2, type: 'LIT', value: 'pnpm' },
    { role: 3, type: 'LIT', value: 'uses' },
  ]
  const sdr = space.bundle(slots.map((s) => space.bind(space.identity('V:' + s.value), space.role(String(s.role)))))
  return {
    cellId: 0x1234abcdn,
    kind: KIND.semantic,
    tier: 1,
    flags: 0,
    tFrom: BigInt(NOW - 90 * DAY),
    tTo: BigInt(NOW - 90 * DAY),
    tIngest: BigInt(NOW - 200 * DAY),
    tAccess: BigInt(NOW - 90 * DAY),
    accessCount: 1,
    stability: 7,
    importance: 0.5,
    valence: 0,
    arousal: 0,
    dominance: 0.5,
    salience: 0.5,
    provenance: 1,
    trust: 200,
    sdr,
    emb: hashEmbedding('用户用 pnpm', 128),
    slots,
    edges: [],
    residual: null,
    confidence: 0.9,
    support: 1,
    topic: 'user-pnpm-uses',
    digest: '用户用 pnpm',
    tInvalid: 0n,
    ...over,
  }
}

const ctxOf = (over = {}) => ({ nowMs: NOW, weights: RETENTION_WEIGHTS.fidelity, ...over })

let harness
after(async () => {
  await harness?.dispose()
})

// ── ACT-R 激活 ──────────────────────────────────────────────────────

test('ACT-R：近期访问的激活高于久远访问，多次访问高于单次', () => {
  const recent = actrActivation(1, NOW - 3600_000, NOW - 3600_000, NOW)
  const old = actrActivation(1, NOW - 365 * DAY, NOW - 365 * DAY, NOW)
  assert.ok(recent > old, `recent=${recent} old=${old}`)

  const many = actrActivation(8, NOW - 3600_000, NOW - 60 * DAY, NOW)
  assert.ok(many > recent, `many=${many} recent=${recent}`)

  const n1 = activationNorm(old)
  assert.ok(n1 >= 0 && n1 <= 1)
  assert.ok(activationNorm(recent) > n1)
})

// ── 保留度 ──────────────────────────────────────────────────────────

test('保留度：重要但不常提的事，90 天后仍在 P4 以上（fidelity 档）', () => {
  const important = mkCell({ importance: 0.85 })
  const r = evaluateRetention(important, ctxOf())
  assert.ok(
    r.disposition === 'P4' || r.disposition === 'P5',
    `disposition=${r.disposition} score=${r.score}`,
  )
})

test('保留度：同等年龄下，重要度高的分数严格高于重要度低的', () => {
  const a = evaluateRetention(mkCell({ importance: 0.9 }), ctxOf()).score
  const b = evaluateRetention(mkCell({ importance: 0.1 }), ctxOf()).score
  assert.ok(a > b, `high=${a} low=${b}`)
})

test('保留度：情感记忆（高唤醒闪光灯）强行拉回热层，且命中删除闸', () => {
  const emo = mkCell({ flags: FLAG.emotional, valence: -0.8, arousal: 0.6, tAccess: BigInt(NOW - 400 * DAY) })
  const r = evaluateRetention(emo, ctxOf())
  assert.equal(r.disposition, 'P5')
  assert.equal(r.tier, 0)
  assert.equal(r.protectedBy, '情感记忆（闪光灯）')
})

test('保留度：六档阈值单调，且档位到 tier 的映射是 P5→热、P1→归档', () => {
  assert.equal(disposition(0.9), 'P5')
  assert.equal(disposition(0.6), 'P4')
  assert.equal(disposition(0.4), 'P3')
  assert.equal(disposition(0.2), 'P2')
  assert.equal(disposition(0.05), 'P1')
  assert.equal(tierForDisposition('P5'), 0)
  assert.equal(tierForDisposition('P4'), 1)
  assert.equal(tierForDisposition('P3'), 2)
  assert.equal(tierForDisposition('P1'), 3)
})

test('保留度：score 恒在 0..1，且冗余会扣分', () => {
  const w = RETENTION_WEIGHTS.balanced
  const base = {
    activation: 0.6,
    importance: 0.6,
    affectIntensity: 0.2,
    connectivity: 0.3,
    narrativeRole: 0,
    userAffinity: 0,
    spacing: 0.2,
    redundancy: 0,
  }
  const clean = retentionScore(base, w)
  const dup = retentionScore({ ...base, redundancy: 1 }, w)
  assert.ok(clean > dup)
  assert.ok(clean <= 1 && dup >= 0)
})

test('删除闸：pin / 情感 / 人格锚 / 里程碑 / 一手事实 / 版本链 / 被引用，逐条命中', () => {
  assert.equal(protectedFromDeletion(mkCell({ flags: FLAG.noDecay })), '用户 pin')
  assert.equal(protectedFromDeletion(mkCell({ flags: FLAG.emotional })), '情感记忆（闪光灯）')
  assert.equal(protectedFromDeletion(mkCell({ kind: KIND.persona })), '人格锚')
  assert.equal(protectedFromDeletion(mkCell({ kind: KIND.narrative, flags: FLAG.milestone })), '关系里程碑')
  assert.equal(protectedFromDeletion(mkCell({ trust: 240, provenance: 0 })), '用户亲口所述的一手事实')
  assert.equal(protectedFromDeletion(mkCell(), { hasSupersedes: true }), '版本链环节（删了历史就断了）')
  assert.equal(protectedFromDeletion(mkCell(), { referencedByOthers: true }), '仍被其他记忆引用')
  assert.equal(protectedFromDeletion(mkCell()), null)
})

test('降档一次只走一级：热不能直接掉到归档', () => {
  assert.equal(nextTier(0, 3), 1)
  assert.equal(nextTier(1, 3), 2)
  assert.equal(nextTier(3, 0), 2)
  assert.equal(nextTier(2, 2), 2)
})

// ── 再巩固 ──────────────────────────────────────────────────────────

test('再巩固：预测误差大 → 进入可塑窗口，置信度下降、稳定性仍上升', () => {
  const cell = mkCell({ tAccess: BigInt(NOW - 10 * DAY), accessCount: 1, confidence: 0.9, stability: 7 })
  const d = onRetrieved(cell, { retrievalStrength: 0.8, predictionError: 0.7, nowMs: NOW })
  assert.equal(d.plastic, true)
  assert.ok(d.dConfidence < 0, `dConfidence=${d.dConfidence}`)
  assert.ok(d.dStability > 0, `dStability=${d.dStability}`)
})

test('再巩固：提取越多次，可塑性越小（记忆硬化）', () => {
  const fresh = onRetrieved(mkCell({ accessCount: 1 }), { retrievalStrength: 0.5, predictionError: 0.7, nowMs: NOW })
  const old = onRetrieved(mkCell({ accessCount: 40 }), { retrievalStrength: 0.5, predictionError: 0.7, nowMs: NOW })
  assert.ok(old.labile < fresh.labile, `old=${old.labile} fresh=${fresh.labile}`)
  assert.ok(Math.abs(old.dConfidence) < Math.abs(fresh.dConfidence))
})

// ── 神经调制 ────────────────────────────────────────────────────────

test('神经调制：新信息多 → 编码模式，图跳数收窄；应激高 → 再收窄', () => {
  const encoding = neuromodulate({ novelty: 0.9, arousal: 0.5 })
  assert.equal(graphHopsFor(encoding, 2), 1)
  const retrieving = neuromodulate({ novelty: 0.05 })
  assert.equal(graphHopsFor(retrieving, 2), 3)
  const stressed = neuromodulate({ novelty: 0.05, load: 0.9, conflict: 0.9 })
  assert.equal(graphHopsFor(stressed, 2), 2)
  assert.ok(stressed.cort > 0.8)
})

test('神经调制：高唤醒降低检索温度（只取最强通道）', () => {
  const calm = retrievalTemperature(neuromodulate({ arousal: 0.05 }))
  const wired = retrievalTemperature(neuromodulate({ arousal: 0.95 }))
  assert.ok(wired < calm, `wired=${wired} calm=${calm}`)
})

// ── 生命周期抽象 ────────────────────────────────────────────────────

test('巩固抽象：同骨架同话题、跨天出现 3 次 → 成为图式候选', () => {
  const mk = (d) => mkCell({ kind: KIND.episodic, tFrom: BigInt(NOW - d * DAY), tAccess: BigInt(NOW - d * DAY) })
  const cands = abstractCandidates([mk(6), mk(4), mk(1)], { minSupport: 3 })
  assert.equal(cands.length, 1)
  assert.equal(cands[0].support, 3)
  assert.ok(cands[0].spanDays >= 5)
})

test('巩固抽象：同一天里说三遍不算规律（跨度必须 > 1 天）', () => {
  const mk = (h) => mkCell({ kind: KIND.episodic, tFrom: BigInt(NOW - h * 3600_000), tAccess: BigInt(NOW - h * 3600_000) })
  const cands = abstractCandidates([mk(1), mk(2), mk(3)], { minSupport: 3 })
  assert.equal(cands.length, 0)
})

// ── 情绪事件机 ──────────────────────────────────────────────────────

test('OCC：结果好且确定 → satisfaction；结果差且不确定 → fear', () => {
  const good = classifyEmotion({ goalRel: 0.2, goalCon: 0.8, agency: 0, certainty: 0.9, novelty: 0.2, norm: 0 })
  assert.equal(good[0].label, 'satisfaction')
  const bad = classifyEmotion({ goalRel: 0.2, goalCon: -0.8, agency: 0, certainty: 0.1, novelty: 0.2, norm: 0 })
  assert.equal(bad[0].label, 'fear')
})

test('情绪事件：未获回应的情绪，强度随时间上升（规则 1）', () => {
  const e = openEpisode({ trigger: '被甲方否了方案', at: NOW, valence: -0.7, arousal: 0.6, peak: 0.6 })
  const t0 = decayEpisode(e, NOW)
  const t3 = decayEpisode(e, NOW + 3 * DAY)
  assert.ok(t3 > t0, `t0=${t0} t3=${t3}`)
  assert.equal(e.status, 'open')
})

test('情绪事件：接住之后才开始衰减，且不再占强制关怀槽', () => {
  const e = openEpisode({ trigger: '被甲方否了方案', at: NOW, valence: -0.7, arousal: 0.6, peak: 0.6 })
  assert.equal(neglectQueue([e], NOW).length, 1)
  const acked = acknowledge(e, NOW)
  const later = NOW + 12 * 3600_000
  assert.ok(decayEpisode(acked, later) < decayEpisode(e, later), '接住后强度应低于未接住')
})

test('情绪事件：负效价的衰减阻力更高（难哄是机制，不是 bug）', () => {
  const neg = openEpisode({ trigger: 'x', at: NOW, valence: -0.8, arousal: 0.5 })
  const pos = openEpisode({ trigger: 'y', at: NOW, valence: 0.8, arousal: 0.5 })
  assert.ok(neg.decayResistance > pos.decayResistance)
})

// ── 存储：前缀索引 ──────────────────────────────────────────────────

test('前缀查询：MemoryStore 与 SqliteStore 都能按低 32 位找回完整 id', () => {
  const cells = [mkCell({ cellId: 0xaaaabbbbccccddddn }), mkCell({ cellId: 0x1111222233334444n })]
  const mem = new MemoryStore(space)
  for (const c of cells) mem.putCell(c)
  assert.equal(mem.findByPrefix(0xccccdddd), 0xaaaabbbbccccddddn)
  assert.equal(mem.findByPrefix(0xdeadbeef), null)

  const sql = createStore({ kind: 'sqlite', path: ':memory:', space })
  sql.open()
  try {
    for (const c of cells) sql.putCell(c)
    assert.equal(sql.findByPrefix(0x33334444), 0x1111222233334444n)
    assert.equal(sql.findByPrefix(0x00000001), null)
  } finally {
    sql.close()
  }
})

// ── 集成：面板快照带上保留度 ────────────────────────────────────────

test('面板快照：包含保留度视图，六档计数与条目一致', async () => {
  harness = await createHarness({ sessionId: 'v04-panel', config: { preset: 'balanced' } })
  await harness.turn('我们用 pnpm 构建，CI 跑 6 分钟。')
  await harness.turn('今天真的很难受，感觉自己什么都做不好。')
  const snap = harness.memory.panelSnapshot()
  assert.ok(snap.retention, '快照应带 retention')
  const r = snap.retention
  assert.ok(r.entries.length >= 1)
  const sum = Object.values(r.byDisposition).reduce((n, v) => n + v, 0)
  assert.ok(sum >= r.entries.length, `byDisposition 合计 ${sum} < 条目数 ${r.entries.length}`)
  assert.ok(r.entries.every((e) => e.score >= 0 && e.score <= 1))
  assert.ok(typeof r.neuromod.da === 'number')
  assert.ok(['encode', 'retrieve'].includes(r.mode))
})
