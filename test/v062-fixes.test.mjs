/**
 * v0.6.2 · 技术深度分析报告修复项的回归
 *
 * 这一组测试的存在理由很具体：v0.6.1 有一批**看起来在守、实际恒真**的断言
 * （最典型的是星图 F8："漂移 ≤ 0.08" 在塌缩下永远成立）。
 * 所以每条修复都必须配一条**能证明修复真的生效**的断言——
 * 也就是"改回去就会红"，而不是"现在恰好是绿的"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { after } from 'node:test'
import {
  SdrSpace,
  KIND,
  hashEmbedding,
  parseTimeExpr,
  pruneQueryEntities,
} from './helpers.mjs'
import { appraise, coreAffect, neutralIntero } from '../packages/affect/lib/index.js'
import { fillSlots } from '../packages/encoder/lib/index.js'
import { createHarness } from '../packages/devkit/lib/index.js'

const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ sessionId: 'v062-' + Math.random().toString(36).slice(2), ...opts })
  opened.push(h)
  return h
}
after(async () => {
  for (const h of opened) await h.dispose()
})

// ── M1：identity 的 64 位熵 + 位不丢失 ──────────────────────────────

test('M1：identity 必须精确产出 k 个位（负数下标会静默丢位）', () => {
  const space = new SdrSpace({ dim: 2048, k: 8 })
  // 混合通道 XOR 在 JS 里是有符号整数：不 >>>0 就会得到负 bit 下标，
  // 而 out[负下标] |= m 是往数组对象挂非索引属性——位丢了但 placed 照加。
  // 这条断言直接量 popcount，任何"少放了几位"的实现都会红。
  for (let i = 0; i < 500; i++) {
    const s = space.identity('TOK:' + i)
    assert.equal(space.popcount(s), 8, `第 ${i} 个 token 只放了 ${space.popcount(s)} 个位`)
  }
})

test('M1：identity 是确定的（同 token 任意次调用逐位相同）', () => {
  const space = new SdrSpace({ dim: 2048, k: 8 })
  for (const t of ['用户', 'pnpm', '字体', 'deploy', 'node:sqlite']) {
    assert.deepEqual([...space.identity(t)], [...space.identity(t)])
  }
})

test('M1：5000 个 token 不出现身份码碰撞（32 位熵在这里已经 ~1.5% 风险）', () => {
  const space = new SdrSpace({ dim: 2048, k: 8 })
  const seen = new Map()
  let collisions = 0
  for (let i = 0; i < 5000; i++) {
    const key = [...space.identity('COLLIDE:' + i)].join(',')
    if (seen.has(key)) collisions++
    else seen.set(key, i)
  }
  assert.equal(collisions, 0, `出现 ${collisions} 对碰撞（32 位熵下这里期望 1~2 对）`)
})

// ── M2：kWTA 不能系统性偏袒低位索引 ─────────────────────────────────

test('M2：kWTA 保留的位不应系统性偏向低位（哈希决定平手）', () => {
  const space = new SdrSpace({ dim: 2048, k: 8 })
  // 造一个稠密码，强制 kWTA 裁到 64 位
  const dense = space.zero()
  for (let i = 0; i < 2048; i++) dense[i >>> 5] |= 1 << (i & 31)
  const kept = space.kWTA(dense, 64)
  assert.equal(space.popcount(kept), 64)

  const idx = []
  for (let i = 0; i < 2048; i++) if ((kept[i >>> 5] >>> (i & 31)) & 1) idx.push(i)
  const mean = idx.reduce((a, b) => a + b, 0) / idx.length
  // 按位索引排序会稳定保留 0..63，均值 ≈ 31.5；
  // 哈希强度排序应接近全量程中点 1024。
  assert.ok(mean > 300, `保留位的平均下标 ${mean.toFixed(0)} 太低——kWTA 仍在按索引裁剪`)
  assert.ok(idx.some((i) => i >= 1024), '高位段完全没被保留——位索引偏置仍在')
})

// ── A8：时间表达式补漏 ──────────────────────────────────────────────

test('A8：上月 / 本月 / 近几个月 / 前年 都能解析', () => {
  const now = new Date(2026, 4, 15, 12, 0, 0).getTime() // 2026-05-15
  const cases = ['上月', '本月', '近几个月', '前年', '3个月前', '2周前']
  for (const c of cases) {
    const r = parseTimeExpr(`我们在${c}讨论过这个`, now)
    assert.ok(r, `「${c}」没有被解析出来`)
    assert.ok(r.from <= r.to, `「${c}」的区间反了`)
  }
})

test('A8：上月是"上一个自然月"，不是"30 天前"', () => {
  const now = new Date(2026, 4, 15, 12, 0, 0).getTime() // 2026-05-15
  const r = parseTimeExpr('上月定的方案', now)
  const from = new Date(r.from)
  assert.equal(from.getMonth(), 3, '上月应落在 4 月（getMonth()=3）')
  assert.equal(from.getFullYear(), 2026)
})

test('A8：没有时间表达时返回 undefined（宁缺勿错）', () => {
  assert.equal(parseTimeExpr('我用 pnpm 构建'), undefined)
})

// ── §3.6：混合情感不该把唤起度也归零 ────────────────────────────────

test('§3.6：混合情感有净零效价但**不**是零唤起', () => {
  const mixed = appraise({ text: '虽然很难受，但也挺开心的' })
  assert.ok(mixed.charge !== undefined && Math.abs(mixed.charge) < 0.2, `混合情感净方向应接近 0，实际 ${mixed.charge}`)
  assert.ok(mixed.intensity > 0.3, `混合情感的总强度应显著大于 0，实际 ${mixed.intensity}`)

  const neutral = appraise({ text: '把那个文件挪到另一个目录' })
  assert.ok(neutral.intensity < 0.05, `中性句的总强度应接近 0，实际 ${neutral.intensity}`)

  const i = neutralIntero()
  const aMixed = coreAffect(mixed, i)
  const aNeutral = coreAffect(neutral, i)
  assert.ok(aMixed.a > aNeutral.a + 0.05, `混合情感的唤起 ${aMixed.a.toFixed(3)} 应高于中性句 ${aNeutral.a.toFixed(3)}`)
})

test('§3.6：「气死」被识别为负向（旧词表漏判为 0）', () => {
  const a = appraise({ text: '气死我了' })
  assert.ok(a.charge < 0, `charge 应为负，实际 ${a.charge}`)
  assert.ok(a.intensity > 0.2, `intensity 应 > 0.2，实际 ${a.intensity}`)
})

// ── §5.1：值槽保护（抽不到取值就不产出空壳 cell） ───────────────────

test('§5.1：偏好句抽不到 (话题,取值) 时返回 null，不产出 X=喜欢 型空壳', () => {
  const base = { ents: ['喜欢'], pred: 'prefers', neg: false, provenance: 0 }
  assert.equal(fillSlots('我更喜欢', base), null, '没有取值的偏好句应被拒绝')

  // 有取值时必须正常产出（不能因为加了保护就把好句子也毙掉）
  const ok = fillSlots('我更喜欢等宽字体', { ents: ['等宽字体', '字体'], pred: 'prefers', neg: false, provenance: 0 })
  assert.ok(Array.isArray(ok) && ok.length > 0, '有取值的偏好句必须正常产出槽位')
  const patient = ok.find((s) => s.role === 2)
  assert.ok(patient && patient.value, 'PATIENT 槽必须有值')
})

test('§5.1：非偏好句不受值槽保护影响（陈述句可以没有客体）', () => {
  const r = fillSlots('今天下雨了', { ents: ['下雨'], pred: 'states', neg: false, provenance: 0 })
  assert.ok(Array.isArray(r) && r.length >= 2, '陈述句应正常产出槽位')
})

// ── §3.3：弃权判定 ──────────────────────────────────────────────────

test('§3.3：空库召回返回 verdict=none 并注入弃权声明', async () => {
  const h = await open()
  const r = h.memory.recall({ text: '我们上周定的字体是什么？', budget: 320, manual: true, readOnly: true })
  assert.equal(r.verdict, 'none', `空库应判 none，实际 ${r.verdict}`)
  assert.ok(r.rendered.includes('未找到相关记忆'), `缺少弃权声明：${r.rendered.slice(0, 80)}`)
})

test('§3.3：有命中时 verdict=hit 且不注入弃权声明', async () => {
  const h = await open()
  await h.turn('我更喜欢用 pnpm 构建')
  const r = h.memory.recall({ text: '我用什么构建？', budget: 320, manual: true, readOnly: true })
  assert.equal(r.verdict, 'hit', `应判 hit，实际 ${r.verdict}（hits=${r.hits.length}）`)
  assert.ok(!r.rendered.includes('未找到相关记忆'), '命中时不该出现弃权声明')
})

// ── §5.2：查询侧 IDF 剪枝 ───────────────────────────────────────────

test('§5.2：文档数不足时不剪枝（小库上 df 抖动比信号大）', () => {
  const deps = { tokenDf: () => ({ df: new Map([['我的', 5], ['pnpm', 5]]), docs: 5 }) }
  const cfg = { idfEnabled: true, idfMinDocs: 30, idfMaxDfRatio: 0.6 }
  assert.deepEqual(pruneQueryEntities(['我的', 'pnpm'], deps, cfg), ['我的', 'pnpm'])
})

test('§5.2：高频 token 被剔除，稀有 token 保留', () => {
  const docs = 100
  const deps = { tokenDf: () => ({ df: new Map([['我的', 95], ['这个', 90], ['pnpm', 3]]), docs }) }
  const cfg = { idfEnabled: true, idfMinDocs: 30, idfMaxDfRatio: 0.6 }
  assert.deepEqual(pruneQueryEntities(['我的', '这个', 'pnpm'], deps, cfg), ['pnpm'])
})

test('§5.2：绝不剪空——全高频时保留最稀有的一个', () => {
  const docs = 100
  const deps = { tokenDf: () => ({ df: new Map([['我的', 99], ['这个', 80]]), docs }) }
  const cfg = { idfEnabled: true, idfMinDocs: 30, idfMaxDfRatio: 0.6 }
  const kept = pruneQueryEntities(['我的', '这个'], deps, cfg)
  assert.equal(kept.length, 1, `必须保留一个，实际 ${JSON.stringify(kept)}`)
  assert.equal(kept[0], '这个', '应保留 df 更小的那个')
})

test('§5.2：idfEnabled=false 时完全不剪（可关闭）', () => {
  const deps = { tokenDf: () => ({ df: new Map([['我的', 99]]), docs: 100 }) }
  const cfg = { idfEnabled: false, idfMinDocs: 30, idfMaxDfRatio: 0.6 }
  assert.deepEqual(pruneQueryEntities(['我的', 'pnpm'], deps, cfg), ['我的', 'pnpm'])
})

test('§5.2：词频表在新文档入库时累加，且只在新建时累加（合并不重复计数）', async () => {
  const h = await open()
  const before = h.memory.store.tokenDf(['pnpm']).docs
  await h.turn('我们用 pnpm 构建')
  const after1 = h.memory.store.tokenDf(['pnpm']).docs
  assert.ok(after1 > before, `docs 应增加：${before} → ${after1}`)

  const df1 = h.memory.store.tokenDf(['pnpm']).df.get('pnpm') ?? 0
  assert.ok(df1 >= 1, 'pnpm 的 df 应 ≥ 1')

  // 同一句话再说一遍会走合并路径，df 不该继续涨
  await h.turn('我们用 pnpm 构建')
  const df2 = h.memory.store.tokenDf(['pnpm']).df.get('pnpm') ?? 0
  assert.equal(df2, df1, `合并路径不该累加 df：${df1} → ${df2}`)
})

test('§5.2：剪枝不改变落盘向量（hashEmbedding 仍是纯函数）', async () => {
  const h = await open()
  await h.turn('我们用 pnpm 构建')
  const cells = h.memory.store.listCells({ limit: 50 })
  assert.ok(cells.length > 0)
  // 再召回一次（会走 IDF 剪枝），向量与 cellId 都不能变
  const snapshot = cells.map((c) => [c.cellId.toString(16), c.emb ? [...c.emb].join(',') : ''])
  h.memory.recall({ text: 'pnpm 构建', budget: 320, manual: true, readOnly: true })
  const after = h.memory.store.listCells({ limit: 50 }).map((c) => [c.cellId.toString(16), c.emb ? [...c.emb].join(',') : ''])
  assert.deepEqual(after, snapshot, '召回不该修改任何落盘向量或 cellId')
})

// ── M1 的另一半：库级身份码碰撞审计 ─────────────────────────────────

const space2 = new SdrSpace({ dim: 2048, k: 8 })

function mkRawCell(over = {}) {
  const slots = [
    { role: 1, type: 'LIT', value: '用户' },
    { role: 2, type: 'LIT', value: 'pnpm' },
    { role: 3, type: 'LIT', value: 'uses' },
  ]
  const sdr = space2.bundle(slots.map((s) => space2.bind(space2.identity('V:' + s.value), space2.role(String(s.role)))))
  const now = 1_800_000_000_000
  return {
    cellId: 0x1111n,
    kind: KIND.semantic,
    tier: 1,
    flags: 0,
    tFrom: BigInt(now),
    tTo: BigInt(now),
    tIngest: BigInt(now),
    tAccess: BigInt(now),
    accessCount: 1,
    stability: 7,
    importance: 0.5,
    valence: 0,
    arousal: 0,
    dominance: 0.5,
    salience: 0.5,
    provenance: 0,
    trust: 240,
    sdr,
    emb: hashEmbedding('用户用 pnpm', 64),
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

test('M1：doctor 在干净库上报告 0 碰撞，且不谎称跳过', async () => {
  const h = await open()
  await h.turn('我们用 pnpm 构建')
  await h.turn('字体用等宽')
  const d = h.memory.doctor()
  assert.equal(d.identityCollisions, 0, `干净库不该有碰撞，实际 ${d.identityCollisions}`)
  assert.equal(d.identityAuditSkipped, false, '小库不该跳过审计')
})

test('M1：doctor 真的能检出"同 SDR 但摘要不同"的碰撞（探测器不是恒真）', async () => {
  const h = await open()
  // 手工塞两条：SDR 完全相同（同一身份码），但摘要是两句不同的话
  h.memory.store.putCell(mkRawCell({ cellId: 0xaaa1n, digest: '用户用 pnpm' }))
  h.memory.store.putCell(mkRawCell({ cellId: 0xaaa2n, digest: '用户用 npm 构建前端' }))
  const d = h.memory.doctor()
  assert.equal(d.identityCollisions, 1, `应检出 1 对碰撞，实际 ${d.identityCollisions}`)
  assert.ok(
    d.issues.some((x) => x.includes('身份码碰撞')),
    `issue 里应有碰撞提示：${JSON.stringify(d.issues)}`,
  )
})

test('M1：SDR 相同且摘要相同（同一条记忆被合并）不算碰撞', async () => {
  const h = await open()
  h.memory.store.putCell(mkRawCell({ cellId: 0xbbb1n, digest: '用户用 pnpm' }))
  h.memory.store.putCell(mkRawCell({ cellId: 0xbbb2n, digest: '用户用 pnpm' }))
  const d = h.memory.doctor()
  assert.equal(d.identityCollisions, 0, '同摘要同 SDR 是重复项，不是碰撞')
})
