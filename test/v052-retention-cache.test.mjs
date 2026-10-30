/**
 * v0.5.2 · 保留度缓存与单调性剪枝（T3 的回归）
 *
 * ── 这一组为什么必须是"扫描式" ────────────────────────────────────
 * v0.5.0 的 16 条测试是单点采样（测第 400 天、第 900 天），恰好绕过了 365/730
 * 两个周年窗口，于是三个缺陷一条都没被抓到。v0.5.1 用扫描式测试补上了这个教训。
 *
 * 剪枝的错误方式是**错降**——它不报错，只是把不该降的记忆降下去，而且降得很安静。
 * 所以这里断言的核心是"剪枝给出的每一个'该降'，全量计算也认为是'该降'"，
 * 以及"增量扫描跑够轮数之后，结果与一次全量扫描一致"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { RETENTION_WEIGHTS, evaluateRetention, dispositionForTier } from './helpers.mjs'
import { createHarness } from '../packages/devkit/lib/index.js'

const DAY = 86_400_000

/** 把库里的用户陈述推到很久以前，返回受影响的 id。 */
function age(memory, now, days) {
  const ids = []
  memory.store.listCells({ limit: 500 }).forEach((c) => {
    if (c.kind > 2) return
    if (c.flags & 2) return
    c.tAccess = BigInt(now - days * DAY)
    c.tIngest = BigInt(now - (days + 400) * DAY)
    memory.store.putCell(c)
    ids.push(c.cellId)
  })
  return ids
}

test('缓存只被用来"提前降"，不会被用来"提前不降"（剪枝是保守方向）', async () => {
  const h = await createHarness({ sessionId: 'v052-prune' })
  try {
    for (const t of ['我们用 pnpm。', 'CI 跑六分钟。', '日志放 stderr。']) await h.turn(t)
    const now = h.now()
    age(h.memory, now, 500)
    // 先跑一轮让缓存落下来
    h.memory.demoteDue()

    const weights = RETENTION_WEIGHTS.balanced
    const cached = h.memory.store.demotableByCache(1000)
    assert.ok(cached.length > 0, '应该至少有缓存判定该降的条目')
    for (const id of cached) {
      const cell = h.memory.store.getCell(id)
      if (!cell) continue
      // 全量计算：用与 demoteDue 相同的口径（不传 degree 也可以，连通性只影响分数不影响结论方向）
      const r = evaluateRetention(cell, { nowMs: now, weights })
      assert.ok(
        r.tier > cell.tier,
        `剪枝说"该降"，全量却算出 tier ${r.tier} ≤ 当前 ${cell.tier}（id=${id.toString(16)}）`,
      )
    }
  } finally {
    await h.dispose()
  }
})

test('增量降档：小批量跑够轮数后，结果与大批量一致', async () => {
  const small = await createHarness({ sessionId: 'v052-batch', config: { index: { demoteBatch: 2, sdrEnabled: true, sdrMaxCells: 200_000, retentionTtlMs: 60_000 } } })
  const big = await createHarness({ sessionId: 'v052-batch', config: { index: { demoteBatch: 5000, sdrEnabled: true, sdrMaxCells: 200_000, retentionTtlMs: 60_000 } } })
  try {
    const lines = ['我用 pnpm。', 'CI 跑六分钟。', '日志放 stderr。', '字体用等宽。', '不用 Redux。']
    for (const t of lines) {
      await small.turn(t)
      await big.turn(t)
    }
    const now = small.now()
    age(small.memory, now, 1200)
    age(big.memory, now, 1200)

    /**
     * 两边都跑到**收敛**（连续两轮 0 移动）再比。
     *
     * 不能"小批量跑 20 轮、大批量跑 2 轮"——降档一次只移动一级（迟滞设计），
     * 所以大批量也需要 4 轮才能走完 0→1→2→3→4。第一版就是这么写错的，
     * 结果比的是"跑了不同轮数"而不是"增量 vs 全量"。
     */
    const converge = (h) => {
      let idle = 0
      for (let i = 0; i < 200 && idle < 2; i++) idle = h.memory.demoteDue() === 0 ? idle + 1 : 0
    }
    converge(small)
    converge(big)

    const tiers = (h) =>
      h.memory.store
        .listCells({ limit: 500 })
        .filter((c) => c.kind <= 2)
        .map((c) => c.tier)
        .sort()
    assert.deepEqual(tiers(small), tiers(big), '增量扫描跑够轮数后应与全量结果一致')
    assert.ok(tiers(big).every((t) => t >= 3), `1200 天未访问应至少落到归档层，实际 ${tiers(big).join(',')}`)
  } finally {
    await small.dispose()
    await big.dispose()
  }
})

test('一次 pass 不会移动超过预算', async () => {
  const h = await createHarness({ sessionId: 'v052-budget', config: { index: { demoteBatch: 2, sdrEnabled: true, sdrMaxCells: 200_000, retentionTtlMs: 60_000 } } })
  try {
    for (let i = 0; i < 12; i++) await h.turn(`第 ${i} 条：模块 ${i} 用方案 ${i % 3}。`)
    age(h.memory, h.now(), 900)
    const moved = h.memory.demoteDue()
    assert.ok(moved <= 2, `预算 2 却移动了 ${moved} 条`)
  } finally {
    await h.dispose()
  }
})

test('降档 pass 只降不升（纯时间推进不能把记忆重新烫热）', async () => {
  const h = await createHarness({ sessionId: 'v052-monotone' })
  try {
    for (const t of ['我用 pnpm。', 'CI 跑六分钟。']) await h.turn(t)
    age(h.memory, h.now(), 400)
    for (let i = 0; i < 6; i++) h.memory.demoteDue()
    const before = h.memory.store.listCells({ limit: 200 }).map((c) => c.tier)
    // 再推进 5 年，跑更多 pass：tier 只能更冷，不能回暖
    h.advance?.(365 * 5 * DAY)
    for (let i = 0; i < 6; i++) h.memory.demoteDue()
    const after = h.memory.store.listCells({ limit: 200 }).map((c) => c.tier)
    for (let i = 0; i < before.length; i++) {
      assert.ok(after[i] >= before[i], `第 ${i} 条 tier 从 ${before[i]} 回到 ${after[i]}`)
    }
  } finally {
    await h.dispose()
  }
})

test('dispositionForTier 与 tierForDisposition 互逆', async () => {
  const { tierForDisposition } = await import('./helpers.mjs')
  for (const d of ['P5', 'P4', 'P3', 'P2', 'P1']) {
    assert.equal(dispositionForTier(tierForDisposition(d)), d)
  }
})

test('墓碑不进 stalestForRetention（不再参与自动流转）', async () => {
  const h = await createHarness({ sessionId: 'v052-tomb' })
  try {
    for (const t of ['我用 pnpm。', 'CI 跑六分钟。']) await h.turn(t)
    age(h.memory, h.now(), 3000)
    for (let i = 0; i < 10; i++) h.memory.demoteDue()
    const tombs = h.memory.store.listCells({ limit: 200 }).filter((c) => c.tier >= 4)
    assert.ok(tombs.length > 0, '极久未访问应能进墓碑')
    const ids = new Set(h.memory.store.stalestForRetention(1000, h.now()).map((x) => x.toString(16)))
    for (const t of tombs) {
      assert.ok(!ids.has(t.cellId.toString(16)), '墓碑不应出现在待评估列表里')
    }
  } finally {
    await h.dispose()
  }
})
