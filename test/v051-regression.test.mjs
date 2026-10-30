/**
 * v0.5.1：扫描式回归。
 *
 * v0.5.0 的 16 条测试全是**单点采样**（测 400 天、测 900 天），
 * 恰好绕过了 365 / 730 天这两个周年窗口——于是三个缺陷（周年振荡、墓碑回潮、
 * 纯时间升档）一条都没被抓住。这一组补的是"扫描"而不是"采样"：
 *
 *   性质 1 单调：无提取、无重放，纯时间推进，tier 只能变冷
 *   性质 2 可达：存在某天到达墓碑，且此后不回退
 *   性质 3 不变量：失效 ⇒ P2，与周年/陈旧无关
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISPOSITION_FLOOR,
  FLAG,
  KIND,
  RETENTION_WEIGHTS,
  SdrSpace,
  decodeCell,
  disposition,
  encodeCell,
  evaluateRetention,
  hashEmbedding,
} from './helpers.mjs'
import { createHarness } from '../packages/devkit/lib/index.js'

const DAY = 86_400_000
const T0 = 1_800_000_000_000
const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ sessionId: 'v051-' + Math.random().toString(36).slice(2), ...opts })
  opened.push(h)
  return h
}
after(async () => {
  for (const h of opened) await h.dispose()
})

const firstCell = (h) => h.memory.store.listCells({ limit: 50 }).find((c) => c.provenance === 0 && c.kind <= 2)

// ── 性质 1 / 2：单调与可达 ─────────────────────────────────────────

test('扫描 10 年（每 7 天一次）：tier 只降不升，且最终到达墓碑', async () => {
  let clock = T0
  const h = await open({ now: () => clock })
  await h.turn('我用 pnpm 构建，CI 跑六分钟。')
  const cell = firstCell(h)
  assert.ok(cell, '应有用户陈述 cell')
  cell.tAccess = BigInt(T0)
  cell.tIngest = BigInt(T0)
  h.memory.store.putCell(cell)

  let prev = cell.tier
  let reachedTomb = false
  const trace = []
  for (let d = 0; d <= 3650; d += 7) {
    clock = T0 + d * DAY
    h.memory.demoteDue()
    const t = h.memory.store.getCell(cell.cellId).tier
    if (t < prev) trace.push(`day ${d}: ${prev}→${t}（升档）`)
    if (t === 4) reachedTomb = true
    prev = t
  }
  assert.deepEqual(trace, [], `出现升档：${trace.join('; ')}`)
  assert.ok(reachedTomb, `10 年内应到达墓碑，实际停在 tier ${prev}`)
  assert.equal(prev, 4, '到达墓碑后不应回退')
})

test('扫描：墓碑不会在周年窗口被自动抬回（v0.5 的 P1 缺陷）', async () => {
  let clock = T0
  const h = await open({ now: () => clock })
  await h.turn('我第一次去西湖是二零一九年。')
  const cell = firstCell(h)
  cell.tAccess = BigInt(T0 - 900 * DAY)
  cell.tIngest = BigInt(T0 - 1400 * DAY)
  h.memory.store.putCell(cell)
  for (let i = 0; i < 8; i++) h.memory.demoteDue()
  assert.equal(h.memory.store.getCell(cell.cellId).tier, 4, '应先进入墓碑')

  // 之后逐周扫过第 3、4、5 个周年
  for (let d = 900; d <= 1900; d += 7) {
    clock = T0 + d * DAY
    h.memory.demoteDue()
    assert.equal(h.memory.store.getCell(cell.cellId).tier, 4, `day ${d}：墓碑被抬回了`)
  }
})

test('周年加成不跨档：窗口内外的 disposition 必须一致', async () => {
  const h = await open()
  await h.turn('我用 pnpm 构建。')
  const cell = firstCell(h)
  const base = { ...cell, tAccess: BigInt(T0 - 730 * DAY), tIngest: BigInt(T0 - 1400 * DAY) }
  const ctx = (now) => ({ nowMs: now, weights: RETENTION_WEIGHTS.balanced })
  const before = evaluateRetention(base, ctx(T0 - 4 * DAY))
  const inWindow = evaluateRetention(base, ctx(T0))
  assert.equal(
    disposition(inWindow.score),
    disposition(before.score),
    `窗口内跨档了：${before.score}(${before.disposition}) → ${inWindow.score}(${inWindow.disposition})`,
  )
  // 加成只能在**本档上沿**以内，绝不能把 P1 顶到 P2
  const p1 = { ...base, importance: 0.05, support: 1, accessCount: 1, tAccess: BigInt(T0 - 700 * DAY) }
  const r = evaluateRetention(p1, ctx(T0))
  if (disposition(r.score) === 'P1') assert.ok(r.score < DISPOSITION_FLOOR.P2)
})

// ── 性质 3：失效不变量 ────────────────────────────────────────────

test('不变量：失效超过宽限期 ⇒ 恒为 P2 / tier 3，与周年、陈旧无关', async () => {
  const h = await open()
  await h.turn('我们用 vitest 跑测试。')
  await h.turn('我们改成 jest 跑测试。')
  const old = h.memory.store.listCells({ limit: 200 }).find((c) => Number(c.tInvalid ?? 0) !== 0)
  assert.ok(old, '应有被取代的旧值')
  const weights = RETENTION_WEIGHTS.balanced
  for (const d of [31, 90, 365, 366, 730, 731, 1460, 3650]) {
    const probe = { ...old, tInvalid: BigInt(T0 - d * DAY) }
    const r = evaluateRetention(probe, { nowMs: T0, weights })
    assert.equal(r.invalid, true, `day ${d} 应判为失效`)
    assert.equal(r.effective, 'P2', `day ${d} 处置应为 P2`)
    assert.equal(r.tier, 3, `day ${d} tier 应为 3`)
    assert.equal(r.protectedBy, null, `day ${d} 闸不应生效`)
  }
})

// ── 墓碑可发现性（v0.5 的 P1 缺陷：includeTombstones 是死开关）────────

test('墓碑可发现：includeTombstones 能按摘要召回已压实的墓碑', async () => {
  let clock = T0
  const h = await open({ now: () => clock })
  await h.turn('我第一次去西湖是二零一九年秋天。')
  const cell = firstCell(h)
  assert.ok(cell)
  cell.tAccess = BigInt(T0 - 900 * DAY)
  cell.tIngest = BigInt(T0 - 1400 * DAY)
  h.memory.store.putCell(cell)
  for (let i = 0; i < 8; i++) h.memory.demoteDue()

  const tomb = h.memory.store.getCell(cell.cellId)
  assert.equal(tomb.tier, 4)
  assert.equal(tomb.emb, null, '墓碑应已丢弃向量')
  assert.equal(tomb.residual, null, '墓碑应已释放残差')
  assert.ok(tomb.digest && tomb.digest.length > 0, '墓碑必须保留摘要')

  const plain = h.memory.recall({ text: tomb.digest, budget: 400, manual: true, readOnly: true })
  assert.ok(!plain.hits.some((x) => BigInt('0x' + x.cellId) === cell.cellId), '默认不该召回墓碑')

  const withTombs = h.memory.recall({
    text: tomb.digest,
    budget: 400,
    manual: true,
    readOnly: true,
    includeTombstones: true,
  })
  assert.ok(
    withTombs.hits.some((x) => BigInt('0x' + x.cellId) === cell.cellId),
    `includeTombstones 仍召不回墓碑（digest=${tomb.digest}）`,
  )
})

// ── 升档只来自使用信号 ────────────────────────────────────────────

test('升档：强命中把归档层记忆拉回一级；纯时间不会', async () => {
  let clock = T0
  const h = await open({ now: () => clock })
  await h.turn('我用 pnpm 构建，别用 npm。')
  const cell = firstCell(h)
  cell.tier = 3
  cell.tAccess = BigInt(T0 - 200 * DAY)
  h.memory.store.putCell(cell)

  // 纯时间推进：不动
  clock = T0 + 30 * DAY
  h.memory.demoteDue()
  assert.equal(h.memory.store.getCell(cell.cellId).tier, 3, '纯时间不该升档')

  // 强命中：升一级
  clock = T0 + 31 * DAY
  h.memory.recall({ text: '我用 pnpm 构建 别用 npm', budget: 400, manual: true })
  assert.equal(h.memory.store.getCell(cell.cellId).tier, 2, '强命中应把归档层拉回冷层')
})

// ── 数据卫生 ──────────────────────────────────────────────────────

test('PAD 钳位：入库的 valence / arousal / dominance 都在 [-1,1]', async () => {
  const h = await open()
  await h.turn('去年这个时候我爷爷走了，我一直很难过，晚上总是睡不着。')
  await h.turn('我特别恶心那种临时甩锅的同事，被当众那样说话我真的一下就崩了。')
  const cells = h.memory.store.listCells({ limit: 200 })
  for (const c of cells) {
    assert.ok(c.valence >= -1 && c.valence <= 1, `valence 越界：${c.valence}（${c.digest}）`)
    assert.ok(c.arousal >= -1 && c.arousal <= 1, `arousal 越界：${c.arousal}`)
    assert.ok(c.dominance >= -1 && c.dominance <= 1, `dominance 越界：${c.dominance}`)
  }
})

test('二进制往返：负的 valence / arousal / dominance 不能被写成无符号', () => {
  const space = new SdrSpace({ dim: 2048, k: 8 })
  const cell = {
    cellId: 0x1234abcdn,
    kind: KIND.semantic,
    tier: 1,
    flags: FLAG.residual,
    tFrom: BigInt(T0),
    tTo: BigInt(T0),
    tIngest: BigInt(T0),
    tAccess: BigInt(T0),
    accessCount: 1,
    stability: 7,
    importance: 0.6,
    valence: -0.54,
    arousal: -0.31,
    dominance: -0.82,
    salience: 0.5,
    provenance: 0,
    trust: 240,
    sdr: space.identity('x'),
    emb: hashEmbedding('负效价', 64),
    slots: [{ role: 1, type: 'LIT', value: '用户' }],
    edges: [],
    residual: null,
    confidence: 0.9,
    support: 1,
    topic: 'neg',
    digest: '负效价',
    tInvalid: 0n,
  }
  const back = decodeCell(encodeCell(cell), space)
  assert.ok(Math.abs(back.valence - -0.54) < 0.01, `valence 符号丢了：${back.valence}`)
  assert.ok(Math.abs(back.arousal - -0.31) < 0.01, `arousal 符号丢了：${back.arousal}`)
  assert.ok(Math.abs(back.dominance - -0.82) < 0.01, `dominance 符号丢了：${back.dominance}`)
})

test('测试时钟：h.now() 必须等于 memory.nowMs()（v0.5 静默失效的坑）', async () => {
  let clock = T0
  const h = await open({ now: () => clock })
  assert.equal(h.now(), T0)
  assert.equal(h.memory.nowMs(), T0, 'harness 的时钟没有传导到 MemoryService')
  clock = T0 + 1000 * DAY
  assert.equal(h.memory.nowMs(), T0 + 1000 * DAY)
})
