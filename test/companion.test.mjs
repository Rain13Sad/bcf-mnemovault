/**
 * 陪伴场景新增能力：情感记忆保护 / 联想 / 视角 / 叙事 / 依恋 / 再评估 / 主动开口。
 *
 * 这一组测试的判据都是"行为"，不是"字段存在"——
 * 因为陪伴类功能最容易做成"看起来有，其实不影响任何东西"。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from '../packages/devkit/lib/index.js'

const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ sessionId: opts.sessionId ?? 'cmp-' + Math.random().toString(36).slice(2), ...opts })
  opened.push(h)
  return h
}
after(async () => {
  for (const h of opened) await h.dispose()
})

const EMO = 1 << 6

// ── 情感记忆 ────────────────────────────────────────────────────────

test('情感记忆：情绪波动大的话会被打上 bit6，普通事实不会', async () => {
  const h = await open()
  await h.turn('今天真的很难受，感觉自己什么都做不好。')
  await h.turn('我们的仓库叫 dsh-ui，用 TypeScript 写。')
  const cells = h.memory.store.listCells({ limit: 20 }).filter((c) => c.provenance === 0)
  const emo = cells.filter((c) => (c.flags & EMO) !== 0)
  assert.ok(emo.length >= 1, `应有情感记忆，实际 ${emo.length}/${cells.length}`)
  const plain = cells.filter((c) => (c.flags & EMO) === 0)
  assert.ok(plain.length >= 1, '普通事实不该被标成情感记忆')
})

test('情感记忆：REM 巩固不衰减它的情绪（普通情景记忆会）', async () => {
  const h = await open()
  await h.turn('今天真的很难受，感觉自己什么都做不好。')
  const before = h.memory.store.listCells({ limit: 20 }).filter((c) => (c.flags & EMO) !== 0)
  assert.ok(before.length >= 1)
  const target = before[0]
  const v0 = target.valence

  for (let i = 0; i < 3; i++) h.consolidate()
  const after = h.memory.store.getCell(target.cellId)
  assert.ok(after, '情感记忆不该消失')
  assert.equal(after.valence, v0, `情感记忆的效价不该被衰减（${v0} → ${after.valence}）`)
})

test('情感记忆：降层最多到温层，不会被归档', async () => {
  const h = await open()
  await h.turn('今天真的很难受，感觉自己什么都做不好。')
  const target = h.memory.store.listCells({ limit: 20 }).find((c) => (c.flags & EMO) !== 0)
  assert.ok(target)
  // 直接把访问时间推到一年前，再跑降层
  target.tAccess = BigInt(Date.now() - 365 * 86400_000)
  target.tier = 1
  h.memory.store.putCell(target)
  for (let i = 0; i < 3; i++) h.memory.demoteDue()
  const after = h.memory.store.getCell(target.cellId)
  assert.ok(after.tier <= 2, `情感记忆最多到冷层，实际 tier=${after.tier}`)
})

// ── 联想 ────────────────────────────────────────────────────────────

test('联想：同一轮被一起想起的记忆之间会长出 ASSOC 边，且权重递增', async () => {
  const h = await open()
  await h.turn('我们用 pnpm 构建，用 vitest 跑测试。')
  await h.turn('CI 现在跑 6 分钟，主要是 e2e 太慢。')
  // 一条 query 同时命中多条 → 共激活
  for (let i = 0; i < 3; i++) h.memory.recall({ text: 'pnpm vitest CI e2e', budget: 400, manual: true })
  const assoc = h.memory.store.allEdges().filter((e) => e.rel === 14)
  assert.ok(assoc.length >= 2, `应有 ASSOC 边，实际 ${assoc.length}`)
  assert.ok(Math.max(...assoc.map((e) => e.weight)) > 32, '共激活应让边权增长')
})

test('联想链：associate() 能从一个 cell 走到邻居，且 hop 递增', async () => {
  const h = await open()
  await h.turn('我们用 pnpm 构建，用 vitest 跑测试。')
  await h.turn('CI 现在跑 6 分钟，主要是 e2e 太慢。')
  for (let i = 0; i < 3; i++) h.memory.recall({ text: 'pnpm vitest CI e2e', budget: 400, manual: true })
  // 从"有边的那个 cell"出发（最新一条可能是人格锚，没有 ASSOC 边）
  const withEdges = h.memory.store.allEdges().find((e) => e.rel === 14)
  assert.ok(withEdges, '应已有 ASSOC 边')
  const chain = h.memory.associate(withEdges.src, { depth: 2, limit: 10 })
  assert.ok(chain.length >= 1, '应有联想链')
  assert.ok(chain.every((x) => x.hop >= 1 && x.hop <= 2))
  assert.ok(chain[0].score >= chain[chain.length - 1].score, '应按分数降序')
  assert.equal(h.memory.associate(0xdeadbeefn).length, 0, '孤立节点应返回空链')
})

// ── 视角 ────────────────────────────────────────────────────────────

test('视角：事实/感受/关系 被正确分类，且可按视角检索', async () => {
  const h = await open()
  await h.turn('我们的仓库叫 dsh-ui，用 TypeScript 写。')
  await h.turn('今天真的很难受，感觉自己什么都做不好。')
  await h.turn('谢谢你一直陪着我，我们一起把这件事做完了。')

  const cells = h.memory.store.listCells({ limit: 30 }).filter((c) => c.provenance === 0)
  const lenses = new Set(cells.map((c) => c.lens))
  assert.ok(lenses.has('fact') || lenses.has('feeling'), `实际视角集合 ${[...lenses].join(',')}`)
  assert.ok(lenses.has('bond'), `"我们一起/谢谢" 应被归为关系视角，实际 ${[...lenses].join(',')}`)

  const feelingOnly = h.memory.recall({ text: '难受 做不好', budget: 400, manual: true, lens: 'feeling' })
  assert.ok(feelingOnly.hits.every((x) => {
    const c = h.memory.store.getCell(BigInt('0x' + x.cellId))
    return c.lens === 'feeling'
  }), '视角过滤必须严格')
})

// ── 叙事 ────────────────────────────────────────────────────────────

test('叙事：足够多的情感事件会被串成 kind=6 的故事节点', async () => {
  const h = await open()
  for (const t of [
    '今天真的很难受，感觉自己什么都做不好。',
    '谢谢你一直陪着我，我好多了。',
    '刚才那次吵架是我不对，对不起。',
    '我们和好了，一起去吃了饭。',
  ]) {
    await h.turn(t)
  }
  const r = h.consolidate()
  const stories = h.memory.store.listCells({ kind: 6, limit: 5 })
  assert.ok(stories.length >= 1, `应生成叙事节点，narrated=${r.narrated}`)
  assert.equal(stories[0].lens, 'story')
  assert.ok(stories[0].digest.length > 0)
  assert.ok((stories[0].flags & 2) !== 0, '叙事节点不参与衰减')
})

// ── 依恋 ────────────────────────────────────────────────────────────

test('依恋：随熟悉度与共同情绪事件上升，阶段文案跟着变', async () => {
  const h = await open()
  const a0 = h.affect.attachment()
  for (let i = 0; i < 12; i++) {
    await h.turn(i % 2 ? '今天真的很难受，感觉自己什么都做不好。' : '谢谢你一直陪着我。')
  }
  const a1 = h.affect.attachment()
  assert.ok(a1 > a0, `依恋应上升（${a0} → ${a1}）`)
  const stage = h.affect.stage()
  assert.ok(['stranger', 'familiar', 'close', 'attached'].includes(stage.key))
  assert.ok(stage.progress >= 0 && stage.progress <= 1)
})

// ── 再评估 ──────────────────────────────────────────────────────────

test('再评估：用当前心境重估效价，但不动 support（证据数不是情绪）', async () => {
  const h = await open()
  await h.turn('那次上线失败真是糟透了。')
  const cell = h.memory.store.listCells({ limit: 10 }).find((c) => c.provenance === 0)
  assert.ok(cell)
  const support0 = cell.support
  // 把心境拉正，再重估
  for (let i = 0; i < 6; i++) await h.turn('今天真好，谢谢你。')
  const r = h.affect.reappraise(cell.cellId.toString(16).padStart(16, '0'))
  assert.equal(r.ok, true)
  const after = h.memory.store.getCell(cell.cellId)
  assert.ok(after.valence > r.before, `心境为正时重估应让效价上升（${r.before} → ${after.valence}）`)
  assert.equal(after.support, support0, 'support 不能被情绪改写')
})

// ── 主动开口 ────────────────────────────────────────────────────────

const at = (h, hour, min = 0) => {
  const d = new Date(2026, 9, 28, hour, min, 0, 0)
  return d.getTime()
}

test('主动：静默时段内不开口', async () => {
  const h = await open()
  const svc = h.proactiveService()
  assert.ok(svc)
  const c = svc.candidate(at(h, 3))
  assert.equal(c, null, '凌晨 3 点不该开口')
  assert.ok(svc.snapshot().skipped.some((s) => /静默时段/.test(s.reason)))
})

test('主动：用户刚说过话时不打扰', async () => {
  const h = await open()
  const svc = h.proactiveService()
  const now = at(h, 14)
  svc.noteUserActivity(now - 60_000) // 1 分钟前刚说过
  assert.equal(svc.candidate(now), null)
  assert.ok(svc.snapshot().skipped.some((s) => /刚说过话/.test(s.reason)))
})

test('主动：有由头时才开口，并且记账（每日上限生效）', async () => {
  const h = await open()
  const svc = h.proactiveService()
  svc.config.requireReason = false
  svc.config.idleMin = 1
  svc.config.minIntervalMin = 45
  svc.config.maxPerDay = 1
  const now = at(h, 14)
  svc.noteUserActivity(now - 3 * 3600_000)

  const c = svc.candidate(now)
  assert.ok(c, '应给出候选')
  assert.ok(['silence', 'memory', 'associate', 'emotion', 'milestone'].includes(c.kind))
  svc.fire(c, now)
  assert.equal(svc.snapshot().todayCount, 1)

  // 同日第二次：命中每日上限
  assert.equal(svc.candidate(now + 3600_000), null)
  assert.ok(svc.snapshot().skipped.some((s) => /上限/.test(s.reason)))
})

test('主动：静音后不再开口，解除后恢复', async () => {
  const h = await open()
  const svc = h.proactiveService()
  svc.config.requireReason = false
  svc.config.idleMin = 1
  const now = at(h, 14)
  svc.noteUserActivity(now - 3 * 3600_000)
  svc.muteFor(60 * 60_000, now)
  assert.equal(svc.candidate(now + 1000), null)
  assert.ok(svc.snapshot().skipped.some((s) => /已静音/.test(s.reason)))
  svc.unmute()
  assert.ok(svc.candidate(now + 1000), '解除静音后应能给出候选')
})

test('主动：候选带具体由头，不是模板问候', async () => {
  const h = await open()
  await h.turn('今天真的很难受，感觉自己什么都做不好。')
  await h.turn('谢谢你一直陪着我。')
  const svc = h.proactiveService()
  svc.config.requireReason = true
  svc.config.idleMin = 1
  const now = at(h, 14)
  svc.noteUserActivity(now - 3 * 3600_000)
  const c = svc.candidate(now)
  assert.ok(c, '有情感记忆时应能给出由头')
  assert.ok(c.text.length > 10)
  assert.match(c.text, /主动/)
  assert.ok(c.reason.length > 0)
})

// ── 面板数据 ────────────────────────────────────────────────────────

test('面板快照：带上主动状态、情绪轨迹与依恋', async () => {
  const h = await open()
  for (let i = 0; i < 4; i++) await h.turn(i % 2 ? '今天真的很难受。' : '谢谢你陪着我。')
  const snap = h.panel()
  assert.ok(snap.proactive, '未装 proactive 时应为 null，装了应有值')
  assert.equal(typeof snap.proactive.maxPerDay, 'number')
  assert.ok(Array.isArray(snap.proactive.skipped))
  assert.ok(snap.affect)
  assert.ok(Array.isArray(snap.affect.trajectory) && snap.affect.trajectory.length >= 4)
  assert.equal(typeof snap.affect.attachment, 'number')
  assert.ok(snap.affect.stage && snap.affect.stage.label)
})
