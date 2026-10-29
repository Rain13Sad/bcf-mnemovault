/**
 * 主动开口：时间、副作用、限流、持久化。
 *
 * 这组用例的存在理由很具体——v0.3.0 的 CI 是绿的，但**跨午夜的 bug 还在**：
 * 当时只是把测试里的日期从写死改成"今天"，绕开了路径，而不是修好了路径。
 * 所以这里显式构造跨日场景，断言的是**状态没有被只读调用改掉**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from '@rain13sad/dsh-mnemo-devkit'

const DAY = 86_400_000

/** 取 harness 时钟的"当天某时刻"，再按需偏移天数。 */
function at(h, hour, min = 0, plusDays = 0) {
  const d = new Date(h.now())
  d.setDate(d.getDate() + plusDays)
  d.setHours(hour, min, 0, 0)
  return d.getTime()
}

async function open() {
  const h = await createHarness({ sessionId: 'proactive-test' })
  const svc = h.proactiveService()
  assert.ok(svc, 'mnemo-proactive 未装载')
  svc.config.requireReason = false
  svc.config.idleMin = 1
  svc.config.minIntervalMin = 45
  svc.config.maxPerDay = 3
  svc.config.quietStart = 23
  svc.config.quietEnd = 8
  svc.config.minUrgency = 0.3
  return { h, svc }
}

test('跨午夜：只读的 snapshot() 不得清空当日配额', async () => {
  const { h, svc } = await open()
  const day1 = at(h, 14)
  svc.noteUserActivity(day1 - 3 * 3600_000)

  const c = svc.candidate(day1)
  assert.ok(c, '应给出候选')
  assert.equal(svc.fire(c, day1), true)
  assert.equal(svc.snapshot(day1).todayCount, 1)

  // 次日再读：对外显示"今天 0 次"，但**不能**把昨天的账抹掉
  const day2 = at(h, 14, 0, 1)
  const s2 = svc.snapshot(day2)
  assert.equal(s2.todayCount, 0, '跨日后对外应显示今天 0 次')
  // 关键断言：再读昨天，计数仍然是 1（说明 snapshot 没有写副作用）
  assert.equal(svc.snapshot(day1).todayCount, 1, 'snapshot() 不得修改状态')
  await h.dispose()
})

test('跨午夜后第一次写操作才滚动日期，配额从 1 重新计', async () => {
  const { h, svc } = await open()
  svc.config.maxPerDay = 1
  const day1 = at(h, 14)
  svc.noteUserActivity(day1 - 3 * 3600_000)
  const c1 = svc.candidate(day1)
  assert.equal(svc.fire(c1, day1), true)

  // 当天第二次：撞上限
  assert.equal(svc.candidate(day1 + 3600_000), null)
  assert.ok(svc.snapshot(day1).skipped.some((s) => /上限/.test(s.reason)))

  // 次日：rollDay 生效，可以再说一次
  const day2 = at(h, 14, 0, 1)
  svc.noteUserActivity(day2 - 3 * 3600_000)
  const c2 = svc.candidate(day2)
  assert.ok(c2, '次日应重新获得配额')
  assert.equal(svc.fire(c2, day2), true)
  assert.equal(svc.snapshot(day2).todayCount, 1)
  await h.dispose()
})

test('fire() 自己也会校验：静音/上限/间隔期间不得记账', async () => {
  const { h, svc } = await open()
  const now = at(h, 14)
  svc.noteUserActivity(now - 3 * 3600_000)
  const c = svc.candidate(now)
  assert.ok(c)

  svc.muteFor(3600_000, now)
  assert.equal(svc.fire(c, now), false, '静音期间 fire 必须被拒绝')
  assert.equal(svc.snapshot(now).todayCount, 0)
  assert.ok(svc.snapshot(now).skipped.some((s) => /被拒绝/.test(s.reason)))

  svc.unmute()
  assert.equal(svc.fire(c, now), true)
  assert.equal(svc.snapshot(now).todayCount, 1)

  // 立刻再说一次：撞最小间隔
  assert.equal(svc.fire(c, now + 60_000), false, '最小间隔内 fire 必须被拒绝')
  assert.equal(svc.snapshot(now).todayCount, 1)
  await h.dispose()
})

test('限流状态落盘：重启后不会清零（重启即绕过上限的洞）', async () => {
  const { h, svc } = await open()
  const now = at(h, 14)
  svc.noteUserActivity(now - 3 * 3600_000)
  const c = svc.candidate(now)
  svc.fire(c, now)
  const raw = h.memory.store.meta('proactive:state')
  assert.ok(raw, '状态必须写进 meta')
  const v = JSON.parse(raw)
  assert.equal(v.todayCount, 1)
  assert.ok(v.lastAt > 0)
  await h.dispose()
})

test('边界词命中后静音（头注释承诺过、之前没实现）', async () => {
  const { h, svc } = await open()
  const now = at(h, 14)
  await h.turn('以后别主动找我了，我想安静一阵。', {})
  // 静音 7 天
  assert.ok(svc.snapshot(now).blocked, '命中边界词后应处于静音状态')
  assert.match(String(svc.snapshot(now).blocked), /静音/)
  await h.dispose()
})

test('pickMemory 的紧迫度能过 tick 门槛（0.45 曾让这条路径永远走不到）', async () => {
  const { h, svc } = await open()
  assert.ok(svc.config.minUrgency <= 0.42, 'tick 门槛必须 ≤ pickMemory 的 0.42，否则该路径是死代码')
  await h.dispose()
})
