/**
 * v0.6.1 · 引擎的两处「悄悄做错」（审计稿 F5 / F6）
 *
 * 这两条的共同点是：**不报错，只是结果不对**。
 *   · F6：hard 删除后悬空边必然是 0，回执却报删除前的数量
 *   · F5：reembed 中途失败会留下"半份新空间向量 + 半份旧空间向量"的库，
 *         而 space 仍是旧值、索引仍是旧向量、doctor 什么也不说
 * 所以断言都盯着"失败之后系统处于什么状态"，而不是"成功路径能不能跑"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EmotionMemoryEngine, REL } from './helpers.mjs'
import { createHarness } from '../packages/devkit/lib/index.js'

/** 确定性假端口：可以按调用次数注入失败。 */
function fakePort(opts = {}) {
  const cache = new Map()
  let calls = 0
  const failAt = opts.failAt ?? Infinity
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
    space: opts.space ?? 'provider:fake:8',
    dim: 8,
    get calls() {
      return calls
    },
    async embed(t) {
      calls++
      if (calls === failAt) throw new Error('boom（注入的第 N 次失败）')
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

async function make(opts = {}) {
  const h = await createHarness({ sessionId: opts.sessionId ?? 'v061-engine' })
  const ports = opts.ports ?? {}
  const engine = new EmotionMemoryEngine({ memory: h.memory, ports, model: 'deepseek-chat' })
  return { h, engine }
}

test('F6：hard 删除的回执必须报删除**之后**的悬空边（级联删边后恒为 0）', async () => {
  const { h, engine } = await make({ sessionId: 'v061-forget-hard' })
  try {
    await h.turn('我讨厌红色按钮')
    const snap = h.memory.panelSnapshot()
    const target = snap.cells[0]
    const id = BigInt('0x' + target.cellId)
    // 手工造 3 条边（指向另外三条真实记忆），确保"删除前确实有边"
    const others = snap.cells.slice(1, 4)
    for (const o of others) {
      h.memory.store.putEdge({ src: id, dst: BigInt('0x' + o.cellId), rel: REL.ASSOC, weight: 64 })
    }
    const before = h.memory.store.edgesFrom(id).length + h.memory.store.edgesTo(id).length
    assert.ok(before >= 2, `前置条件：删除前应连着若干条边，实际 ${before}`)

    const receipt = engine.forget(target.cellId, 'hard')
    assert.equal(receipt.danglingEdges, 0, 'hard 删除会级联删边，回执必须报 0')
    assert.equal(
      h.memory.store.edgesFrom(id).length + h.memory.store.edgesTo(id).length,
      0,
      '库里也必须真的没有悬空边',
    )
  } finally {
    await h.dispose()
  }
})

test('F6：soft 删除的回执报删除**之前**的引用数（归档层保留关系）', async () => {
  const { h, engine } = await make({ sessionId: 'v061-forget-soft' })
  try {
    await h.turn('我讨厌红色按钮')
    const snap = h.memory.panelSnapshot()
    const target = snap.cells[0]
    const id = BigInt('0x' + target.cellId)
    for (const o of snap.cells.slice(1, 3)) {
      h.memory.store.putEdge({ src: id, dst: BigInt('0x' + o.cellId), rel: REL.ASSOC, weight: 64 })
    }
    const receipt = engine.forget(target.cellId, 'soft')
    assert.equal(receipt.danglingEdges, 2, 'soft 删除后边仍在，回执报它连着几条')
    assert.equal(h.memory.store.edgesFrom(id).length, 2, '归档层的边不该被删')
  } finally {
    await h.dispose()
  }
})

test('F5：reembed 中途失败 → 空间不切换、留下 inflight 标记、doctor 与 status 都要说出来', async () => {
  const port = fakePort({ failAt: 2 })
  const { h, engine } = await make({ ports: { embedding: port }, sessionId: 'v061-reembed-fail' })
  try {
    for (const t of ['记忆库放在 ~/.dsh/mnemo', '保留度有七因子', '面板要有星图']) await h.turn(t)
    const before = h.memory.store.countCells()
    assert.ok(before >= 3)

    const r = await engine.reembed({ limit: 5 })
    assert.equal(r.inflight, true, '中途失败必须标记未完成')
    assert.equal(h.memory.embSpace, 'hash', '没跑完就不能切换空间')
    const inflight = engine.readInflight()
    assert.ok(inflight, '必须留下 inflight 标记')
    assert.equal(inflight.space, port.space)
    assert.ok(inflight.cursor >= 1 && inflight.cursor < inflight.total, `游标应在中间，实际 ${inflight.cursor}/${inflight.total}`)

    const st = engine.status()
    assert.ok(
      st.limits.some((l) => l.includes('未完成') && l.includes('重算')),
      `status().limits 必须提示未完成的重算：${st.limits.join(' | ')}`,
    )
    const doc = h.memory.doctor()
    assert.ok(
      doc.issues.some((i) => i.includes('未完成的向量重算')),
      `doctor 必须报告未完成的重算：${doc.issues.join(' | ')}`,
    )
  } finally {
    await h.dispose()
  }
})

test('F5：修好端口后续跑能干净完成，空间切换、标记清空、索引可用', async () => {
  const bad = fakePort({ failAt: 2 })
  const { h, engine } = await make({ ports: { embedding: bad }, sessionId: 'v061-reembed-resume' })
  try {
    for (const t of ['记忆库放在 ~/.dsh/mnemo', '保留度有七因子', '面板要有星图']) await h.turn(t)
    await engine.reembed({ limit: 5 })
    assert.equal(h.memory.embSpace, 'hash')

    // 同一个 space 的"修好的端口"：续跑
    const good = fakePort()
    engine.ports.embedding = good
    h.memory.usePorts({ embedding: good })
    let r = await engine.reembed({ limit: 5 })
    let guard = 0
    while (r.inflight && guard++ < 10) r = await engine.reembed({ limit: 5 })

    assert.equal(r.inflight, false, '续跑必须能完成')
    assert.equal(h.memory.embSpace, good.space, '完成后才切换空间')
    assert.equal(engine.readInflight(), null, '完成后必须清掉 inflight 标记')
    assert.equal(h.memory.doctor().issues.some((i) => i.includes('未完成的向量重算')), false)

    // 索引仍可用：召回不崩，且用的就是新空间
    const recall = await engine.recall('记忆库')
    assert.equal(recall.usedProvider, true, '空间一致后应走 provider 向量')
    assert.ok(recall.context.length > 0)
  } finally {
    await h.dispose()
  }
})

test('F5：换了目标空间时游标归零重算（不把两个空间缝在一起）', async () => {
  const a = fakePort({ failAt: 2, space: 'provider:a:8' })
  const { h, engine } = await make({ ports: { embedding: a }, sessionId: 'v061-reembed-switch' })
  try {
    for (const t of ['记忆库放在 ~/.dsh/mnemo', '保留度有七因子', '面板要有星图']) await h.turn(t)
    await engine.reembed({ limit: 1 })
    const first = engine.readInflight()
    assert.equal(first.space, 'provider:a:8')

    // 换一家 provider（不同空间）：必须从 0 开始，而不是接着 a 的游标跑
    const b = fakePort({ space: 'provider:b:8' })
    engine.ports.embedding = b
    h.memory.usePorts({ embedding: b })
    const r = await engine.reembed({ limit: 1 })
    const after = engine.readInflight()
    assert.equal(after.space, 'provider:b:8', 'inflight 的目标空间必须换成新的')
    assert.equal(r.done, 1, '新空间必须从第 0 条开始算')
  } finally {
    await h.dispose()
  }
})

test('F5：reembed 写入走服务的公共路径（cell.emb 真的变了，不是只改了游标）', async () => {
  const port = fakePort()
  const { h, engine } = await make({ ports: { embedding: port }, sessionId: 'v061-reembed-write' })
  try {
    await h.turn('数据库用 node:sqlite 内置模块')
    const snap = h.memory.panelSnapshot()
    const id = BigInt('0x' + snap.cells[0].cellId)
    const before = Array.from(h.memory.store.getCell(id).emb)
    await engine.reembed({ limit: 50 })
    const after = Array.from(h.memory.store.getCell(id).emb)
    assert.notDeepEqual(after, before, '重算后向量必须变化')
    assert.equal(after.length, before.length, '落盘维度不变（布局键不能变）')
  } finally {
    await h.dispose()
  }
})
