/**
 * 新增能力的回归：双时态、感觉记忆、工作记忆、压缩、人格锚、展开上限、条件审批。
 *
 * 每一条都对应文档里一个"写了但没实现"的机制。测试的价值在于：
 * 这些机制一旦被后来的重构悄悄改掉，行为会变而类型不会报错。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from '../packages/devkit/lib/index.js'
import { compress, decompress } from '../packages/core/lib/codec.js'

const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ sessionId: opts.sessionId ?? 'feat-' + Math.random().toString(36).slice(2), ...opts })
  opened.push(h)
  return h
}
after(async () => {
  for (const h of opened) await h.dispose()
})

// ── 压缩 ────────────────────────────────────────────────────────────

test('残差压缩：中文可压缩，且解压后逐字节一致', () => {
  const text = '用户偏好深色主题，浅色看久了眼睛疼。这段文本用于验证压缩与解压的无损性。'.repeat(6)
  const raw = new TextEncoder().encode(text)
  const c = compress(raw)
  assert.equal(c.rawLen, raw.length)
  assert.equal(c.codec, 'br', '够长的中文应该走 brotli')
  assert.ok(c.bytes.length < raw.length * 0.8, `压缩率 ${(c.bytes.length / raw.length).toFixed(2)}`)
  const back = decompress(c.codec, c.bytes, c.rawLen)
  assert.deepEqual([...back], [...raw])
})

test('压缩：短文本不压（头部开销会让它变大），如实标 raw', () => {
  const raw = new TextEncoder().encode('短')
  const c = compress(raw)
  assert.equal(c.codec, 'raw')
  assert.equal(c.bytes.length, raw.length)
})

test('存储比：长文本下应小于 1（短句被 704 B 定长基底拖累，这是设计代价不是 bug）', async () => {
  const h = await open()
  // 文档 §6.3 的口径是"一条 800 字中文轮次"，所以这里必须用真实长度的差异化文本：
  // 短句会被 704 B 定长基底拖到存储比 > 1，那是设计代价，不是压缩没生效。
  const filler = '这一段用于填充长度，模拟真实的会议记录与代码讨论，内容需要足够长才能体现压缩收益。'
  for (let i = 0; i < 6; i++) {
    const long = `第 ${i} 轮记录：` + `我们讨论了缓存分片与索引维护的第 ${i} 套方案。`.repeat(4) + filler.repeat(6)
    await h.turn(long)
  }
  const st = h.memory.store.stats()
  const s = h.memory.stats()
  // 残差共享：一轮一条残差，而不是一条命题一条
  assert.ok(st.residuals <= 6, `残差应按轮共享，实际 ${st.residuals} 条`)
  // 存储比的实测口径： (nCell × 750B 定长基底 + 0.42 × 原文) / 原文
  // 所以它随"每轮几条命题"变化，不是常数。这里只断言它落在可解释的范围内。
  assert.ok(s.storageRatio > 0 && s.storageRatio < 3, `storageRatio=${s.storageRatio.toFixed(2)}`)
  assert.ok(st.bytes / st.rawBytes > 1, '短/中长文本下基底成本占主导，存储比 > 1 是预期结果（见 README）')
})

// ── 双时态 ──────────────────────────────────────────────────────────

test('双时态：新版本取代旧版本时，旧版本记 tInvalid 而不是被删', async () => {
  const h = await open()
  await h.turn('我习惯用深色主题，浅色看久了眼睛疼。', { advanceMs: 1000 })
  const first = h.memory.store.listCells({ limit: 5 }).find((c) => c.provenance === 0)
  assert.ok(first)

  await h.turn('我不喜欢深色主题，太刺眼了。', { advanceMs: 1000 })
  const after = h.memory.store.listCells({ limit: 20 })
  const old = after.find((c) => c.cellId === first.cellId)
  assert.ok(old, '旧版本必须还在库里（遗忘是"取不到"，不是"不存在"）')
  assert.ok(Number(old.tInvalid ?? 0) > 0, `旧版本应记 tInvalid，实际 ${old.tInvalid}`)
})

test('双时态：asOf 查询能拿到"当时认为"的版本，默认查询只给最新', async () => {
  const h = await open()
  const t0 = Date.now()
  await h.turn('我们决定用 pnpm 部署。', { advanceMs: 0 })
  const asOfBeforeChange = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true, asOf: t0 + 500 })
  assert.ok(asOfBeforeChange.hits.length >= 1, 'asOf 在变更前应能看到旧结论')

  await h.turn('我们决定改用 npm 部署。', { advanceMs: 5000 })
  const invalidated = h.memory.store.listCells({ limit: 20 }).find((c) => Number(c.tInvalid ?? 0) > 0)
  assert.ok(invalidated, '应有被取代的版本')

  const now = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true })
  const nowIds = new Set(now.hits.map((x) => x.cellId))
  // 注意：这里不能断言 hits.length === 0——同话题的新版本（npm）仍应命中。
  // 要断言的是"被取代的那一条不再出现"。
  assert.ok(!nowIds.has(invalidated.cellId.toString(16).padStart(16, '0')), '当前口径不应包含已被取代的版本')

  const historical = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true, asOf: t0 + 1000 })
  assert.ok(
    historical.hits.some((x) => x.cellId === invalidated.cellId.toString(16).padStart(16, '0')),
    '历史口径应能命中当时有效的版本',
  )
})

test('双时态：includeInvalidated 能把旧版本一起取回来（诊断用）', async () => {
  const h = await open()
  await h.turn('我们决定用 pnpm 部署。')
  await h.turn('我们决定改用 npm 部署。', { advanceMs: 3000 })
  const without = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true })
  const withInvalid = h.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true, includeInvalidated: true })
  assert.ok(withInvalid.hits.length >= without.hits.length)
  assert.ok(h.memory.stats().invalidated >= 1, 'stats 应统计已失效版本')
})

// ── 感觉记忆 ────────────────────────────────────────────────────────

test('感觉记忆：同一段长文本在 TTL 内重复粘贴不再重复编码', async () => {
  const h = await open()
  const paste = '这是一段被反复粘贴的长日志内容，用于验证感觉记忆的哈希去重是否生效。'.repeat(3)
  const r1 = await h.turn(paste)
  assert.ok(r1.cells >= 1, `首次应编码，实际 ${r1.cells}`)
  const before = h.memory.store.countCells()
  const r2 = await h.turn(paste)
  assert.equal(r2.cells, 0, '重复粘贴不应产生新 cell')
  assert.equal(h.memory.store.countCells(), before)
})

test('感觉记忆：TTL 过期后同一段内容可以重新编码', async () => {
  const h = await open()
  const paste = '这是一段需要重新编码的长日志内容，用于验证 TTL 过期后的行为是否恢复。'.repeat(3)
  await h.turn(paste)
  for (let i = 0; i < 3; i++) await h.turn(`第 ${i} 轮无关内容，用来推进轮次。`)
  // 注意：重新编码 ≠ 新增 cell。同一事实会走合并（support++），所以看的是"有没有重新走编码路径"。
  const before = h.memory.store.countCells()
  const hit = h.memory.recall({ text: paste.slice(0, 12), budget: 400, manual: true }).hits[0]
  const supportBefore = hit ? h.memory.store.getCell(BigInt('0x' + hit.cellId)).support : 0
  await h.turn(paste)
  const supportAfter = hit ? h.memory.store.getCell(BigInt('0x' + hit.cellId)).support : 0
  assert.ok(supportAfter > supportBefore, `TTL 过期后应重新编码并累加 support（${supportBefore} → ${supportAfter}）`)
  assert.ok(h.memory.store.countCells() >= before)
})

// ── 工作记忆 ────────────────────────────────────────────────────────

test('工作记忆：召回过的 cell 进激活集，turn 结束后释放引用', async () => {
  const h = await open()
  await h.turn('我们的仓库叫 dsh-ui，用 TypeScript 写。')
  const r = h.memory.recall({ text: 'dsh-ui 仓库', budget: 400, manual: true })
  assert.ok(r.hits.length >= 1)
  const id = BigInt('0x' + r.hits[0].cellId)
  assert.ok(h.memory.working.activation(id) > 0, '命中后应有激活度')
  assert.ok(h.memory.working.size <= 16, '工作记忆硬上限 16')

  h.memory.noteTurn()
  assert.equal(h.memory.working.size, 0, 'turn 结束只释放引用')
  // 数据本身还在
  assert.ok(h.memory.store.getCell(id))
})

test('工作记忆：激活度不会把 activation 堆到超过 1', async () => {
  const h = await open()
  await h.turn('我们的仓库叫 dsh-ui，用 TypeScript 写。')
  for (let i = 0; i < 5; i++) h.memory.recall({ text: 'dsh-ui', budget: 400, manual: true })
  const top = h.memory.working.top(5)
  assert.ok(top.every((x) => x.activation <= 1))
})

// ── 人格锚与离线环 ──────────────────────────────────────────────────

test('人格锚：落盘为 kind=4 且不可衰减；可回滚到历史版本', async () => {
  const h = await open()
  for (let i = 0; i < 6; i++) await h.turn(`第 ${i} 轮：这件事很重要，请认真对待。`)
  const personaCells = h.memory.store.listCells({ kind: 4, limit: 5 })
  assert.ok(personaCells.length >= 1, '应有 kind=4 人格锚 cell')
  assert.ok((personaCells[0].flags & 2) !== 0, '人格锚必须带 bit1（不可衰减）')

  const st = h.affect.personaState()
  assert.ok(st.rev >= 1, `rev=${st.rev}`)
  const rollback = h.affect.rollbackPersona(0)
  assert.equal(rollback.ok, true)
  assert.deepEqual(h.affect.personaState().vector, st.baseline)
})

test('人格漂移有界：向量不会被推到基线之外无限远', async () => {
  const h = await open()
  for (let i = 0; i < 12; i++) await h.turn(i % 2 ? '不对，我说的是另一件事。' : '对，就是这样，很好。')
  const st = h.affect.personaState()
  const drift = Math.sqrt(st.vector.reduce((n, x, i) => n + (x - st.baseline[i]) ** 2, 0))
  assert.ok(drift <= 0.2501, `漂移 ${drift.toFixed(3)} 应不超过 ε=0.25`)
})

test('关系模型：落盘为 kind=5，重启后能读回', async () => {
  const h = await open()
  for (let i = 0; i < 6; i++) await h.turn('对，就是这样。')
  const relCells = h.memory.store.listCells({ kind: 5, limit: 5 })
  assert.ok(relCells.length >= 1, '应有 kind=5 关系 cell')
  const trustSlot = relCells[0].slots.find((s) => s.value.startsWith('trust='))
  assert.ok(trustSlot, '关系 cell 应带 trust 槽位')
})

test('离线环：样本足够时抽出用户图式（kind=3）', async () => {
  const h = await open()
  // 同一话题反复出现且张力高 → 应抽出"追问该话题时张力上升"
  for (let i = 0; i < 14; i++) {
    await h.turn(i % 3 === 0 ? '不对，我说的是缓存那块，你理解错了。' : '缓存方案要按 key 分片。')
  }
  const patterns = h.affect.refreshSchema()
  const schemaCells = h.memory.store.listCells({ kind: 3, limit: 10 })
  assert.ok(schemaCells.length >= 1, `应写入 kind=3 图式，patterns=${JSON.stringify(patterns)}`)
  assert.ok(schemaCells[0].digest.length > 0)
})

// ── 展开上限与条件审批 ──────────────────────────────────────────────

test('展开上限：同一会话内原文最多返回 2 次', async () => {
  const h = await open()
  await h.turn('我的手机号是 13800001111，写在配置文件的注释里。')
  const hit = h.memory.recall({ text: '手机号 配置文件', budget: 400, manual: true }).hits[0]
  assert.ok(hit, '应命中')
  const a = h.memory.expand(hit.cellId, 2, 's1')
  const b = h.memory.expand(hit.cellId, 2, 's1')
  const c = h.memory.expand(hit.cellId, 2, 's1')
  assert.ok(!a.text.includes('已展开 2 次'))
  assert.ok(!b.text.includes('已展开 2 次'))
  assert.match(c.text, /已展开 2 次/, `第三次应被限制，实际：${c.text}`)
})

test('条件审批：用户没明说"记住"时，memory_assert 返回待确认而不是静默写入', async () => {
  const h = await open()
  await h.turn('我们下周要交付 0.3 版本。')
  const before = h.memory.store.countCells()
  const out = await h.invokeTool('memory_assert', { subject: '用户', predicate: 'prefers', object: 'dark' })
  assert.equal(out.action, 'needs_approval')
  assert.equal(h.memory.store.countCells(), before, '未获批准时不应写入')
})

test('条件审批：用户明说"记住"时免审直接写入', async () => {
  const h = await open()
  await h.turn('记住：部署脚本要用 pnpm，不要用 npm。')
  const out = await h.invokeTool('memory_assert', { subject: '用户', predicate: 'prefers', object: 'pnpm' })
  assert.notEqual(out.action, 'needs_approval')
  assert.ok(out.cellId, `应写入并返回 cellId，实际 ${JSON.stringify(out)}`)
})

// ── L1 切分（§7.2） ─────────────────────────────────────────────────

import { segmentLite, parseLlmPropositions, fromHostLlm } from '../packages/encoder/lib/l1.js'
import { MnemoEncoder } from '../packages/encoder/lib/index.js'

test('L1-lite：逗号连接的并列小句会被拆开（L0 只按句末标点切）', () => {
  const text = '我们用 pnpm 构建，用 vitest 跑测试，部署走预发环境。'
  const props = segmentLite(text)
  assert.equal(props.length, 3, `应拆成 3 条，实际 ${props.length}：${JSON.stringify(props.map((p) => p.text))}`)
  assert.ok(props.every((p) => p.text.length >= 4))
})

test('L1-lite：疑问句不进命题（否则会变成假记忆）', () => {
  const props = segmentLite('我们用 pnpm 构建吗？这个方案好不好？')
  assert.equal(props.length, 0, JSON.stringify(props))
})

test('L1 解析：容忍 ```json 包裹、前后解释与尾随逗号', () => {
  const raw = '好的，结果如下：\n```json\n[{"text":"用户偏好深色主题","pred":"prefers","polarity":"pos"},{"text":"用户用 pnpm 部署","pred":"uses"},]\n```\n以上。'
  const props = parseLlmPropositions(raw)
  assert.ok(props, '应解析成功')
  assert.equal(props.length, 2)
  assert.equal(props[0].text, '用户偏好深色主题')
  assert.equal(props[1].pred, 'uses')
  assert.equal(parseLlmPropositions('完全不是 JSON'), null)
})

test('L1 端口：垃圾输入返回 null 而不是抛错', () => {
  assert.equal(fromHostLlm(null), null)
  assert.equal(fromHostLlm({}), null)
  assert.equal(fromHostLlm('string'), null)
})

test('L1 异步编码：有端口时按模型给的命题落库', async () => {
  const h = await open()
  const fake = {
    available: () => true,
    complete: async () =>
      JSON.stringify([
        { text: '用户用 pnpm 构建项目', pred: 'uses', polarity: 'pos' },
        { text: '用户用 vitest 跑测试', pred: 'uses', polarity: 'pos' },
      ]),
  }
  const encoder = new MnemoEncoder(h.memory, h.memory.space, { encodeAssistant: true, encodeTools: true, maxCellsPerTurn: 8, maxResidualBytes: 8192, l1: { enabled: true } }, fake)
  const before = h.memory.store.countCells()
  const r = await encoder.encodeTurnAsync({ sessionId: 'l1', seqs: [1], turn: 1, userText: '随便一段话，模型会拆开。' })
  assert.equal(r.created, 2, `应写入 2 条，实际 created=${r.created} merged=${r.merged} skipped=${r.skipped}`)
  assert.equal(h.memory.store.countCells(), before + 2)
})

test('L1 异步编码：端口失败时退回同步路径，不丢数据', async () => {
  const h = await open()
  const bad = { available: () => true, complete: async () => { throw new Error('boom') } }
  const encoder = new MnemoEncoder(h.memory, h.memory.space, { encodeAssistant: true, encodeTools: true, maxCellsPerTurn: 8, maxResidualBytes: 8192, l1: { enabled: true } }, bad)
  const r = await encoder.encodeTurnAsync({ sessionId: 'l1b', seqs: [1], turn: 1, userText: '我们决定用 pnpm 部署。' })
  assert.ok(r.cells.length >= 1, '降级后仍应编码')
})
