/**
 * 隔离、重建、重放、卡片 —— 对应 §14.10 / §14.11 / §14.5(D-05) / §12.7。
 *
 * 这四条都属于"平时看不出来、出事就是事故"的机制：
 *   · 跨会话泄漏 → 合规事故
 *   · 晶格损坏不能重建 → 数据丢失事故
 *   · 重放与当时渲染不一致 → 审计不可信
 *   · 卡片形状不对 → 宿主渲染崩
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from '../packages/devkit/lib/index.js'

const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ sessionId: opts.sessionId ?? 'iso-' + Math.random().toString(36).slice(2), ...opts })
  opened.push(h)
  return h
}
after(async () => {
  for (const h of opened) await h.dispose()
})

// ── 作用域隔离 ──────────────────────────────────────────────────────

test('作用域隔离：情景记忆不跨会话可见', async () => {
  const h = await open()
  await h.turn('构建报错了，是 lockfile 冲突导致的。', { session: 'sess-A' })

  const episodic = h.memory.store.listCells({ kind: 0, limit: 5 })
  assert.ok(episodic.length >= 1, '应有情景 cell')
  assert.equal(episodic[0].session, 'sess-A', `session 字段应记录来源会话，实际 ${episodic[0].session}`)

  const sameSession = h.memory.recall({ text: 'lockfile 冲突 报错', budget: 400, manual: true, sessionId: 'sess-A' })
  const otherSession = h.memory.recall({ text: 'lockfile 冲突 报错', budget: 400, manual: true, sessionId: 'sess-B' })
  assert.ok(sameSession.hits.length >= 1, '本会话应可见')
  assert.equal(otherSession.hits.length, 0, `别的会话不该看到，实际 ${otherSession.hits.length} 条`)
})

test('作用域隔离：scope=global 可以显式放宽（用户要求翻遍所有记忆）', async () => {
  const h = await open()
  await h.turn('构建报错了，是 lockfile 冲突导致的。', { session: 'sess-A' })
  const wide = h.memory.recall({ text: 'lockfile 冲突 报错', budget: 400, manual: true, sessionId: 'sess-B', scope: 'global' })
  assert.ok(wide.hits.length >= 1, '显式 global 时应可见')
})

test('作用域隔离：不同 scopeKey 的记忆互相不可见（多用户 ACL 的地基）', async () => {
  const h = await open({ config: { scopeKey: 'user:alice' } })
  await h.turn('我们决定用 pnpm 部署。')
  const alice = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true, scopeKey: 'user:alice' })
  const bob = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true, scopeKey: 'user:bob' })
  assert.ok(alice.hits.length >= 1, 'alice 应能看到自己的记忆')
  assert.equal(bob.hits.length, 0, `bob 不该看到 alice 的记忆，实际 ${bob.hits.length} 条`)
})

test('作用域隔离：写入时自动带上 scopeKey 与会话', async () => {
  const h = await open({ config: { scopeKey: 'user:carol' } })
  await h.turn('我习惯用深色主题。', { session: 'sess-C' })
  const c = h.memory.store.listCells({ limit: 5 }).find((x) => x.provenance === 0)
  assert.ok(c)
  assert.equal(c.scope, 'user:carol')
  assert.equal(c.session, 'sess-C')
})

// ── 重建 ────────────────────────────────────────────────────────────

test('重建：从会话日志重放，晶格条数可恢复', async () => {
  const h = await open()
  for (let i = 0; i < 5; i++) await h.turn(`第 ${i} 轮：我们决定用 pnpm 部署，缓存按 key 分片。`)
  const before = h.memory.store.countCells()
  const log = h.memory.store.listLog()
  assert.ok(log.length >= 5, `影子日志应有记录，实际 ${log.length}`)

  const r = await h.rebuild()
  assert.equal(r.turns, 5, `应重放 5 轮，实际 ${r.turns}`)
  const afterCount = h.memory.store.countCells()
  assert.ok(afterCount > 0, '重建后不应是空库')
  assert.ok(Math.abs(afterCount - before) <= 3, `重建前后条数应接近（${before} → ${afterCount}）`)
})

test('重建：保留人格锚与关系模型（它们不是对话的派生物）', async () => {
  const h = await open()
  for (let i = 0; i < 6; i++) await h.turn('这件事很重要，请认真对待。')
  const personaBefore = h.memory.store.listCells({ kind: 4, limit: 5 }).length
  assert.ok(personaBefore >= 1)
  await h.rebuild()
  const personaAfter = h.memory.store.listCells({ kind: 4, limit: 5 }).length
  assert.ok(personaAfter >= 1, '重建不该抹掉人格锚')
})

test('重建：没有日志时返回 0，而不是抛错', async () => {
  const h = await open()
  const r = await h.rebuild()
  assert.equal(r.turns, 0)
})

test('重建：命令面需要 --yes 才执行', async () => {
  const h = await open()
  await h.turn('我们决定用 pnpm 部署。')
  const cmd = h.tools.get('mnemo_command')
  const dry = await cmd.execute({ line: 'rebuild --from-log' })
  assert.match(dry.text, /确认请加 --yes/)
  const real = await cmd.execute({ line: 'rebuild --from-log --yes' })
  assert.match(real.text, /重建完成/)
})

// ── 重放一致性（D-05） ─────────────────────────────────────────────

test('重放：按 snapshotId 取回的渲染与当时逐字节一致', async () => {
  const h = await open()
  await h.turn('我习惯用深色主题，浅色看久了眼睛疼。')
  const r = h.memory.recall({ text: '深色主题', budget: 400, manual: true })
  assert.ok(r.snapshotId, '召回应带快照 id')
  const replay = h.memory.replayRecall(r.snapshotId)
  assert.ok(replay, '应能按 id 取回快照')
  assert.equal(replay.rendered, r.rendered, '重放内容必须与当时一致')
  assert.equal(replay.tokens, r.tokens)
  assert.equal(h.memory.replayRecall('deadbeefdeadbeef'), null)
})

test('重放：巩固改写 cell 之后，快照仍然返回当时的文本', async () => {
  const h = await open()
  await h.turn('我习惯用深色主题，浅色看久了眼睛疼。')
  const r = h.memory.recall({ text: '深色主题', budget: 400, manual: true })
  const before = r.rendered
  h.consolidate()
  const replay = h.memory.replayRecall(r.snapshotId)
  assert.equal(replay.rendered, before, '快照是内容寻址的，不受后续改写影响')
})

// ── 对话流卡片 ─────────────────────────────────────────────────────

test('卡片：memory_recall 声明了 call/result 渲染意图', async () => {
  const h = await open()
  await h.turn('我习惯用深色主题。')
  const def = h.tools.get('memory_recall')
  assert.equal(typeof def.presentCall, 'function')
  assert.equal(typeof def.presentResult, 'function')

  const call = def.presentCall({ query: '深色主题' })
  assert.equal(call.card, 'generic')
  assert.equal(call.kind, 'search')
  assert.match(call.title, /深色主题/)

  const value = await def.execute({ query: '深色主题' }, { agent: { session: { id: 'x' } }, signal: new AbortController().signal })
  const result = def.presentResult({ query: '深色主题' }, value)
  assert.equal(result.card, 'generic')
  assert.match(result.title, /记忆 · \d+ 条/)
  assert.ok(result.content?.[0]?.text.includes('M:'), '展开内容应是 MRS')
})

// ── 热重载（§14.7 / §19.6 清单） ───────────────────────────────────

test('热重载：三次装载/卸载后仍可用，且不重复注册', async () => {
  for (let i = 0; i < 3; i++) {
    const h = await createHarness({ sessionId: `reload-${i}` })
    await h.turn(`第 ${i} 次装载后的记忆：我们决定用 pnpm 部署。`)
    const r = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true })
    assert.ok(r.hits.length >= 1, `第 ${i} 次装载后应能召回`)
    await h.dispose()
  }
})

test('热重载：open() 幂等，重复调用不会重复建表', async () => {
  const h = await open()
  const close1 = h.memory.open()
  const close2 = h.memory.open()
  assert.equal(typeof close1, 'function')
  assert.equal(typeof close2, 'function')
  close1()
  close2()
})
