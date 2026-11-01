/**
 * v0.6 · 引擎与星图
 *
 * 引擎这一层最危险的三个失效方式，全都**不报错**：
 *   ① 拿 provider 查询向量去打哈希库 → 相似度是随机数，召回悄悄变差
 *   ② reembed 中途失败 → 库里一半新空间一半旧空间
 *   ③ 星图每次刷新重排 → 用户以为记忆被改动了
 * 所以这一组的断言都指向"可复现"与"空间一致"，而不是"能跑"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EmotionMemoryEngine, buildStarMap, project3, starRank } from './helpers.mjs'
import { createHarness } from '../packages/devkit/lib/index.js'

/** 假 embedding 端口：确定性向量 + 同步缓存。形状与 HttpEmbeddingProvider 一致。 */
function fakePort(space = 'provider:fake:8') {
  const cache = new Map()
  const vec = (t) => {
    const v = new Float32Array(8)
    for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) / 255
    let s = 0
    for (const x of v) s += x * x
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0
    for (let i = 0; i < 8; i++) v[i] *= inv
    return v
  }
  return {
    name: 'fake',
    space,
    dim: 8,
    calls: 0,
    async embed(t) {
      this.calls++
      const v = vec(t)
      cache.set(t, v)
      return v
    },
    peek(t) {
      return cache.get(t) ?? null
    },
    async prime(ts) {
      let n = 0
      for (const t of ts) {
        if (cache.has(t)) continue
        await this.embed(t)
        n++
      }
      return n
    },
  }
}

async function makeEngine(opts = {}) {
  const h = await createHarness({ sessionId: opts.sessionId ?? 'v06-engine' })
  const ports = opts.ports ?? {}
  const engine = new EmotionMemoryEngine({ memory: h.memory, ports, model: opts.model ?? 'deepseek-chat' })
  return { h, engine, ports }
}

test('引擎在没有端口时也能工作：哈希 + 规则 + 启发式，且状态如实上报', async () => {
  const { h, engine } = await makeEngine()
  try {
    await h.turn('我更喜欢用 pnpm 而不是 npm')
    const st = engine.status()
    assert.equal(st.embedding.mode, 'hash')
    assert.equal(st.extractor.mode, 'rule')
    assert.equal(st.tokenizer, 'heuristic')
    assert.ok(st.limits.some((l) => l.includes('embedding')), '限制清单必须说明语义路是哈希')
    assert.ok(st.model.id.includes('deepseek'))
  } finally {
    await h.dispose()
  }
})

test('observe：更新心境并给出可注入的一行摘要', async () => {
  const { h, engine } = await makeEngine()
  try {
    const r = engine.observe('今天太棒了，终于搞定！')
    assert.ok(r.mood.v > 0, `正向输入应抬高心境效价，实际 ${r.mood.v}`)
    assert.match(r.brief, /^A\|mood:/)
    assert.ok(Array.isArray(r.hints), 'hints 必须是数组（中性心境下可以为空）')
    const neg = engine.observe('又错了，烦死了')
    assert.ok(neg.mood.v < r.mood.v, '连续负面应把心境拉下来（但不是瞬间翻转）')
    assert.ok(neg.mood.v > -1, '心境有惯性，不应一步到底')
  } finally {
    await h.dispose()
  }
})

test('recall：返回编译后的上下文，且报告是否用了 provider 向量', async () => {
  const { h, engine } = await makeEngine()
  try {
    await h.turn('我们的部署环境是 linux arm64')
    await h.turn('这个项目用 TypeScript 写，不引入第三方依赖')
    const r = await engine.recall('部署环境是什么')
    assert.ok(r.context.length > 0, '应当编译出非空上下文')
    assert.ok(r.tokens > 0)
    assert.equal(r.usedProvider, false, '没有端口时必须是哈希')
    assert.ok(['rows', 'compact', 'prose'].includes(r.mode))
  } finally {
    await h.dispose()
  }
})

test('forget：返回可核对的删除回执（digest + proof + 悬空引用数）', async () => {
  const { h, engine } = await makeEngine()
  try {
    await h.turn('我讨厌红色按钮')
    const snap = h.memory.panelSnapshot()
    assert.ok(snap.cells.length > 0, '需要先有记忆')
    const target = snap.cells[0]
    const receipt = engine.forget(target.cellId, 'soft')
    assert.equal(receipt.cellId, target.cellId)
    assert.equal(receipt.mode, 'soft')
    assert.ok(receipt.digest.length > 0, '回执必须带摘要，删完还能核对删的是哪条')
    assert.match(receipt.proof, /^[0-9a-f]{8}$/)
    assert.equal(receipt.tombstoneId, null, 'soft 删除是降档到归档层，不是墓碑')
    assert.equal(typeof receipt.danglingEdges, 'number')
    const after = h.memory.panelSnapshot()
    const found = after.cells.find((c) => c.cellId === target.cellId)
    // 软删 = 进墓碑（tier 4），不是从表里消失：墓碑要能被 restore 找回
    assert.ok(!found || found.tier >= 3 || found.invalidated, '软删后必须离开热层（降到归档层）')
  } finally {
    await h.dispose()
  }
})

test('reembed：库空间与端口空间不一致时拒用 provider 向量；重算完成后才切换', async () => {
  const port = fakePort()
  const { h, engine } = await makeEngine({ ports: { embedding: port }, sessionId: 'v06-reembed' })
  try {
    await h.turn('数据库用 node:sqlite 内置模块')
    await h.turn('测试必须能离线跑')

    // 库还是 hash 空间 → provider 不可用（这是正确行为，不是缺陷）
    assert.equal(h.memory.embSpace, 'hash')
    const before = await engine.recall('数据库')
    assert.equal(before.usedProvider, false, '空间不一致时必须退回哈希')

    const r1 = await engine.reembed({ limit: 100 })
    assert.ok(r1.total > 0)
    assert.equal(r1.done, r1.total, '一次跑完（库很小）')
    assert.equal(h.memory.embSpace, port.space, '全部完成后才切换空间')

    const after = await engine.recall('数据库')
    assert.equal(after.usedProvider, true, '切换后应走 provider 向量')
    assert.equal(engine.status().embedding.mode, 'provider')
  } finally {
    await h.dispose()
  }
})

test('reembed：分批时中途不切换空间（不留半个库）', async () => {
  const port = fakePort('provider:fake:8')
  const { h, engine } = await makeEngine({ ports: { embedding: port }, sessionId: 'v06-reembed-2' })
  try {
    for (const t of ['记忆库放在 ~/.dsh/mnemo', '保留度有七因子', '面板要有星图']) await h.turn(t)
    const total = h.memory.store.countCells()
    assert.ok(total >= 3)
    const first = await engine.reembed({ limit: 1 })
    assert.equal(first.done, 1)
    assert.ok(first.total >= 3)
    if (first.done < first.total) {
      assert.equal(h.memory.embSpace, 'hash', '没跑完不能切换空间')
    }
    // 继续跑到收敛
    let guard = 0
    let last = first
    while (last.done < last.total && guard++ < 20) last = await engine.reembed({ limit: 2 })
    assert.equal(h.memory.embSpace, port.space)
  } finally {
    await h.dispose()
  }
})

test('status：跨模型成本表随记忆增长出现，且不越预算', async () => {
  const { h, engine } = await makeEngine({ sessionId: 'v06-status' })
  try {
    await h.turn('我更喜欢用 pnpm 而不是 npm')
    await h.turn('部署环境是 linux arm64')
    const st = engine.status()
    assert.ok(st.across.length >= 4, '有记忆后应给出跨模型预览')
    for (const m of st.across) assert.ok(m.tokens <= h.memory.config.maxSurfaceTokens)
    assert.ok(st.capabilities.some((c) => c.includes('编译')))
  } finally {
    await h.dispose()
  }
})

test('project3：同一条记忆在任何时刻投影到同一坐标（星图不漂移）', () => {
  const emb = new Int8Array(64)
  for (let i = 0; i < 64; i++) emb[i] = ((i * 37) % 255) - 127
  const a = project3(emb)
  const b = project3(emb)
  assert.deepEqual(a, b)
  for (const v of a) assert.ok(v >= -1 && v <= 1, `坐标必须在 [-1,1]，实际 ${v}`)
  assert.deepEqual(project3(null), [0, 0, 0], '没有向量时落在原点，而不是 NaN')
})

test('buildStarMap：按星等采样、边只在采样内、总数字段如实', () => {
  const cells = Array.from({ length: 30 }, (_, i) => ({
    cellId: String(i).padStart(16, '0'),
    shortId: 'c' + i,
    kind: 1,
    tier: 0,
    tFrom: 1_700_000_000_000 + i,
    valence: i % 3 === 0 ? -0.6 : 0.2,
    arousal: 0.4,
    salience: 0.5,
    importance: i / 30,
    support: 1,
    confidence: 0.7,
    provenance: 0,
    trust: 240,
    changed: false,
    pinned: i === 0,
    disputed: false,
    lens: 'fact',
    emotional: i % 3 === 0,
    invalidated: false,
    tInvalid: 0,
    digest: 'd' + i,
    kv: [],
    slots: [],
    residualChars: 0,
    stability: 1,
    accessCount: i,
  }))
  const edges = [{ src: '0000000000000000', dst: '0000000000000001', weight: 64 }]
  const map = buildStarMap(cells, edges, () => null, 10)
  assert.equal(map.nodes.length, 10)
  assert.equal(map.total, 30)
  assert.equal(map.sampled, 10)
  // 边只在采样内保留：id 1 的重要性低，没进前 10，所以这条边应被丢掉
  assert.equal(map.edges.length, 0, '采样外的边不能画，否则会指向不存在的节点')
  const full = buildStarMap(cells, edges, () => null, 30)
  assert.equal(full.edges.length, 1, '全量采样时边必须保留')
  assert.ok(map.nodes.some((n) => n.pinned), '固定的记忆必须出现在采样里（星等够高）')
  for (const n of map.nodes) assert.ok(n.x >= -1 && n.x <= 1)
})

test('starRank：固定的 > 高重要的 > 已失效的', () => {
  const base = { importance: 0.5, salience: 0.5, pinned: false, emotional: false, disputed: false, invalidated: false, tier: 0, accessCount: 0 }
  assert.ok(starRank({ ...base, pinned: true }) > starRank(base))
  assert.ok(starRank({ ...base, importance: 0.9 }) > starRank(base))
  assert.ok(starRank({ ...base, invalidated: true }) < starRank(base))
  assert.ok(starRank({ ...base, tier: 4 }) < starRank({ ...base, invalidated: true }))
})
