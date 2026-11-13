/**
 * v0.7.3 · 安全收口 + 实用能力补完的回归
 *
 * 对应《v0.7.1 源代码评判报告》§5/§7/§8/§12/§13/§14 的残留扣分项，
 * 以及 docs/V0.7.2-REVIEW-RESPONSE.md 第 6 节里"本版能代码化"的部分。
 *
 * 纪律：每条断言都必须在**改回旧代码时变红**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  clampScore01,
  FLAG,
  RUNTIME_TUNE_DENY,
  TOPIC_NOUNS,
  canonicalToken,
  detectSemanticPII,
  exportBundle,
  validateBundle,
  bundleChecksum,
  verifyPurge,
  isSensitive,
  normToken,
  redact,
  toHex,
} from './helpers.mjs'
import { snapshotIdOf } from '../packages/core/lib/store.js'
import { appraise } from '../packages/affect/lib/appraisal.js'
import { openEpisode } from '../packages/affect/lib/episode.js'
import { configureExtraction, resetExtraction } from '../packages/encoder/lib/index.js'
import { parseFrames } from '../packages/encoder/lib/frames.js'
import { runCommand } from '../packages/tools/lib/commands.js'
import { createHarness } from '../packages/devkit/lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const opened = []
const tmpDirs = []
const open = async (opts = {}) => {
  const h = await createHarness({ config: { preset: 'balanced' }, ...opts })
  opened.push(h)
  return h
}
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mnemo-v073-'))
  tmpDirs.push(d)
  return d
}
test.after(async () => {
  for (const h of opened) await h.dispose()
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

const cellsOf = (h) => h.memory.store.listCells({ limit: 1000 })
const userCells = (h) => cellsOf(h).filter((c) => c.provenance === 0)

// ── §15 安全红线 ──────────────────────────────────────────────────

test('S1 /mnemo tune 不得改写安全/布局红线，服务端也挡 API 绕过', async () => {
  const h = await open()
  const before = h.memory.config.security.allowGlobalScope
  const out = await runCommand(['tune', 'security.allowGlobalScope=true'], { memory: h.memory })
  assert.match(out, /拒绝/)
  assert.equal(h.memory.config.security.allowGlobalScope, before, '旧实现会真的把红线关掉')

  const api = h.memory.applyAction({ kind: 'tune', patch: { 'security.purgeRequiresConfirm': false } })
  assert.equal(api.ok, false, '面板 action 不经过命令面，服务端必须再挡一次')
  assert.equal(h.memory.config.security.purgeRequiresConfirm, true)
  assert.equal(RUNTIME_TUNE_DENY.test('embStoreDim'), true)
  assert.equal(RUNTIME_TUNE_DENY.test('recall.ignition'), false)
})

test('S1 非有限数值被拒绝，正常调参仍可用', async () => {
  const h = await open()
  assert.match(await runCommand(['tune', 'recall.ignition=Infinity'], { memory: h.memory }), /拒绝/)
  assert.match(await runCommand(['tune', 'recall.ignition=NaN'], { memory: h.memory }), /拒绝/)
  assert.match(await runCommand(['tune', 'recall.ignition=0.5', '--dry'], { memory: h.memory }), /预估|未应用/)
})

test('S2 vault-tools restore 拒绝路径穿越并要求 --db', () => {
  const d = tmp()
  writeFileSync(join(d, 'manifest.json'), JSON.stringify({ files: [{ name: 'blob/../../EVIL', sha256: 'x' }] }))
  const cli = join(root, 'scripts', 'vault-tools.mjs')
  const bad = spawnSync(process.execPath, [cli, 'restore', '--from', d, '--db', join(d, 'vault.db'), '--yes'], { cwd: root, encoding: 'utf8' })
  assert.notEqual(bad.status, 0)
  assert.match(`${bad.stdout}${bad.stderr}`, /非法路径|越界/)
  const noDb = spawnSync(process.execPath, [cli, 'restore', '--from', d, '--yes'], { cwd: root, encoding: 'utf8' })
  assert.notEqual(noDb.status, 0)
  assert.match(`${noDb.stdout}${noDb.stderr}`, /缺少 --db/)
})

test('S3 归一化与弃权判定不许被 NaN 绕过', () => {
  assert.equal(clampScore01(NaN), 0, '旧 clamp01 返回 NaN，会让 score<ignition 恒假')
  assert.equal(clampScore01(Infinity), 0)
  assert.equal(clampScore01(0.5), 0.5)
})

// ── §5 / §7 短 id 与读路径 ────────────────────────────────────────

test('S4 expand：来源映射为空时不再恒返回"摘要覆盖"占位文本', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石，构建工具用 pnpm。')
  const c = userCells(h).find((x) => x.residual)
  assert.ok(c, '前提：有带残差的 cell')
  const id = toHex(c.cellId, 16)
  const before = h.memory.expand(id, 2, 's1').text
  h.memory.store.purgeAux({ kind: 'cell', id })
  const after = h.memory.expand(id, 2, 's2').text
  assert.equal(after, before, '旧实现 [].every() 恒 true，拿不到原文')
})

test('S5 explain 短 id 必须解析成真实完整 id，不能 padEnd 出假 id', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  const c = userCells(h)[0]
  const full = toHex(c.cellId, 16)
  const out = h.memory.explain(full.slice(-4))
  assert.ok(out.includes(full), `旧实现 padEnd 成 ${full.slice(-4)}000000000000，实际返回：${out}`)
  assert.match(h.memory.explain('zzzz'), /不存在|不在候选池内/)
})

test('S6 forget 短 id 返回真实回执，且 evict_log 记完整 id', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  const c = userCells(h)[0]
  const full = toHex(c.cellId, 16)
  const r = h.memory.forget(full.slice(-4), 'soft')
  assert.equal(r.ok, true)
  assert.ok(r.message.includes(full))
  assert.equal(h.memory.forget('zzzz', 'soft').ok, false, '旧实现静默 no-op 且回"已删除"')
  assert.ok(h.memory.store.recentEvicts(10).some((e) => e.cellId === full))
})

test('S7 purge cell 用不存在的短 id 时不得误删其它 cell 的派生层', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石，构建工具用 pnpm。')
  h.memory.recall({ text: '项目代号', budget: 400, manual: true })
  const snaps = h.memory.store.listSnapshots(1000).length
  const r = h.memory.purge({ kind: 'cell', id: 'zzzz' }, { confirm: 'purge', cascade: true })
  assert.equal(r.ok, false)
  assert.equal(h.memory.store.listSnapshots(1000).length, snaps, '旧实现按 short 模糊匹配删掉别人的快照')
})

test('S9 applyAction 的 pin / resolve 短 id 指向真实 cell', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石，构建工具用 pnpm。')
  const [a, b] = userCells(h)
  assert.ok(a && b)
  const pin = h.memory.applyAction({ kind: 'pin', cellId: toHex(a.cellId, 16).slice(-4), pinned: true })
  assert.equal(pin.ok, true, '旧实现 padStart 出不存在的 id → 静默返回 cell 不存在')
  assert.ok((h.memory.store.getCell(a.cellId).flags & FLAG.noDecay) !== 0)

  const r = h.memory.applyAction({ kind: 'resolve', a: toHex(a.cellId, 16).slice(-4), b: toHex(b.cellId, 16).slice(-4) })
  assert.equal(r.ok, true)
  assert.ok(
    h.memory.store.allEdges().some((e) => e.src === a.cellId && e.dst === b.cellId),
    '旧实现 SUPERSEDES 边指向 0xabcd 这种不存在的 id',
  )
})

test('S9 面板 valence/importance 收到 NaN 时保持原值', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  const c = userCells(h)[0]
  const full = toHex(c.cellId, 16)
  const before = c.valence
  h.memory.applyAction({ kind: 'valence', cellId: full, valence: NaN })
  assert.equal(h.memory.store.getCell(c.cellId).valence, before)
  h.memory.applyAction({ kind: 'importance', cellId: full, importance: Infinity })
  assert.ok(Number.isFinite(h.memory.store.getCell(c.cellId).importance))
})

// ── §4 存储与一致性 ───────────────────────────────────────────────

test('S8 clearLattice 对 NaN preserveKinds 不拼出 NOT IN (NaN)', async () => {
  const dbPath = join(tmp(), 'lattice.db')
  const h = await createHarness({ config: { dbPath } })
  opened.push(h)
  await h.turn('项目代号是玄武石。')
  assert.doesNotThrow(() => h.memory.store.clearLattice([3, NaN]))
  assert.ok(Number.isFinite(h.memory.store.countCells()))
})

test('S11 listSnapshots / recentEvicts 的 NaN limit 不抛且两驱动一致', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  assert.ok(Array.isArray(h.memory.store.listSnapshots(NaN)))
  assert.ok(Array.isArray(h.memory.store.recentEvicts(NaN)))
  const dbPath = join(tmp(), 'limit.db')
  const hs = await createHarness({ config: { dbPath } })
  opened.push(hs)
  await hs.turn('项目代号是玄武石。')
  assert.ok(Array.isArray(hs.memory.store.listSnapshots(NaN)))
  assert.ok(Array.isArray(hs.memory.store.recentEvicts(NaN)))
})

test('S12 空 owner 不得续期/占用他人的锁', async () => {
  const h = await open()
  const st = h.memory.store
  assert.equal(st.tryAcquireLock('k', '', 60_000), true)
  assert.equal(st.tryAcquireLock('k', 'real-owner', 60_000), true, '旧实现空 owner 会让别人的锁被判定为"同一持有者"')
})

test('S13 快照 id 不再截成 64 位弱尾段', () => {
  const a = snapshotIdOf('渲染文本 A')
  const b = snapshotIdOf('渲染文本 B')
  assert.ok(a.length >= 32, `旧实现只有 16 位 hex，实际 ${a.length}`)
  assert.notEqual(a, b)
  assert.equal(a, snapshotIdOf('渲染文本 A'))
})

// ── §8 情感感知（第二套词表与确定性） ──────────────────────────────

test('S14 affect/appraisal 英文整词边界：unhappy 判负、goodbye 不判正', () => {
  assert.ok(appraise({ text: 'I am unhappy' }).goalCon < 0, '旧实现命中 happy → +0.333')
  assert.equal(appraise({ text: 'goodbye' }).goalCon, 0, '旧实现命中 good')
  assert.ok(appraise({ text: 'I am happy' }).goalCon > 0)
})

test('S14 中文"特别"里的"别"不再被当否定', () => {
  const f = parseFrames('我特别开心')
  assert.ok(f.length === 0 || f.every((x) => x.polarity !== 'neg'), '旧实现把 特别 里的 别 当否定词')
})

test('S14 情绪事件 id 可复现（不再 Math.random）', () => {
  const mk = () => openEpisode({ trigger: '被否定', at: 1000, turn: 3, valence: -0.5, arousal: 0.6 })
  assert.equal(mk().id, mk().id)
  assert.ok(Number.isFinite(mk().valence))
})

// ── 实用能力 ──────────────────────────────────────────────────────

test('U1 抽取词典配置化：同义词 / 话题词 / 同义词族 / 谓词都生效且可复位', () => {
  assert.equal(normToken('工单'), '工单')
  assert.equal(canonicalToken('金丝雀'), '金丝雀')
  configureExtraction({
    synonyms: { 工单: 'ticket' },
    topicNouns: ['灰度'],
    synonymFamilies: [['灰度', '金丝雀', 'canary']],
    predRules: [{ re: /灰度发布|放量/, pred: 'deploys' }],
  })
  assert.equal(normToken('工单'), 'ticket')
  assert.equal(canonicalToken('金丝雀'), '灰度')
  assert.ok(TOPIC_NOUNS.includes('灰度'))
  assert.equal(parseFrames('灰度发布 用 canary 配置。')[0]?.pred, 'deploys', '自定义谓词必须前置，否则被内置 uses 吃掉')
  assert.equal(parseFrames('用 vitest 跑测试')[0]?.pred, 'uses', '内置规则相对顺序不能被打乱')
  resetExtraction()
  assert.equal(normToken('工单'), '工单')
  assert.equal(canonicalToken('金丝雀'), '金丝雀')
  assert.equal(TOPIC_NOUNS.includes('灰度'), false)
  assert.equal(parseFrames('灰度发布 用 canary 配置。')[0]?.pred, 'uses')
})

test('U2 语义级 PII：住址/诊断/财务/敏感事件可识别，且不改写原文', () => {
  const cases = [
    ['我住在徐汇区钦州路 100 号', 'address'],
    ['确诊了甲状腺炎', 'health'],
    ['月收入 35000 元', 'financial'],
    ['公司裁员了', 'sensitive_event'],
  ]
  for (const [text, kind] of cases) {
    assert.ok(detectSemanticPII(text).includes(kind), `${text} 应识别为 ${kind}`)
    assert.equal(isSensitive(text), true)
    assert.equal(redact(text).text, text, '语义类只标记，不把整句记忆抹成占位符')
  }
  assert.deepEqual(detectSemanticPII('今天天气不错'), [])
  assert.equal(isSensitive('今天天气不错'), false)
  assert.ok(redact('我的手机号 13800138000').pii, '格式类脱敏仍生效')
})

test('U3 /mnemo doctor --json 输出机器可读体检报告', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  const out = await runCommand(['doctor', '--json'], { memory: h.memory })
  const d = JSON.parse(out)
  assert.equal(typeof d.ok, 'boolean')
  assert.ok(Array.isArray(d.issues))
})

test('U4 export --user / --no-raw 生效，bundle 全字段校验', async () => {
  const h = await open()
  await h.turn('项目代号是玄武石。')
  h.memory.recall({ text: '项目代号', budget: 400, manual: true })
  const all = JSON.parse(await runCommand(['export', '--json'], { memory: h.memory }))
  assert.equal(validateBundle(all).ok, true)
  assert.ok(all.counts.snapshots > 0, '前提：确实产生了渲染快照')
  const noRaw = JSON.parse(await runCommand(['export', '--json', '--no-raw'], { memory: h.memory }))
  assert.ok(noRaw.residuals.every((r) => r.text === null), '--no-raw 不应带出残差原文')
  const nobody = JSON.parse(await runCommand(['export', '--json', '--user', 'nobody'], { memory: h.memory }))
  assert.equal(nobody.counts.cells, 0, '旧实现 --user 完全没实现，静默导全库')

  // 篡改 1：内容变了但沿用旧 checksum
  const cropped = { ...all, snapshots: [] }
  assert.equal(validateBundle(cropped).ok, false, 'checksum 应检出内容被裁')
  // 篡改 2：连 checksum 一起重算（checksum 不是签名，攻击者做得到）。
  // 这时只有"counts 与实际长度交叉校验"能抓到——旧版只校验 cells，会放行。
  const recomputed = { ...cropped, checksum: bundleChecksum(cropped) }
  const r = validateBundle(recomputed)
  assert.equal(r.ok, false, '旧版不校验 snapshots / counts，会误判为完整档案')
  assert.ok(r.issues.some((i) => i.includes('snapshots')), `应报 snapshots 不一致，实际 ${r.issues.join(' / ')}`)
})

test('U5 verifyPurge --session 只判定该会话可归属的残留', async () => {
  const h = await open({ config: { security: { scopeMode: 'per-session' } } })
  await h.turn('项目代号是玄武石。', { session: 's1' })
  h.memory.recall({ text: '项目代号', budget: 400, manual: true, sessionId: 's1' })
  h.memory.purge({ kind: 'session', id: 's1' }, { confirm: 'purge', cascade: true })
  const scoped = verifyPurge(h.memory.store, { session: 's1' })
  assert.equal(scoped.scope, 'session')
  assert.equal(scoped.ok, true, '旧实现全库口径恒 ok:false，工具等于没用')
  assert.equal(verifyPurge(h.memory.store).scope, 'vault')
})
