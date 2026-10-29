/**
 * 微基准：验证 §6.4 "易计算" 的那条要求——Jaccard 256 B ≈ 3×32×u64 popcount，微基准 < 80ns。
 *
 *   node scripts/bench.mjs
 *
 * 数字只在一台机器上有意义，所以这里输出的是**分布**（p50/p95），不是单个最好成绩。
 *
 * ⚠ **口径警告**：这个脚本用的是 `MemoryStore`（纯内存 Map），
 * **完全绕开 SQLite**。所以它的 recall 延迟只反映算子与打分逻辑，
 * 不代表真实部署路径。审查实测过两者的差距：v0.3 时同一规模下
 * MemoryStore 5 ms vs 真实 SQLite 213 ms（43 倍）。
 * 要看真实路径请用 `node scripts/bench-scale.mjs`（会打印驱动名）。
 */
import { SdrSpace } from '../packages/core/lib/sdr.js'
import { runRecall, hashEmbedding } from '../packages/core/lib/recall.js'
import { MemoryStore } from '../packages/core/lib/store.js'
import { defaultConfig } from '../packages/core/lib/index.js'
import { encodeCell } from '../packages/core/lib/cell.js'

const space = new SdrSpace({ dim: 2048, k: 8 })
const N = 200_000
const a = space.identity('用户')
const b = space.identity('服务器')

function bench(name, fn, iters = N) {
  for (let i = 0; i < 5000; i++) fn() // warmup
  const samples = []
  const batch = 1000
  for (let i = 0; i < iters / batch; i++) {
    const t0 = process.hrtime.bigint()
    for (let j = 0; j < batch; j++) fn()
    const dt = Number(process.hrtime.bigint() - t0) / batch
    samples.push(dt)
  }
  samples.sort((x, y) => x - y)
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  console.log(`  ${name.padEnd(22)} p50 ${p50.toFixed(0).padStart(5)} ns   p95 ${p95.toFixed(0).padStart(5)} ns`)
  return p50
}

console.log('\n[算子微基准]（目标：Jaccard < 80ns）')
bench('popcount', () => space.popcount(a))
bench('jaccard', () => space.sim(a, b))
bench('containment', () => space.containment(a, b))
bench('permute (bind)', () => space.permute(a, space.role('AGENT')), 20_000)
bench('bundle(6)', () => space.bundle([a, b, a, b, a, b]), 50_000)

console.log('\n[编码/召回端到端]')
const store = new MemoryStore(space)
const config = defaultConfig()
const t0 = Date.now()
for (let i = 0; i < 2000; i++) {
  const slots = [
    { role: 1, type: 'LIT', value: '用户' },
    { role: 2, type: 'LIT', value: `ent.${i % 97}` },
    { role: 3, type: 'LIT', value: 'uses' },
  ]
  const sdr = space.bundle(slots.map((s) => space.bind(space.identity('V:' + s.value), space.role(String(s.role)))))
  const now = BigInt(Date.now())
  store.putCell({
    cellId: BigInt(i + 1),
    kind: 1,
    tier: 1,
    flags: 0,
    tFrom: now,
    tTo: now,
    tIngest: now,
    tAccess: now,
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
    emb: hashEmbedding(`实体 ${i % 97} 用法`, 256),
    slots,
    edges: [],
    residual: null,
    confidence: 0.8,
    support: 1,
    topic: `t${i % 97}`,
    digest: `实体 ${i % 97} 用法`,
  })
}
console.log(`  装载 2000 cell        ${Date.now() - t0} ms`)

const lat = []
for (let i = 0; i < 50; i++) {
  const s = Date.now()
  runRecall({ space, store, config }, { text: `实体 ${i % 97} 的用法`, budget: 320 })
  lat.push(Date.now() - s)
}
lat.sort((x, y) => x - y)
console.log(`  recall @2000 cells    p50 ${lat[25]} ms   p95 ${lat[47]} ms   [驱动 MemoryStore，非 SQLite]`)

const cell = store.listCells({ limit: 1 })[0]
const tEnc = process.hrtime.bigint()
for (let i = 0; i < 10_000; i++) encodeCell(cell)
console.log(`  encodeCell             ${(Number(process.hrtime.bigint() - tEnc) / 10_000).toFixed(0)} ns/cell（${encodeCell(cell).length} B）`)

console.log('\n注：数字只在当前机器有意义。设计目标见文档 §18.1（recall p95 ≤ 40ms @ 100 万 cell）。')
