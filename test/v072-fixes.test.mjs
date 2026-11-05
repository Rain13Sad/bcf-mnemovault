/**
 * v0.7.2 · 缺陷修复 + 落地能力 + 验证层的回归
 *
 * 对应《v0.7.1 源代码评判报告》逐板块复核后本轮实际动手的部分：
 *   §7/§14  F1  purge cell 误清空全库 / 会话快照回执撒谎（P0 数据丢失）
 *   §10/§15 F2  harness 手写配置丢失危机与未成年保护（安全红线静默关闭）
 *   §3      F3  maxCellsForTurn 缺字段 → NaN → 预算闸门静默失效
 *   §5      F4  dominantChannel 恒返回 mixed
 *   §8      F5/F6/F7/E1/E3  词边界、no 右边界、双重否定、含蓄表达、词典注入
 *   §13     F8  残差解压失败把压缩字节冒充原文
 *   §13     F10 listCells 的 NaN limit
 *   §7      F13 per-session 下写入侧跨会话污染（bench-verify C8 实测抓到）
 *   §4/§13  D7  巩固锁 CAS + TTL + owner
 *   §14     T1/T2/E10  数据可携带、删除彻底性校验、访问审计、metrics
 *
 * 纪律：每条断言都必须在**改回去时变红**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateAffect,
  detectIndirect,
  LEXICON_DEDUP,
  clamp11,
  clamp01,
  compress,
  decompress,
  toHex,
  exportBundle,
  validateBundle,
  verifyPurge,
  metricsText,
  accessAuditLine,
  jsonSafe,
} from './helpers.mjs'
import { dominantChannel } from '../packages/core/lib/recall.js'
import { runCommand } from '../packages/tools/lib/commands.js'
import { createHarness } from '../packages/devkit/lib/index.js'

const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ config: { preset: 'balanced' }, ...opts })
  opened.push(h)
  return h
}
test.after(async () => {
  for (const h of opened) await h.dispose()
})

const cellsOf = (h) => h.memory.store.listCells({ limit: 1000 })

// ── §8 情感感知（评判报告最低分板块 2/5） ───────────────────────────

test('F5 英文整词边界：like 不再命中 dislike，good 不再命中 goodbye', () => {
  assert.ok(estimateAffect('I dislike it').v < -0.2, 'dislike 必须是明确负面（旧实现被 like 抵消成 -0.04）')
  assert.ok(estimateAffect('I like it').v > 0.2)
  assert.equal(estimateAffect('goodbye').v, 0, 'goodbye 不该因为 good 产生情绪')
  assert.equal(estimateAffect('define').v, 0, 'define 不该因为 fine 产生情绪')
})

test('F6 否定词 no 必须有右边界：nothing / none 不再误判', () => {
  assert.ok(estimateAffect('I am nothing happy').v > 0.2, '旧实现把 nothing 里的 no 当否定，判成 -0.373')
  assert.ok(estimateAffect('I am not happy').v < -0.2)
  assert.ok(estimateAffect('no good').v < 0, 'no + 空格仍是真否定')
})

test('F7 中文双重否定按奇偶处理，且不许跨标点误伤', () => {
  assert.ok(estimateAffect('不是不开心').v > 0.2, '旧实现判成 -0.349')
  assert.ok(estimateAffect('我不开心').v < -0.2)
  assert.ok(estimateAffect('没事，已经修好了').v > 0, '"没事"的"没"是词素，不该否定后面的"好"')
})

test('E1 口是心非：不把字面正极当成已确认的情绪', () => {
  for (const t of ['我没事', '还好吧', '你说呢']) {
    const e = estimateAffect(t)
    assert.equal(e.indirect, true, `${t} 应标记为含蓄`)
    assert.equal(e.v, 0, `${t} 不该编造效价`)
    assert.equal(e.labels.length, 0)
    assert.ok(e.confidence <= 0.2)
  }
  const resolved = estimateAffect('没事，已经修好了')
  assert.notEqual(resolved.indirect, true, '有消解语境时是字面义')
  assert.ok(resolved.v > 0)
  assert.ok(detectIndirect('我没事'))
  assert.equal(detectIndirect('明天上午十点开会'), null)
})

test('E3 领域词典注入：可覆盖内置值且不污染模块级词表', () => {
  assert.equal(estimateAffect('麒麟瓜').confidence, 0)
  const added = estimateAffect('麒麟瓜', { extraLexicon: [['麒麟瓜', 0.7, 0.4, 0.3]] })
  assert.ok(added.v > 0.3)
  assert.equal(estimateAffect('麒麟瓜').confidence, 0, '注入不能泄漏到后续调用')
  const overridden = estimateAffect('开心', { extraLexicon: [['开心', -0.7, 0.3, 0]] })
  assert.ok(overridden.v < -0.2, '同名词必须以后注入的为准')
  assert.ok(LEXICON_DEDUP.length >= 150, `词表应扩容到 150+，实际 ${LEXICON_DEDUP.length}`)
  const dup = new Set(LEXICON_DEDUP.map((e) => e[0]))
  assert.equal(dup.size, LEXICON_DEDUP.length, '词表不得出现重复词')
})

test('F14 clamp 对 NaN 归零，不再把 NaN 带进 PAD', () => {
  assert.equal(clamp11(NaN), 0)
  assert.equal(clamp01(NaN), 0)
  assert.equal(clamp11(2), 1)
  assert.equal(clamp01(-1), 0)
})

// ── §3 / §5 / §13 工程缺陷 ─────────────────────────────────────────

test('F4 dominantChannel：通道差距大时不再恒为 mixed', () => {
  const c = {
    channels: new Set(['semantic', 'graph']),
    simSemantic: 0.9,
    simSymbolic: 0,
    simGraph: 0.1,
    simTemporal: 0,
  }
  assert.equal(dominantChannel(c), 'semantic', '旧实现 second 的 reduce 初值是 arr[0]，差值恒 0')
  assert.equal(dominantChannel({ ...c, simGraph: 0.88 }), 'mixed', '真正接近时仍应报 mixed')
})

test('F3 手写配置缺字段时预算闸门不会静默失效', async () => {
  const h = await open()
  const { MnemoEncoder } = await import('../packages/encoder/lib/index.js')
  const enc = new MnemoEncoder(h.memory, h.memory.space, {
    maxCellsPerTurn: NaN,
    cellsPerTurnChars: NaN,
    l1: { enabled: false },
  })
  const budget = enc.maxCellsForTurn('一段普通长度的用户发言')
  assert.ok(Number.isFinite(budget), `预算必须是有限数，实际 ${budget}`)
  assert.ok(budget >= 1)
})

test('F8 残差损坏必须显式失败，正常往返不受影响', () => {
  assert.throws(() => decompress('br', new Uint8Array([0xff, 0xfe, 0xfd]), 4096), /解压失败/)
  const raw = new TextEncoder().encode('hello mnemo vault '.repeat(20))
  const c = compress(raw)
  // node:zlib 返回 Buffer（Uint8Array 子类），strict deepEqual 会因原型不同而假红
  assert.deepEqual(Array.from(decompress(c.codec, c.bytes, c.rawLen)), Array.from(raw))
})

test('F10 listCells 的 NaN limit 不生成 LIMIT NaN', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  const rows = h.memory.store.listCells({ limit: NaN })
  assert.ok(Array.isArray(rows))
  assert.ok(rows.length > 0)
})

// ── §7 / §14 安全与数据完整性 ──────────────────────────────────────

test('F1 purge cell 只删该 cell 的派生层，绝不清空全库', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  await h.turn('构建工具用 pnpm。')
  h.memory.recall({ text: '项目代号', budget: 400, manual: true })
  const beforeLogs = h.memory.store.listLog().length
  const all = cellsOf(h).filter((c) => c.provenance === 0)
  assert.ok(all.length >= 2)
  const target = all[0]
  const other = all[all.length - 1]
  const r = h.memory.purge({ kind: 'cell', id: toHex(target.cellId, 16) }, { confirm: 'purge', cascade: true })
  assert.equal(r.ok, true)
  assert.equal(r.aux.log, 0, '单 cell 无权删整轮会话日志')
  assert.equal(h.memory.store.listLog().length, beforeLogs, '旧实现把全库 session_log 清空了')
  assert.ok(h.memory.store.sourcesOf(other.cellId).length > 0, '其它 cell 的来源映射不该被清空')
  assert.ok(h.memory.store.getCell(other.cellId), '其它 cell 必须仍在')
})

test('F1 会话级 purge 真的删掉渲染快照，回执不再恒报 0', async () => {
  const h = await open({ config: { security: { scopeMode: 'per-session' } } })
  await h.turn('项目代号是玄武石。', { session: 's1' })
  h.memory.recall({ text: '项目代号', budget: 400, manual: true, sessionId: 's1' })
  assert.ok(h.memory.store.listSnapshots().length > 0, '前提：确实产生过渲染快照')
  const r = h.memory.purge({ kind: 'session', id: 's1' }, { confirm: 'purge', cascade: true })
  assert.ok(r.aux.snapshots > 0, '旧实现恒返回 snapshots:0 且一行不删')
  assert.equal(h.memory.store.listSnapshots().length, 0)
})

test('F2 harness 手写配置不解析时，危机与未成年保护仍开启', async () => {
  const h = await open()
  assert.equal(h.affect.config.crisisEnabled, true, '旧实现里是 undefined → 危机识别静默关闭')
  assert.equal(h.affect.config.minorGuardEnabled, true, '旧实现里是 undefined → 未成年人保护静默关闭')
  assert.equal(Object.keys(h.affect.config.coeff ?? {}).length, 15, 'PAD 系数必须补齐')
  const out = h.affect.observe({ text: '我不想活了', turn: 1 })
  assert.equal(out.mood.v, 0, '危机轮必须挂起心境积分（suspendCompanion）')
})

test('F13 per-session 下 B 的写入不得把 A 的 cell 标失效', async () => {
  const h = await open({ config: { security: { scopeMode: 'per-session' } } })
  await h.turn('数据库用 PostgreSQL。', { session: 'tenant-A' })
  await h.turn('数据库用 MySQL。', { session: 'tenant-B' })
  const a = cellsOf(h).filter((c) => (c.session ?? '') === 'tenant-A' && c.provenance === 0)
  assert.equal(a.length, 1)
  assert.equal(Number(a[0].tInvalid ?? 0), 0, '旧实现的冲突检测不看边界，B 会把 A 标成失效')
})

test('D7 原子巩固锁：互斥 / 同主重入 / owner / TTL 过期抢占', async () => {
  const h = await open()
  const st = h.memory.store
  assert.equal(st.tryAcquireLock('k', 'owner-A', 60_000), true)
  assert.equal(st.tryAcquireLock('k', 'owner-B', 60_000), false, '别人的锁必须挡住')
  assert.equal(st.tryAcquireLock('k', 'owner-A', 60_000), true, '同主可重入')
  assert.equal(st.releaseLock('k', 'owner-B'), false, '不能误清别人的锁')
  st.setMeta('lock:expired', JSON.stringify(['ghost', Date.now() - 1000]))
  assert.equal(st.tryAcquireLock('expired', 'owner-C', 60_000), true, '过期锁必须可被抢占')
  assert.equal(st.releaseLock('k', 'owner-A'), true)
  assert.equal(st.lockInfo('k'), null)
})

// ── §13 / §14 落地工具链 ───────────────────────────────────────────

test('T1 数据可携带：bundle 全量、可校验、篡改可检出', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  const b = exportBundle(h.memory)
  assert.equal(b.format, 'mnemo-vault-bundle')
  assert.equal(b.schema, 1)
  assert.ok(b.counts.cells > 0)
  assert.equal(b.cells.length, b.counts.cells, 'counts 必须等于实际条数（无静默截断）')
  assert.equal(validateBundle(b).ok, true)
  assert.equal(validateBundle({ ...b, sessionLog: [] }).ok, false, '内容被裁掉必须检出')
  assert.equal(validateBundle({ ...b, checksum: '0000000000000000' }).ok, false, '校验和错误必须检出')
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(b)), 'bigint / TypedArray 必须可 JSON 化')
})

test('T1 /mnemo export --json 输出可校验 bundle（不再静默截断 5000 条）', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  const out = await runCommand(['export', '--json'], { memory: h.memory })
  const b = JSON.parse(out)
  assert.equal(validateBundle(b).ok, true)
  const plain = await runCommand(['export'], { memory: h.memory })
  assert.match(plain, /^共 \d+ 条/)
})

test('T2 删除彻底性独立校验 + Prometheus 指标', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  h.memory.recall({ text: '项目代号', budget: 400, manual: true })
  const before = verifyPurge(h.memory.store)
  assert.equal(before.ok, false)
  assert.ok(before.snapshots > 0, '渲染过的记忆文本应被计入残留')
  h.memory.purge({ kind: 'all' }, { confirm: 'purge', cascade: true })
  assert.equal(verifyPurge(h.memory.store).ok, true, 'purge 后九类派生层必须全空')
  const m = metricsText(h.memory)
  assert.match(m, /mnemo_cells_total 0/)
  assert.match(m, /mnemo_layout_info/)
})

test('E10 访问审计默认关闭，显式开启才留痕', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石，另外补充一段比较长的原文用于生成残差内容aaaaaaaaaaaaaaaaaaaa。')
  const cell = cellsOf(h).find((c) => c.residual)
  assert.ok(cell, '前提：确实有带残差的 cell')
  const id = toHex(cell.cellId, 16)
  h.memory.expand(id, 2, 'sess-audit')
  assert.equal(h.memory.store.listAccess().length, 0, '默认关闭：expand 仍是纯读')
  h.memory.setAccessAudit(true, 'ops:alice')
  h.memory.expand(id, 2, 'sess-audit')
  const logs = h.memory.store.listAccess()
  assert.ok(logs.length >= 1)
  assert.equal(logs[0].actor, 'ops:alice')
  assert.equal(logs[0].action, 'expand')
  const line = accessAuditLine({ at: 1, actor: 'ops:bob', action: 'export', target: 'all' })
  assert.equal(JSON.parse(line).actor, 'ops:bob')
})

test('T3 jsonSafe 把 bigint 与 TypedArray 转成可移植形状', () => {
  const out = jsonSafe({ id: 12n, vec: new Int8Array([1, -2]), nested: [3n] })
  assert.equal(out.id, '12')
  assert.deepEqual(out.vec, [1, -2])
  assert.equal(out.nested[0], '3')
})
