/**
 * 核心不变量：二进制布局、遗忘曲线、打分归一化、MRS 字节稳定性。
 * 这四项一旦破，前面所有性质都白算——它们分别是"存得下""忘得对""排得准""读得稳"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLAG,
  MemoryStore,
  SdrSpace,
  computeR,
  decodeCell,
  defaultConfig,
  encodeCell,
  renderRow,
  retrievability,
  reinforce,
  shouldDemote,
  scoreCandidate,
  hashEmbedding,
} from './helpers.mjs'

const space = new SdrSpace({ dim: 2048, k: 8 })

function mkCell(over = {}) {
  const slots = [
    { role: 1, type: 'LIT', value: '用户' },
    { role: 2, type: 'LIT', value: 'ui.theme' },
    { role: 3, type: 'LIT', value: 'dark' },
    { role: 9, type: 'LIT', value: 'pos' },
  ]
  const sdr = space.bundle(slots.map((s) => space.bind(space.identity('V:' + s.value), space.role(String(s.role)))))
  const now = 1_700_000_000_000
  return {
    cellId: 0x1234abcdn,
    kind: 1,
    tier: 1,
    flags: FLAG.residual,
    tFrom: BigInt(now),
    tTo: BigInt(now),
    tIngest: BigInt(now),
    tAccess: BigInt(now),
    accessCount: 3,
    stability: 7,
    importance: 0.62,
    valence: 0.6,
    arousal: 0.35,
    dominance: 0.5,
    salience: 0.7,
    provenance: 0,
    trust: 240,
    sdr,
    emb: hashEmbedding('用户偏好深色主题', 256),
    slots,
    edges: [{ targetPrefix: 0x99, rel: 5, weight: 48 }],
    residual: { sha: new Uint8Array(32).fill(7), off: 0n, rawLen: 64 },
    confidence: 0.95,
    support: 2,
    topic: 'ui-theme',
    digest: '用户偏好深色界面',
    ...over,
  }
}

test('cell 编解码往返：头部字段、槽位、边、残差引用', () => {
  const c = mkCell()
  const bytes = encodeCell(c)
  assert.equal(bytes[0], 0x4d)
  assert.equal(bytes[4], 2) // 布局版本
  const back = decodeCell(bytes, space)
  assert.equal(back.cellId, c.cellId)
  assert.equal(back.kind, 1)
  assert.equal(back.flags, c.flags)
  assert.equal(back.slots.length, 4)
  assert.equal(back.slots[1].value, 'ui.theme')
  assert.equal(back.edges.length, 1)
  assert.equal(back.edges[0].rel, 5)
  assert.ok(Math.abs(back.valence - 0.6) < 1e-3, `valence=${back.valence}`)
  assert.equal(back.residual.rawLen, 64)
  assert.equal(back.support, 1) // 双置信度不在 blob 里，由列承载
})

test('布局版本不匹配必须拒绝解码（不能静默混读）', () => {
  const bytes = encodeCell(mkCell())
  bytes[4] = 9
  assert.throws(() => decodeCell(bytes, space), /布局版本不匹配/)
})

test('头部 CRC 校验能抓到一位翻转', () => {
  const bytes = encodeCell(mkCell())
  bytes[0x30] ^= 0xff
  assert.throws(() => decodeCell(bytes, space), /CRC32/)
})

test('SDR 维度不匹配时拒绝解码并提示 rebuild', () => {
  const bytes = encodeCell(mkCell())
  const other = new SdrSpace({ dim: 1024, k: 8 })
  assert.throws(() => decodeCell(bytes, other), /维度不匹配/)
})

test('遗忘曲线：t=S 时 R=0.9（这是 S 的定义，不是拟合）', () => {
  for (const s of [2, 7, 30]) {
    assert.ok(Math.abs(retrievability(s, s) - 0.9) < 1e-6, `S=${s} → ${retrievability(s, s)}`)
  }
})

test('遗忘曲线三档 S₀ 的表格值与文档一致', () => {
  const rows = [
    ['procedure', 30, [0.996, 0.974, 0.9, 0.766]],
    ['semantic', 7, [0.984, 0.9, 0.706, 0.499]],
    ['episodic', 2, [0.946, 0.741, 0.47, 0.294]],
  ]
  for (const [, s, expected] of rows) {
    const got = [1, 7, 30, 90].map((d) => Number(retrievability(d, s).toFixed(3)))
    got.forEach((g, i) => assert.ok(Math.abs(g - expected[i]) <= 0.002, `S=${s} day=${[1, 7, 30, 90][i]} got ${g} want ${expected[i]}`))
  }
})

test('复述增益有上限，不会无限膨胀', () => {
  let s = 7
  for (let i = 0; i < 200; i++) s = reinforce(s, 0.5, 30)
  assert.ok(s <= 3650, `stability 爆了：${s}`)
})

test('降层判据：R<0.35 或 30 天未访问，后者通常先生效', () => {
  const now = Date.now()
  assert.equal(shouldDemote(now - 1000, 7, now), false)
  assert.equal(shouldDemote(now - 31 * 86400_000, 30, now), true)
})

test('打分归一化到 [0,1]，且 Σ_active_weights 只算可用项', () => {
  const config = defaultConfig()
  const cand = {
    cell: mkCell(),
    channels: new Set(['semantic']),
    simSemantic: 0.8,
    simSymbolic: 0,
    simGraph: 0,
    simTemporal: 0,
    hop: 99,
    web: false,
  }
  const ctx = { q: { text: 'x', budget: 320 }, mood: { v: 0, a: 0, d: 0, s: 0 }, now: Date.now(), config }
  const b = scoreCandidate(cand, ctx)
  assert.ok(b.score >= 0 && b.score <= 1, `score=${b.score}`)
  // 无 goal 时不计 w_goal
  assert.equal(b.weights.goal, 0)
  const sumActive = b.weights.sim + b.weights.recency + b.weights.freq + b.weights.affect + b.weights.cue + b.weights.interf
  assert.ok(Math.abs(b.activeW - sumActive) < 1e-9)
})

test('心境一致权重是平滑的，不是硬跳变（修 D-04 的同类问题）', () => {
  const config = defaultConfig()
  const cand = {
    cell: mkCell(),
    channels: new Set(['semantic']),
    simSemantic: 0.5,
    simSymbolic: 0,
    simGraph: 0,
    simTemporal: 0,
    hop: 99,
    web: false,
  }
  const at = (v) => scoreCandidate(cand, { q: { text: 'x', budget: 320 }, mood: { v, a: 0, d: 0, s: 0 }, now: Date.now(), config }).weights.affect
  const a = at(-0.49)
  const b = at(-0.51)
  assert.ok(Math.abs(a - b) < 0.02, `-0.49→${a} 与 -0.51→${b} 之间不应突变`)
  assert.equal(at(-0.5), 0)
  assert.ok(at(0) > 0.2)
})

test('MRS 字节稳定：同 cell 两次渲染逐字节一致', () => {
  const c = mkCell()
  const a = renderRow(c, '7f3a')
  const b = renderRow(c, '7f3a')
  assert.equal(a, b)
  assert.match(a, /^M:7f3a\|T:\d{4}\|P:u\|F:fact\|K:ui\.theme=dark\|V:\+0\.6\|S:0\.7\|C:0\.95$/)
})

test('偏好帧渲染成 话题=取值（F:pref），而不是 取值=prefers', () => {
  const c = mkCell({
    slots: [
      { role: 1, type: 'LIT', value: '用户' },
      { role: 3, type: 'LIT', value: 'prefers' },
      { role: 2, type: 'LIT', value: 'dark' },
      { role: 6, type: 'LIT', value: 'ui.theme' },
      { role: 9, type: 'LIT', value: 'pos' },
    ],
  })
  const line = renderRow(c, 'beef')
  assert.ok(line.includes('F:pref'), line)
  assert.ok(line.includes('K:ui.theme=dark'), line)
})

test('MRS 浮点两位去尾零（附录 A 的硬约束）', () => {
  const c = mkCell({ valence: 0.6, salience: 0.5, confidence: 1 })
  const line = renderRow(c, 'abcd')
  assert.ok(line.includes('V:+0.6'), line)
  assert.ok(line.includes('S:0.5'), line)
  assert.ok(line.includes('C:1'), line)
})

test('MemoryStore 的 Jaccard 去重与统计口径', () => {
  const store = new MemoryStore(space)
  store.putCell(mkCell())
  assert.equal(store.countCells(), 1)
  const got = store.getCell(0x1234abcdn)
  assert.ok(got)
  assert.equal(got.slots.length, 4)
  store.deleteCell(0x1234abcdn)
  assert.equal(store.countCells(), 0)
})

test('computeR 与 retrievability 同源', () => {
  assert.equal(computeR(3, 7), retrievability(3, 7))
})
