/**
 * v0.6.1 · 星图坐标稳定性（审计稿 F8 / F9）
 *
 * 审计稿认为 `project3` 没有展开冷层 32 维向量，导致降档时坐标跳动，
 * 并建议改用 `expandEmb`。实测（见 `starmap.ts` 注释）恰恰相反：
 *   · 零填充漂移 0.031（v0.6.0 的行为）
 *   · expandEmb 漂移 0.467（审计稿的建议）
 * 因为 `pq32` 是"前 32 维的 4 bit 量化"，零填充才是它的忠实逆变换。
 *
 * 所以这一组守的是**真正重要的事**：坐标不能随层变化大幅跳动，
 * 且投影必须确定（否则"新记忆只增加点"这个前提就没了）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildStarMap, foldEmb, hashEmbedding, pq32, project3 } from './helpers.mjs'

const TEXTS = [
  '我更喜欢用 pnpm',
  '部署在 linux arm64',
  '记忆库放 ~/.dsh/mnemo',
  '用 TypeScript 写',
  '我讨厌红色按钮',
  '数据库用 node:sqlite',
  '保留度有七因子',
  'token 预算压到 320',
  '测试必须能离线跑',
  '面板要有星图',
  '每周五下午复盘',
  '固态盘比机械盘快',
]

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

test('F8：热层与冷层的坐标漂移有界（降档不该让星星跳走）', () => {
  const drifts = TEXTS.map((t) => {
    const hot = foldEmb(hashEmbedding(t, 256), 64)
    const cold = pq32(hot)
    assert.equal(cold.length, 32, '前置条件：冷层是 32 维')
    return dist(project3(hot), project3(cold))
  })
  const avg = drifts.reduce((a, b) => a + b, 0) / drifts.length
  const max = Math.max(...drifts)
  assert.ok(avg <= 0.08, `平均漂移 ${avg.toFixed(3)} 超过 0.08（降档会肉眼可见地跳动）`)
  assert.ok(max <= 0.15, `最大漂移 ${max.toFixed(3)} 超过 0.15`)
})

test('F8：expandEmb 不是更优解（把实测结论钉住，防止有人"按审计稿改回去"）', () => {
  // 这条断言的价值是**记录反例**：如果将来有人把零填充换成 expandEmb，
  // 漂移会从 ~0.03 涨到 ~0.4，这里会红。
  const drifts = TEXTS.map((t) => {
    const hot = foldEmb(hashEmbedding(t, 256), 64)
    const cold = pq32(hot)
    const expanded = new Int8Array(64)
    // 复刻 expandEmb 的 32 维分支（8 段 × 4 字节，×16 还原量级）
    const seg = 8
    const perSub = 2
    for (let s = 0; s < 8; s++) {
      for (let b = 0; b < 4; b++) {
        const val = (((cold[s * 4 + b] << 28) >> 28) || 0) * 16
        for (let j = 0; j < perSub; j++) {
          const i = s * seg + b * perSub + j
          if (i < 64) expanded[i] = val
        }
      }
    }
    return dist(project3(hot), project3(expanded))
  })
  const avgExpanded = drifts.reduce((a, b) => a + b, 0) / drifts.length
  assert.ok(avgExpanded > 0.2, `expandEmb 的漂移应显著更大（实测 ~0.47），实际 ${avgExpanded.toFixed(3)}`)
})

test('F8：投影是确定的（同一向量任意次调用结果逐位相同）', () => {
  for (const t of TEXTS.slice(0, 4)) {
    const emb = foldEmb(hashEmbedding(t, 256), 64)
    const a = project3(emb)
    const b = project3(emb)
    assert.deepEqual(a, b)
    for (const v of a) assert.ok(v >= -1 && v <= 1)
  }
})

test('F8：更长向量折到 64 维后仍落在单位立方体内', () => {
  const emb256 = hashEmbedding('我更喜欢用 pnpm', 256)
  const p = project3(emb256, 64)
  assert.equal(p.length, 3)
  for (const v of p) assert.ok(Number.isFinite(v) && v >= -1 && v <= 1)
})

test('F9：投影向量缓存不改变结果（1200 次调用与 1 次一致）', () => {
  const emb = foldEmb(hashEmbedding('缓存不能改变结果', 256), 64)
  const first = project3(emb)
  let last = first
  for (let i = 0; i < 1200; i++) last = project3(emb)
  assert.deepEqual(last, first)
})

test('F9：buildStarMap 在大批量下仍保持确定性（面板每 3 秒重建一次）', () => {
  const cells = TEXTS.map((t, i) => ({
    cellId: String(i).padStart(16, '0'),
    shortId: 'c' + i,
    kind: 1,
    tier: 0,
    tFrom: 1_700_000_000_000 + i,
    valence: 0.2,
    arousal: 0.4,
    salience: 0.5,
    importance: 0.5,
    support: 1,
    confidence: 0.7,
    provenance: 0,
    trust: 240,
    changed: false,
    pinned: false,
    disputed: false,
    lens: 'fact',
    emotional: false,
    invalidated: false,
    tInvalid: 0,
    digest: t,
    kv: [],
    slots: [],
    residualChars: 0,
    stability: 1,
    accessCount: 0,
  }))
  const a = buildStarMap(cells, [], () => null, 100)
  const b = buildStarMap(cells, [], () => null, 100)
  assert.deepEqual(
    a.nodes.map((n) => [n.id, n.x, n.y, n.z]),
    b.nodes.map((n) => [n.id, n.x, n.y, n.z]),
  )
})
