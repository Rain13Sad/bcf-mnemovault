/**
 * 星图坐标（审计稿 F8 / F9，v0.6.2 重写断言）
 *
 * ── 为什么这组测试在 v0.6.2 被重写 ───────────────────────────────
 * v0.6.1 的 F8 断言"热层与冷层坐标漂移 ≤ 0.08"，实测通过——但它是**恒真**的：
 * 当时 `project3` 按 `v[i] / 127` 缩放，而哈希向量只有 ±4…±8，
 * 于是所有坐标都落在 ±0.03 内，**1200 条记忆在星图上塌成一个点**。
 * 两个都贴原点的点，距离当然很小。断言测的是"两个点都塌了"，不是"两个点重合"。
 *
 * 现在守三件真正重要的事：
 *   1. **点云必须展开**——这是塌缩 bug 的直接探针（半径、标准差）；
 *   2. 降档后坐标**相对**漂移有界（相对 = 漂移 / 平均半径，与尺度无关）；
 *   3. 投影确定（否则"新记忆只增加点、不移动旧点"这个前提就没了）。
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
const radius = (p) => Math.hypot(p[0], p[1], p[2])

/** 12 条真实风格的记忆在 64 维哈希空间里的投影点。 */
function hotPoints() {
  return TEXTS.map((t) => project3(foldEmb(hashEmbedding(t, 256), 64)))
}

function meanRadius(pts) {
  return pts.reduce((n, p) => n + radius(p), 0) / pts.length
}

/**
 * 点云必须展开（v0.6.2 新增，塌缩 bug 的直接探针）。
 *
 * 塌缩时的实测值：平均半径 0.03、坐标标准差 0.02。
 * 修好后：平均半径 ≈ 0.34、标准差 ≈ 0.21。阈值取中间，留足余量。
 */
test('F8：点云必须展开（防星图塌成一个点）', () => {
  const pts = hotPoints()
  const meanR = meanRadius(pts)
  assert.ok(meanR >= 0.15, `平均半径 ${meanR.toFixed(3)} 太小——星图塌缩了（修前是 0.03）`)

  const coords = pts.flat()
  const mean = coords.reduce((a, b) => a + b, 0) / coords.length
  const std = Math.sqrt(coords.reduce((a, b) => a + (b - mean) ** 2, 0) / coords.length)
  assert.ok(std >= 0.10, `坐标标准差 ${std.toFixed(3)} 太小——所有点挤在一起`)

  // 至少要有两个点在视觉上分得开（半径的 10% 以上），否则"星图"没有意义
  let spreadPairs = 0
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (dist(pts[i], pts[j]) > meanR * 0.1) spreadPairs++
    }
  }
  assert.ok(spreadPairs > 20, `只有 ${spreadPairs} 对点分得开，星图没有可读性`)
})

/**
 * 降档（热 → 冷）的坐标漂移必须**相对**有界。
 *
 * 用相对量而不是绝对值：绝对阈值会随尺度变化而失效——v0.6.1 的 0.08 就是这么来的。
 * 实测（v0.6.2，成对常量投影 + L2 归一）：相对平均漂移 0.38、相对最大 0.66。
 */
test('F8：降档的坐标漂移相对有界（降档不该让星星跳走）', () => {
  const meanR = meanRadius(hotPoints())
  const drifts = TEXTS.map((t) => {
    const hot = foldEmb(hashEmbedding(t, 256), 64)
    const cold = pq32(hot)
    assert.equal(cold.length, 32, '前置条件：冷层是 32 维')
    return dist(project3(hot), project3(cold))
  })
  const avg = drifts.reduce((a, b) => a + b, 0) / drifts.length
  const max = Math.max(...drifts)
  assert.ok(avg / meanR <= 0.55, `相对平均漂移 ${(avg / meanR).toFixed(3)} 超过 0.55（实测 0.38）`)
  assert.ok(max / meanR <= 0.95, `相对最大漂移 ${(max / meanR).toFixed(3)} 超过 0.95（实测 0.66）`)
})

/**
 * 冷层必须用 `expandEmb` 展开，不能用零填充。
 *
 * v0.6.1 有一条**反向**断言（"expandEmb 不是更优解"），依据是塌缩尺度上的
 * 0.031 vs 0.467。归一化后重测，结论反了：expandEmb 0.130、零填充 0.500。
 * 这条断言把新结论钉住，防止有人照着旧注释改回零填充。
 */
test('F8：冷层用 expandEmb 展开优于零填充（记录归一化后的实测结论）', () => {
  const meanR = meanRadius(hotPoints())
  const driftOf = (expand) => {
    const ds = TEXTS.map((t) => {
      const hot = foldEmb(hashEmbedding(t, 256), 64)
      const cold = pq32(hot)
      let restored
      if (expand) {
        // 复刻 expandEmb 的 32 维分支（8 段 × 4 字节，每字节铺 2 维，×16 还原量级）
        restored = new Int8Array(64)
        const seg = 8
        const perSub = 2
        for (let s = 0; s < 8; s++) {
          for (let b = 0; b < 4; b++) {
            const val = (((cold[s * 4 + b] << 28) >> 28) || 0) * 16
            for (let j = 0; j < perSub; j++) {
              const i = s * seg + b * perSub + j
              if (i < 64) restored[i] = val
            }
          }
        }
      } else {
        // 零填充：把 32 个 nibble 放在前 32 维
        restored = new Int8Array(64)
        restored.set(cold)
      }
      return dist(project3(hot), project3(restored))
    })
    return ds.reduce((a, b) => a + b, 0) / ds.length
  }
  const withExpand = driftOf(true)
  const withZeroFill = driftOf(false)
  assert.ok(
    withExpand < withZeroFill,
    `expandEmb 漂移 ${withExpand.toFixed(3)} 应小于零填充 ${withZeroFill.toFixed(3)}`,
  )
  assert.ok(withExpand / meanR <= 0.55, `expandEmb 相对漂移 ${(withExpand / meanR).toFixed(3)} 过大`)
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

test('F8：空向量 / 零向量落在原点（不产生 NaN）', () => {
  assert.deepEqual(project3(null), [0, 0, 0])
  assert.deepEqual(project3(new Int8Array(64)), [0, 0, 0])
})

/**
 * 语义保距（v0.6.2 新增）：向量余弦越高的两条记忆，投影后应越近。
 *
 * 这条不是"精确保距"（3 维装不下 64 维），而是防止投影基退化成
 * "把所有点推到同一个方向"——那会让星图看起来有展开、实际毫无信息。
 */
test('F8：投影保持语义（余弦高的记忆在星图上更近）', () => {
  const hots = TEXTS.map((t) => foldEmb(hashEmbedding(t, 256), 64))
  const pts = hots.map((h) => project3(h))
  const cos = (a, b) => {
    let d = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      d += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return d / (Math.sqrt(na) * Math.sqrt(nb))
  }
  // 取余弦最高与最低的一对，比较它们在星图上的距离
  const pairs = []
  for (let i = 0; i < hots.length; i++) {
    for (let j = i + 1; j < hots.length; j++) {
      pairs.push({ c: cos(hots[i], hots[j]), d: dist(pts[i], pts[j]) })
    }
  }
  pairs.sort((a, b) => b.c - a.c)
  const topK = pairs.slice(0, 8)
  const botK = pairs.slice(-8)
  const avgD = (xs) => xs.reduce((n, x) => n + x.d, 0) / xs.length
  assert.ok(
    avgD(topK) < avgD(botK),
    `最相似的 8 对平均距离 ${avgD(topK).toFixed(3)} 应小于最不相似的 ${avgD(botK).toFixed(3)}`,
  )
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
