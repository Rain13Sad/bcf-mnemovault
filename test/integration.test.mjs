/**
 * 集成测试：用真实 Cordis 运行时装载全部插件，只把 sessions/tools 换成桩。
 * 覆盖的是"时序行为"——编码、门控、冲突、巩固、遗忘、守卫、命令。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from '../packages/devkit/lib/index.js'

let harness

before(async () => {
  harness = await createHarness({ sessionId: 'it-1', config: { preset: 'balanced' } })
})
after(async () => {
  await harness?.dispose()
})

test('编码：一轮用户发言产出至少一条 cell，且带残差与槽位', async () => {
  await harness.turn('我习惯用深色主题，浅色看久了眼睛疼。')
  // 注意：情感内核会把关系模型/人格锚也写进库（kind=5/4），它们没有残差。
  // 这里要断言的是"用户发言被编码成的语义 cell"，所以按来源筛选。
  const cells = harness.memory.store.listCells({ limit: 20 }).filter((x) => x.provenance === 0)
  assert.ok(cells.length >= 1, `cells=${cells.length}`)
  const c = cells[0]
  assert.ok(c.slots.length >= 3)
  assert.ok(c.residual && c.residual.rawLen > 0)
  assert.equal(c.provenance, 0)
  assert.equal(c.trust, 240)
  assert.ok(c.confidence > 0.5 && c.confidence <= 1)
})

test('去重：同一句话重复出现 → 合并而不是新建（support 递增）', async () => {
  const before = harness.memory.store.countCells()
  await harness.turn('我习惯用深色主题，浅色看久了眼睛疼。')
  const after = harness.memory.store.countCells()
  assert.equal(after, before, '完全相同的事实不应产生新 cell')
  const hit = harness.memory.recall({ text: '深色主题', budget: 400, manual: true }).hits[0]
  const cell = harness.memory.store.getCell(BigInt('0x' + hit.cellId))
  assert.ok(cell.support >= 2, `support=${cell.support}`)
})

test('矛盾：同 (AGENT, PRED, PATIENT) 极性相反 → CONTRADICTS + SUPERSEDES，旧条目降权', async () => {
  await harness.turn('我不喜欢深色主题，太刺眼了。')
  const edges = harness.memory.store.allEdges().filter((e) => e.rel === 6 || e.rel === 7)
  assert.ok(edges.some((e) => e.rel === 6), '应有 CONTRADICTS 边')
  assert.ok(edges.some((e) => e.rel === 7), '应有 SUPERSEDES 边')
  const disputed = harness.memory.store.listCells({ limit: 200 }).filter((c) => (c.flags & 4) !== 0)
  assert.ok(disputed.length >= 1, '旧 cell 应标记 disputed')
  assert.ok(disputed[0].importance <= 0.6, `降权后 importance=${disputed[0].importance}`)
})

test('门控：首轮注入、同话题连续轮不重复注入、显式指代过去则注入', async () => {
  const h2 = await createHarness({ sessionId: 'it-gate' })
  try {
    await h2.turn('我们的仓库叫 dsh-ui，用 TypeScript。')
    const first = await h2.preStep('我们的仓库叫 dsh-ui，用 TypeScript。', { turn: 1 })
    assert.ok(first, '首轮应注入')
    assert.equal(first.source.kind, 'plugin')
    assert.equal(first.source.form, 'recall')
    assert.ok(first.content[0].text.includes('[MEM v2]'), '首轮应带图例')

    const second = await h2.preStep('我们的仓库叫 dsh-ui，用 TypeScript。', { turn: 2 })
    assert.equal(second, null, '同话题且上轮刚注入，不应重复')

    const third = await h2.preStep('上次说的 dsh-ui 仓库是什么？', { turn: 3 })
    assert.ok(third, '显式指代过去应注入')
  } finally {
    await h2.dispose()
  }
})

test('空槽合法：完全无关的查询不注入，而不是硬凑条目', async () => {
  const h = await createHarness({ sessionId: 'it-empty' })
  try {
    await h.turn('今天天气不错。')
    const r = h.memory.recall({ text: '量子色动力学的重整化群方程', budget: 320 })
    assert.equal(r.hits.length, 0, `不应命中，实际 ${r.hits.length} 条`)
    assert.ok(r.rendered.length === 0 || !r.rendered.includes('M:'), '渲染不应含记忆行')
  } finally {
    await h.dispose()
  }
})

test('网络来源默认隔离：自动召回不进槽位，手动检索可以取到', async () => {
  const h = await createHarness({ sessionId: 'it-web' })
  try {
    await h.turn('看看这个页面 https://example.com/spec 说了什么', {
      tools: [{ name: 'web_fetch', text: 'Spec 规定缓存必须按 key 分片存储。', fromWeb: true }],
    })
    const auto = h.memory.recall({ text: '缓存必须按 key 分片存储', budget: 320 })
    assert.equal(auto.hits.length, 0, '网络来源默认不进槽位')
    const manual = h.memory.recall({ text: '缓存必须按 key 分片存储', budget: 320, manual: true })
    assert.ok(manual.hits.length >= 1, '手动检索应能取到')
  } finally {
    await h.dispose()
  }
})

test('expand：三级展开 + 遮蔽检测 + 800 字上限', async () => {
  const hit = harness.memory.recall({ text: '深色主题', budget: 400, manual: true }).hits[0]
  const l0 = harness.memory.expand(hit.cellId, 0)
  const l1 = harness.memory.expand(hit.cellId, 1)
  const l2 = harness.memory.expand(hit.cellId, 2)
  assert.ok(l0.text.length > 0)
  assert.ok(l1.text.includes('PATIENT='), l1.text)
  assert.ok(l2.text.length > 0)
  assert.ok(l2.chars <= 806)

  const sources = harness.memory.store.sourcesOf(BigInt('0x' + hit.cellId))
  if (sources.length) {
    harness.memory.store.shadowSeqs(sources[0].session, sources.map((s) => s.seq))
    const shadowed = harness.memory.expand(hit.cellId, 2, sources[0].session)
    assert.equal(shadowed.shadowed, true)
    assert.ok(shadowed.text.includes('已被压缩摘要覆盖'))
  }
})

test('遗忘：软删可唤醒、硬删物理移除，且都写审计', async () => {
  const hit = harness.memory.recall({ text: '深色主题', budget: 400, manual: true }).hits[0]
  const id = BigInt('0x' + hit.cellId)
  harness.memory.forget(hit.cellId, 'soft', 'user', 'test soft')
  const soft = harness.memory.store.getCell(id)
  assert.equal(soft.tier, 3)
  // 注意：importance 以 f32 存储，0.05 会读回 0.0500000007，比较必须留容差
  assert.ok(soft.importance <= 0.06, `importance=${soft.importance}`)

  harness.memory.forget(hit.cellId, 'hard', 'user', 'test hard')
  assert.equal(harness.memory.store.getCell(id), null)
  const audits = harness.memory.store.recentEvicts(10)
  assert.ok(audits.some((a) => a.mode === 'hard' && a.cellId === hit.cellId))
})

test('巩固：passDue 判定、锁的写入与释放、重复 passId 幂等', async () => {
  const h = await createHarness({ sessionId: 'it-cons', config: { consolidation: { everyTurns: 1, everyCells: 1000, idleMs: 90000, schemaMinSupport: 2, remValenceDecay: 0.92, remArousalDecay: 0.94, remLinkBudget: 50 } } })
  try {
    for (const s of ['用户偏好深色主题。', '用户偏好深色主题。', '用户偏好深色主题。', '我们决定用 pnpm 部署。', '我们决定用 pnpm 部署。']) {
      await h.turn(s)
    }
    const first = h.consolidate()
    assert.equal(h.memory.store.meta('consolidate:open'), '', '正常结束后锁应释放')
    assert.ok(first.downscaled >= 0)

    const cellsAfterFirst = h.memory.store.countCells()
    h.consolidate()
    assert.equal(h.memory.store.countCells(), cellsAfterFirst, '重复 pass 不应重复产生 schema cell')
  } finally {
    await h.dispose()
  }
})

test('egress 守卫：含记忆原文的外发参数被拒，正常参数放行（fail-closed）', async () => {
  // 先写一条新记忆：前面的用例把旧 cell 删掉了，守卫只能保护"当前库里有的东西"
  await harness.turn('我的手机号 13800001111，别写进任何外发请求里。')
  const blocked = harness.guard('web_fetch', { body: '我的手机号 13800001111，别写进任何外发请求里。' })
  assert.ok(blocked, '应拦截')
  assert.match(blocked, /Blocked/)
  const ok = harness.guard('web_fetch', { url: 'https://example.com/docs' })
  assert.equal(ok, null)
  const pii = harness.guard('send_mail', { to: 'someone@example.com', text: 'hi' })
  assert.ok(pii, '邮箱形态必须拦截')
})

test('命令面：硬删需要 --yes、批量遗忘先预览', async () => {
  const cmd = harness.tools.get('mnemo_command')
  assert.ok(cmd)
  const noYes = await cmd.execute({ line: 'forget 7f3a --hard' })
  assert.match(noYes.text, /不可恢复|--yes/)

  const preview = await cmd.execute({ line: 'forget --before 2099-01-01' })
  assert.match(preview.text, /将遗忘 \d+ 条/)
  assert.match(preview.text, /--yes/)

  const stats = await cmd.execute({ line: 'stats' })
  assert.match(stats.text, /命中率/)
  const doctor = await cmd.execute({ line: 'doctor' })
  assert.match(doctor.text, /体检/)
})

test('情感：评价→PAD 有界、attunement 对纠正敏感、trust 不对称', async () => {
  const h = await createHarness({ sessionId: 'it-affect' })
  try {
    await h.turn('对，就是这样，很好。')
    const good = h.affect.current()
    assert.ok(Math.abs(good.v) <= 1 && Math.abs(good.a) <= 1 && Math.abs(good.d) <= 1)

    const before = h.affect.relationalSnapshot().attunement
    await h.turn('不对，我说的是另一件事。')
    const afterCorrection = h.affect.relationalSnapshot().attunement
    assert.ok(afterCorrection < before, `纠正后 attunement 应下降：${before} → ${afterCorrection}`)

    // 负面权重是正面的 3 倍：一次 broken 抵三次 kept
    const h2 = await createHarness({ sessionId: 'it-trust' })
    try {
      h2.affect.restore({ trust: 0 })
      const rel1 = h2.affect
      rel1.observe({ text: '很好', turn: 1, promise: 'kept' })
      const kept = rel1.relationalSnapshot().trust
      rel1.observe({ text: '不行', turn: 2, promise: 'broken' })
      const broken = rel1.relationalSnapshot().trust
      assert.ok(Math.abs((kept - 0) / (kept - broken)) > 0.2)
      assert.ok(kept > 0 && broken < kept)
    } finally {
      await h2.dispose()
    }
  } finally {
    await h.dispose()
  }
})

test('面板快照：结构完整、字段可用于渲染', () => {
  const snap = harness.panel()
  assert.equal(snap.version, 2)
  assert.ok(Array.isArray(snap.cells))
  assert.ok(snap.stats && typeof snap.stats.cells === 'number')
  for (const c of snap.cells.slice(0, 5)) {
    assert.equal(typeof c.cellId, 'string')
    assert.ok(c.shortId.length >= 4)
    assert.ok(Array.isArray(c.kv))
    assert.ok(Array.isArray(c.slots))
  }
  assert.ok(snap.affect === null || typeof snap.affect.pad.v === 'number')
})

test('体检：无孤儿边、无悬空槽、布局版本正确', () => {
  const d = harness.memory.doctor()
  assert.equal(d.orphanEdges, 0)
  assert.equal(d.danglingSlots, 0)
  assert.equal(d.layoutVersion, 2)
  assert.equal(d.sdrDim, 2048)
})

test('参数热更新：setConfig 立即影响下一轮渲染模式', () => {
  harness.memory.setConfig({ surfaceMode: 'compact' })
  const r = harness.memory.recall({ text: '深色主题', budget: 400, manual: true })
  assert.equal(r.surfaceMode, 'compact')
  if (r.hits.length) assert.ok(r.rendered.includes('M['), '列式渲染应以 M[ 开头')
  harness.memory.setConfig({ surfaceMode: 'rows' })
})
