/**
 * v0.5.2 · 倒排索引与规模路径（T1/T2/T5 的回归）
 *
 * 这一组测的不是"跑得快"，而是**"快了之后结果还一样"**。
 * 索引最危险的失效方式是漏召回：它不报错，只是悄悄少给你几条。
 * 所以这里的核心断言是"索引路径 == 全扫路径"，而不是"索引很快"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BitInvertedIndex,
  SdrSpace,
  createStore,
  deriveCellId,
  hashEmbedding,
  minOverlapForContainment,
  minOverlapForJaccard,
  forEachBit,
} from './helpers.mjs'
import { createHarness } from '../packages/devkit/lib/index.js'

const space = new SdrSpace({ dim: 2048, k: 8 })

function mkSdr(text) {
  return space.identity('T:' + text)
}

test('minOverlapForJaccard 是**必要条件**：任何 J ≥ 门限的 pair 都满足它', () => {
  // 随机造 200 对 SDR，凡是 Jaccard ≥ 门限的，重叠位数必须 ≥ 返回值
  let checked = 0
  for (let i = 0; i < 200; i++) {
    const a = mkSdr('a' + (i % 20))
    const b = mkSdr('a' + ((i * 7) % 20))
    const na = space.popcount(a)
    const nb = space.popcount(b)
    let inter = 0
    for (let w = 0; w < a.length; w++) {
      let x = a[w] & b[w]
      while (x) {
        inter++
        x &= x - 1
      }
    }
    const j = inter / (na + nb - inter)
    if (j >= 0.85) {
      checked++
      assert.ok(
        inter >= minOverlapForJaccard(na, 0.85),
        `J=${j.toFixed(2)} 但 overlap=${inter} < ${minOverlapForJaccard(na, 0.85)}`,
      )
    }
  }
  // 完全相同的 SDR 必然命中，至少验证了 20 次
  assert.ok(checked >= 20, `只检查到 ${checked} 对，样本不足`)
})

test('minOverlapForContainment 是**必要条件**：containment > 门限的必然入选', () => {
  const q = space.bundle([mkSdr('x'), mkSdr('y')])
  const nq = space.popcount(q)
  const floor = 0.09 + 0.05 * (1 - 0.09)
  const need = minOverlapForContainment(nq, floor)
  const c = space.bundle([mkSdr('x'), mkSdr('y'), mkSdr('z')])
  let inter = 0
  for (let w = 0; w < q.length; w++) {
    let x = q[w] & c[w]
    while (x) {
      inter++
      x &= x - 1
    }
  }
  assert.ok(inter / nq > floor, '构造的样例本身应满足门限')
  assert.ok(inter >= need, `overlap=${inter} < ${need}`)
})

test('倒排：candidatesByOverlap 返回超集，且 overlap 是**真实**位数', () => {
  const idx = new BitInvertedIndex(space, 1000)
  const cells = []
  for (let i = 0; i < 60; i++) {
    const sdr = space.bundle([mkSdr('k' + (i % 12)), mkSdr('v' + i)])
    const id = BigInt(i + 1)
    cells.push({ id, sdr })
    idx.add(id, sdr, i % 3)
  }
  const q = space.bundle([mkSdr('k3'), mkSdr('v7')])
  const cands = idx.candidatesByOverlap(q, 3)
  // 与全扫对拍：凡是 J ≥ 0.45 的必须在候选里，且 overlap 必须一致
  const byId = new Map(cands.map((c) => [c.id, c]))
  for (const c of cells) {
    let inter = 0
    for (let w = 0; w < q.length; w++) {
      let x = q[w] & c.sdr[w]
      while (x) {
        inter++
        x &= x - 1
      }
    }
    const union = space.popcount(q) + space.popcount(c.sdr) - inter
    const j = inter / union
    if (j >= 0.45) {
      assert.ok(byId.has(c.id), `J=${j.toFixed(2)} 的 cell ${c.id} 被漏掉了`)
      assert.equal(byId.get(c.id).overlap, inter, `overlap 报错了（${byId.get(c.id).overlap} ≠ ${inter}）`)
      assert.equal(byId.get(c.id).size, space.popcount(c.sdr))
    }
  }
})

test('倒排：remove 之后不再出现在候选里；add 同 id 换 SDR 会替换', () => {
  const idx = new BitInvertedIndex(space, 1000)
  const a = mkSdr('alpha')
  const b = mkSdr('beta')
  idx.add(1n, a, 0)
  assert.equal(idx.candidatesByOverlap(a, 8).length, 1)
  idx.remove(1n)
  assert.equal(idx.candidatesByOverlap(a, 8).length, 0)

  idx.add(2n, a, 0)
  idx.add(2n, b, 0) // 同 id 换 SDR
  assert.equal(idx.candidatesByOverlap(a, 8).length, 0, '旧 SDR 不应还能查到')
  assert.equal(idx.candidatesByOverlap(b, 8).length, 1, '新 SDR 应能查到')
})

test('倒排：超预算时整体停用并**上报**（不静默降级）', () => {
  const idx = new BitInvertedIndex(space, 3)
  for (let i = 0; i < 5; i++) idx.add(BigInt(i + 1), mkSdr('o' + i), 0)
  const st = idx.stats()
  assert.equal(st.disabled, true, '超预算必须置 disabled')
  assert.equal(idx.candidatesByOverlap(mkSdr('o0'), 1).length, 0, '停用后不再返回候选（调用方会全扫）')
})

test('forEachBit 与 popcount 一致（位遍历不能漏位）', () => {
  for (let i = 0; i < 40; i++) {
    const sdr = space.bundle([mkSdr('p' + i), mkSdr('q' + (i % 5))])
    let n = 0
    forEachBit(sdr, () => n++)
    assert.equal(n, space.popcount(sdr))
  }
})

test('时间区间查询与全扫等价（Q4 走索引不能改变结果）', async () => {
  const h = await createHarness({ sessionId: 'v052-time' })
  try {
    for (let i = 0; i < 12; i++) await h.turn(`第 ${i} 天：模块 ${i} 用方案 ${i % 3}。`, { advanceMs: 86_400_000 })
    const from = h.now() - 6 * 86_400_000
    const to = h.now() - 2 * 86_400_000
    const viaIndex = h.memory.store.cellsInTimeRange(from, to).map((x) => x.toString(16)).sort()
    const viaScan = []
    h.memory.store.forEachCell((c) => {
      const tf = Number(c.tFrom)
      if (tf >= from && tf <= to) viaScan.push(c.cellId.toString(16))
    })
    assert.deepEqual(viaIndex, viaScan.sort(), '索引结果必须与全扫逐条一致')
  } finally {
    await h.dispose()
  }
})

test('索引自愈：外部写入（绕过 ingest）之后仍能去重', async () => {
  const h = await createHarness({ sessionId: 'v052-heal' })
  try {
    await h.turn('我们用 pnpm 构建。')
    // 绕过 ingest 直接写一条：模拟巩固器/rebuild 的写入路径。
    // 必须挑**用户陈述**那条（kind 1），不能拿 listCells 的第一条——
    // 那可能是人格锚/关系模型（kind 4/5），它们的 SDR 与被测句子无关。
    const cell = h.memory.store.listCells({ kind: 1, limit: 1 })[0]
    assert.ok(cell, '应有至少一条用户陈述')
    h.memory.store.putCell({ ...cell, cellId: deriveCellId('external', [1], cell.sdr) })
    // 计数变了 → 索引应整体重建，而不是带着脏数据继续用
    const before = h.memory.store.countCells()
    await h.turn('我们用 pnpm 构建。')
    assert.equal(h.memory.store.countCells(), before, '同一句仍应合并（说明索引没有漏）')
  } finally {
    await h.dispose()
  }
})

test('矛盾检测走索引后仍然抓得到"用户改主意"', async () => {
  const h = await createHarness({ sessionId: 'v052-conflict' })
  try {
    await h.turn('我喜欢深色主题。')
    await h.turn('我不喜欢深色主题了。')
    const edges = h.memory.store.allEdges()
    assert.ok(edges.some((e) => e.rel === 6), '应有 CONTRADICTS')
    assert.ok(edges.some((e) => e.rel === 7), '应有 SUPERSEDES')
  } finally {
    await h.dispose()
  }
})

test('索引在 MemoryStore 与 SqliteStore 上行为一致', async () => {
  const mem = createStore({ kind: 'memory', space })
  const tmp = `:memory:`
  const sql = createStore({ kind: 'sqlite', path: tmp, space })
  sql.open()
  try {
    const ids = []
    for (let i = 0; i < 5; i++) {
      const sdr = space.bundle([mkSdr('m' + i)])
      const cell = {
        cellId: BigInt(1000 + i),
        kind: 1,
        tier: 0,
        flags: 0,
        tFrom: BigInt(1000 + i),
        tTo: BigInt(1000 + i),
        tIngest: BigInt(1000 + i),
        tAccess: BigInt(1000 + i),
        accessCount: 1,
        stability: 7,
        importance: 0.5,
        valence: 0,
        arousal: 0,
        dominance: 0,
        salience: 0.5,
        provenance: 0,
        trust: 240,
        sdr,
        emb: hashEmbedding('m' + i, 128),
        slots: [{ role: 3, type: 'LIT', value: 'm' + i }],
        edges: [],
        residual: null,
        confidence: 0.8,
        support: 1,
        topic: 'm' + i,
        digest: 'm' + i,
        tInvalid: 0n,
      }
      mem.putCell(cell)
      sql.putCell(cell)
      ids.push(cell.cellId)
    }
    assert.equal(mem.countCells(), sql.countCells())
    assert.deepEqual(mem.cellsInTimeRange(1000, 1003), sql.cellsInTimeRange(1000, 1003))
    assert.deepEqual(mem.findBySuffix('3e9').length, sql.findBySuffix('3e9').length)
    // 聚合计数两驱动同口径
    assert.deepEqual(mem.counts().byTier, sql.counts().byTier)
    assert.equal(mem.counts().supportOne, sql.counts().supportOne)
  } finally {
    sql.close()
  }
})
