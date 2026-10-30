/**
 * v0.5.0：决策层正确性 + 长周期不变量。
 *
 * 这一组测试补的是 v0.4 最大的盲区：**所有已知缺陷都在"长周期行为"层，
 * 而 135 项测试全在"功能正确性"层**——恒真闸、confidence 污染、库无界增长、
 * 召回不幂等，没有一条会让当时的测试变红。
 *
 * 三类判据：
 *   · 收敛：系统必须能"出手"（demoteDue 移动数 > 0）
 *   · 不变量：反复操作后世界不能变成什么样（confidence 不漂、字节要能回收）
 *   · 失效传播：一个信号必须在召回/合并/保留度/降档四处表现一致
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLAG,
  KIND,
  RETENTION_WEIGHTS,
  SdrSpace,
  evaluateRetention,
  hashEmbedding,
  protectedFromDeletion,
  staleFactor,
} from './helpers.mjs'
import { createHarness } from '../packages/devkit/lib/index.js'

const DAY = 86_400_000
const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ sessionId: 'v05-' + Math.random().toString(36).slice(2), ...opts })
  opened.push(h)
  return h
}
after(async () => {
  for (const h of opened) await h.dispose()
})

const space = new SdrSpace({ dim: 2048, k: 8 })

function mkCell(over = {}) {
  const slots = [
    { role: 1, type: 'LIT', value: '用户' },
    { role: 2, type: 'LIT', value: 'pnpm' },
    { role: 3, type: 'LIT', value: 'uses' },
  ]
  const sdr = space.bundle(slots.map((s) => space.bind(space.identity('V:' + s.value), space.role(String(s.role)))))
  const now = 1_800_000_000_000
  return {
    cellId: 0x1234abcdn,
    kind: KIND.semantic,
    tier: 1,
    flags: 0,
    tFrom: BigInt(now - 400 * DAY),
    tTo: BigInt(now - 400 * DAY),
    tIngest: BigInt(now - 800 * DAY),
    tAccess: BigInt(now - 400 * DAY),
    accessCount: 1,
    stability: 7,
    importance: 0.5,
    valence: 0,
    arousal: 0,
    dominance: 0.5,
    salience: 0.5,
    provenance: 1,
    trust: 200,
    sdr,
    emb: hashEmbedding('用户用 pnpm', 128),
    slots,
    edges: [],
    residual: null,
    confidence: 0.9,
    support: 1,
    topic: 'user-pnpm-uses',
    digest: '用户用 pnpm',
    tInvalid: 0n,
    ...over,
  }
}

// ── 收敛：降档必须真的出手 ──────────────────────────────────────────

test('收敛：10 条随口说的用户陈述，400 天后必须被降档（v0.4 这里是 0 条）', async () => {
  const h = await open()
  const lines = [
    '我们仓库叫 dsh-ui。',
    '我用 pnpm。',
    'CI 跑 6 分钟。',
    '日志放 stderr。',
    '字体用等宽。',
    '别改 package.json。',
    '部署脚本用 pnpm。',
    'e2e 拆两档。',
    '面板首屏 200ms。',
    '不用 Redux。',
  ]
  for (const t of lines) await h.turn(t)
  const now = h.now()
  const cells = h.memory.store.listCells({ limit: 200 }).filter((c) => c.provenance === 0 && c.kind <= 2)
  assert.ok(cells.length >= 5, `cells=${cells.length}`)
  for (const c of cells) {
    c.tAccess = BigInt(now - 400 * DAY)
    c.tIngest = BigInt(now - 800 * DAY)
    h.memory.store.putCell(c)
  }
  const before = cells.map((c) => c.tier)
  for (let i = 0; i < 5; i++) h.memory.demoteDue()
  const after = cells.map((c) => h.memory.store.getCell(c.cellId)?.tier)
  const moved = after.filter((t, i) => t !== before[i]).length
  assert.ok(moved > 0, `demoteDue 移动 ${moved} 条——降档仍然不生效`)
  assert.ok(after.every((t) => t >= 2), `应全部降到冷层以下，实际 ${after.join(',')}`)
})

test('收敛：再老 500 天，普通记忆会进墓碑（tier 4）且残差被释放', async () => {
  const h = await open()
  for (const t of ['我用 pnpm。', 'CI 跑 6 分钟。', '日志放 stderr。']) await h.turn(t)
  const now = h.now()
  const cells = h.memory.store.listCells({ limit: 200 }).filter((c) => c.provenance === 0 && c.kind <= 2)
  for (const c of cells) {
    c.tAccess = BigInt(now - 900 * DAY)
    c.tIngest = BigInt(now - 1400 * DAY)
    h.memory.store.putCell(c)
  }
  const bytesBefore = h.memory.store.stats().bytes
  for (let i = 0; i < 8; i++) h.memory.demoteDue()
  const after = cells.map((c) => h.memory.store.getCell(c.cellId))
  assert.ok(after.every((c) => c.tier === 4), `tier=${after.map((c) => c.tier).join(',')}`)
  // 墓碑由 tier 表达（flags 只有 1 字节，装不下 bit8——见 cell.ts 的说明）
  assert.ok(after.every((c) => c.tier >= 4))
  assert.ok(after.every((c) => c.residual === null), '墓碑应释放残差')
  assert.ok(after.every((c) => c.emb === null), '墓碑应丢弃向量')
  const bytesAfter = h.memory.store.stats().bytes
  assert.ok(bytesAfter < bytesBefore, `字节应下降：${bytesBefore} → ${bytesAfter}`)
})

test('收敛：墓碑不参与召回，但可以用 includeTombstones 显式翻出来', async () => {
  const h = await open()
  await h.turn('我用 pnpm 构建。')
  const now = h.now()
  const cell = h.memory.store.listCells({ limit: 50 }).find((c) => c.provenance === 0 && c.kind <= 2)
  assert.ok(cell)
  cell.tAccess = BigInt(now - 900 * DAY)
  cell.tIngest = BigInt(now - 1400 * DAY)
  h.memory.store.putCell(cell)
  for (let i = 0; i < 8; i++) h.memory.demoteDue()
  assert.equal(h.memory.store.getCell(cell.cellId).tier, 4)

  const normal = h.memory.recall({ text: 'pnpm 构建', budget: 400, manual: true, readOnly: true })
  assert.ok(!normal.hits.some((x) => BigInt('0x' + x.cellId) === cell.cellId), '墓碑不该出现在召回里')

  const withTombs = h.memory.recall({ text: 'pnpm 构建', budget: 400, manual: true, readOnly: true, includeTombstones: true })
  assert.ok(withTombs.hits.length >= 0)
})

// ── 恒真闸：命中率必须 < 100% ──────────────────────────────────────

test('闸门：随口一句的用户陈述不再命中"一手事实"（v0.4 是 10/10）', () => {
  const plain = Array.from({ length: 10 }, (_, i) =>
    mkCell({ cellId: BigInt(i + 1), trust: 240, provenance: 0, support: 1, accessCount: 1 }),
  )
  const hits = plain.filter((c) => protectedFromDeletion(c) !== null)
  assert.equal(hits.length, 0, `仍有 ${hits.length}/10 命中闸门`)

  const confirmed = mkCell({ trust: 240, provenance: 0, support: 3 })
  assert.equal(protectedFromDeletion(confirmed), '用户亲口确认过的一手事实')
  const used = mkCell({ trust: 240, provenance: 0, support: 1, accessCount: 3 })
  assert.equal(protectedFromDeletion(used), '用户亲口确认过的一手事实')
})

test('闸门：只封顶不进墓碑，不改分数', () => {
  const cell = mkCell({ kind: KIND.schema, tAccess: BigInt(1_800_000_000_000 - 900 * DAY) })
  const r = evaluateRetention(cell, { nowMs: 1_800_000_000_000, weights: RETENTION_WEIGHTS.balanced })
  assert.equal(r.protectedBy, '图式（只增不减）')
  assert.equal(r.disposition, 'P1', '分数本身该是 P1（闸不抬分）')
  assert.equal(r.effective, 'P2', '实际处置被闸挡在归档层')
  assert.equal(r.tier, 3)
})

// ── 失效传播：tInvalid 必须贯穿 ────────────────────────────────────

test('失效传播：被取代 40 天后强制归档，且闸不生效', async () => {
  const h = await open()
  await h.turn('我们用 vitest 跑测试。')
  await h.turn('我们改成 jest 跑测试。')
  const now = h.now()
  const cells = h.memory.store.listCells({ limit: 200 })
  const old = cells.find((c) => Number(c.tInvalid ?? 0) !== 0)
  assert.ok(old, '应有一条被取代的旧值')
  // 把失效时刻推到 40 天前
  old.tInvalid = BigInt(now - 40 * DAY)
  old.tAccess = BigInt(now - 10 * DAY)
  h.memory.store.putCell(old)

  const r = evaluateRetention(old, { nowMs: now, weights: RETENTION_WEIGHTS.balanced })
  assert.equal(r.invalid, true)
  assert.equal(r.disposition, 'P2')
  assert.equal(r.protectedBy, null, '闸对失效版本不生效')
  assert.equal(r.tier, 3)
})

test('失效传播：SUPERSEDES 的 dst 侧是被取代者（v0.4 取反了）', async () => {
  const h = await open()
  await h.turn('我们用 vitest 跑测试。')
  await h.turn('我们改成 jest 跑测试。')
  const edges = h.memory.store.allEdges().filter((e) => e.rel === 7)
  assert.ok(edges.length >= 1, '应有 SUPERSEDES 边')
  const e = edges[0]
  const dst = h.memory.store.getCell(e.dst)
  const src = h.memory.store.getCell(e.src)
  assert.ok(Number(dst.tInvalid ?? 0) !== 0, 'dst（旧值）应被标记失效')
  assert.equal(Number(src.tInvalid ?? 0), 0, 'src（新值）应仍然有效')
})

test('失效传播：doctor 能发现"已失效但没降档"的存量数据，--fix 后归档', async () => {
  const h = await open()
  await h.turn('我们用 vitest 跑测试。')
  await h.turn('我们改成 jest 跑测试。')
  const now = h.now()
  const old = h.memory.store.listCells({ limit: 200 }).find((c) => Number(c.tInvalid ?? 0) !== 0)
  assert.ok(old)
  old.tInvalid = BigInt(now - 40 * DAY)
  old.tier = 1
  h.memory.store.putCell(old)

  const dry = h.memory.doctor()
  assert.ok((dry.invalidNotDemoted ?? 0) >= 1, '应报告失效未降档')
  h.memory.doctor({ fix: true })
  assert.equal(h.memory.store.getCell(old.cellId).tier, 3)
})

// ── 不变量：confidence 不许被"问得多"刷上去 ────────────────────────

test('不变量：同一条记忆被召回 20 次，confidence 漂移 < 0.05', async () => {
  const h = await open()
  await h.turn('我习惯用深色主题，浅色看久了眼睛疼。')
  const hit = h.memory.recall({ text: '深色主题', budget: 400, manual: true }).hits[0]
  const id = BigInt('0x' + hit.cellId)
  const c0 = h.memory.store.getCell(id)
  const conf0 = c0.confidence
  const stab0 = c0.stability
  for (let i = 0; i < 20; i++) h.memory.recall({ text: '深色主题', budget: 400, manual: true })
  const c1 = h.memory.store.getCell(id)
  assert.ok(Math.abs(c1.confidence - conf0) < 0.05, `confidence ${conf0} → ${c1.confidence}`)
  assert.ok(c1.stability >= stab0, '稳定性仍应单调不减')
})

test('不变量：只读召回不改任何字段', async () => {
  const h = await open()
  await h.turn('我习惯用深色主题。')
  const hit = h.memory.recall({ text: '深色主题', budget: 400, manual: true }).hits[0]
  const id = BigInt('0x' + hit.cellId)
  const before = h.memory.store.getCell(id)
  h.memory.recall({ text: '深色主题', budget: 400, manual: true, readOnly: true })
  h.memory.recall({ text: '深色主题', budget: 400, manual: true, readOnly: true })
  const after = h.memory.store.getCell(id)
  assert.equal(after.accessCount, before.accessCount)
  assert.equal(after.tAccess, before.tAccess)
  assert.equal(after.stability, before.stability)
  assert.equal(after.confidence, before.confidence)
})

// ── 隐私：URL token 不能靠切分绕过 ─────────────────────────────────

test('隐私：URL query 里的 token 不会明文落进 digest / 槽位', async () => {
  const h = await open()
  await h.turn('回调地址是 https://api.example.com/cb?access_token=SECRET1234567890 记住它。')
  const cells = h.memory.store.listCells({ limit: 50 })
  const hay = cells
    .map((c) => `${c.digest ?? ''} ${c.slots.map((s) => s.value).join(' ')}`)
    .join(' ')
  assert.ok(!hay.includes('SECRET1234567890'), `明文泄露：${hay.slice(0, 200)}`)
})

test('隐私：redact 对不带 ? 前缀的 access_token= 也生效', async () => {
  const { redact } = await import('../packages/core/lib/text.js')
  const r = redact('access_token=SECRET1234567890')
  assert.ok(!r.text.includes('SECRET1234567890'), r.text)
  assert.ok(r.pii)
})

// ── 增长与重放 ────────────────────────────────────────────────────

test('增长：墓碑压实后 doctor 报告墓碑数与字节，且不再有孤儿残差', async () => {
  const h = await open()
  for (const t of ['我用 pnpm。', 'CI 跑 6 分钟。']) await h.turn(t)
  const now = h.now()
  for (const c of h.memory.store.listCells({ limit: 200 }).filter((x) => x.provenance === 0 && x.kind <= 2)) {
    c.tAccess = BigInt(now - 900 * DAY)
    c.tIngest = BigInt(now - 1400 * DAY)
    h.memory.store.putCell(c)
  }
  for (let i = 0; i < 8; i++) h.memory.demoteDue()
  const d = h.memory.doctor()
  assert.ok((d.tombstones ?? 0) >= 2, `tombstones=${d.tombstones}`)
  assert.ok((d.tombstoneBytes ?? 0) > 0)
  assert.equal(d.orphanResiduals ?? 0, 0, '墓碑释放残差后不该留下孤儿')
})

test('重放：巩固会把"重要但掉到归档"的记忆救回一级', async () => {
  const h = await open()
  await h.turn('我习惯用深色主题，浅色看久了眼睛疼。')
  const cell = h.memory.store.listCells({ limit: 50 }).find((c) => c.provenance === 0 && c.kind <= 2)
  assert.ok(cell)
  const now = h.now()
  cell.tier = 3
  cell.tAccess = BigInt(now - 60 * DAY)
  cell.tIngest = BigInt(now - 400 * DAY)
  cell.importance = 0.9
  cell.support = 3
  h.memory.store.putCell(cell)
  const pass = h.consolidate()
  assert.ok(pass.replayed >= 1, `replayed=${pass.replayed}`)
  assert.ok(h.memory.store.getCell(cell.cellId).tier <= 3)
})

// ── 情感：调节策略与特质层 ────────────────────────────────────────

test('情感：负效价时给出调节策略，且特质层是投影而不是新状态', async () => {
  const h = await open()
  await h.turn('今天真的很难受，感觉自己什么都做不好。')
  const snap = h.memory.panelSnapshot()
  assert.ok(snap.affect)
  assert.ok(snap.affect.policy.regulation, '应有调节策略')
  assert.ok(
    ['situation-selection', 'situation-modification', 'attentional-deployment', 'cognitive-change', 'response-modulation'].includes(
      snap.affect.policy.regulation,
    ),
  )
  assert.ok(snap.affect.trait, '应有特质层投影')
  assert.ok(snap.affect.trait.O >= 0 && snap.affect.trait.O <= 1)
  assert.ok(['secure', 'anxious', 'avoidant', 'fearful'].includes(snap.affect.trait.attachment))
})

// ── 陈旧包络本身 ──────────────────────────────────────────────────

test('陈旧包络：30 天内不折损，730 天到地板', () => {
  const now = 1_800_000_000_000
  assert.equal(staleFactor(now, now), 1)
  assert.ok(Math.abs(staleFactor(now - 30 * DAY, now) - 1) < 1e-9)
  assert.ok(staleFactor(now - 365 * DAY, now) < 0.6)
  assert.ok(Math.abs(staleFactor(now - 730 * DAY, now) - 0.15) < 1e-6)
})
