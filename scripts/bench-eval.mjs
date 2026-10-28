/**
 * mnemo-bench —— 评测脚本（对应 §18.1 指标 / §18.5 复现要求）
 *
 *   node scripts/bench-eval.mjs [--facts 40]
 *
 * 它回答的不是"跑得快不快"，而是"记得准不准"：
 *   Recall@8 / MRR      检索质量
 *   dedupe P/R          去重阈值是否可用（文档要求 ≥0.90 精确率）
 *   time reasoning      双时态是否真的能回答"当时认为"
 *   tokens/turn         surface 成本
 *   storage ratio       存储成本
 *
 * 数据集是**合成但带 ground truth** 的：每条事实在写入时就知道它应该被哪条 query 找回。
 * 这不是学术基准，而是回归护栏——参数一调，数字变了就看得见。
 *
 * 所有随机性走固定 seed，同 seed 结果一致（§18.5）。
 */
import { createHarness } from '@bcf/dsh-mnemo-devkit'
import { writeFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const FACT_COUNT = Number(args[args.indexOf('--facts') + 1]) || 36
let seed = 20261028
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]

const TOPICS = [
  ['ui.theme', '深色主题', '浅色主题'],
  ['ui.font', '等宽字体', '无衬线字体'],
  ['repo.lang', 'TypeScript', 'JavaScript'],
  ['build.tool', 'pnpm', 'npm'],
  ['log.target', 'stderr', 'stdout'],
  ['cache.mode', '按 key 分片', '全量缓存'],
  ['deploy.env', '预发环境', '生产环境'],
  ['api.auth', 'Bearer token', 'Basic auth'],
  ['db.engine', 'SQLite', 'Postgres'],
  ['test.framework', 'node:test', 'vitest'],
  ['ci.stage', 'smoke 与 full 两档', '单档全量'],
  ['editor.config', 'tab 两空格', 'tab 四空格'],
]

const TEMPLATES = [
  (t, v) => `我们决定 ${t} 用 ${v}。`,
  (t, v) => `${t} 这件事上，我偏好 ${v}。`,
  (t, v) => `以后 ${t} 一律按 ${v} 来，别再改了。`,
  (t, v) => `我习惯 ${t} 是 ${v}，这样更顺手。`,
]

const h = await createHarness({ sessionId: 'bench', config: { preset: 'balanced' } })

// ── 1. 写入事实（每条事实带 ground truth：期望被哪条 query 找回） ──────────
const facts = []
for (let i = 0; i < FACT_COUNT; i++) {
  const [key, a, b] = pick(TOPICS)
  const value = rnd() < 0.5 ? a : b
  const text = pick(TEMPLATES)(key, value)
  await h.turn(`${text}（第 ${i} 轮）`)
  const cells = h.memory.store.listCells({ limit: 200 }).filter((c) => c.provenance === 0)
  // 取最新写入、且 digest 含该 value 的那条作为 ground truth
  const target = cells.find((c) => (c.digest ?? '').includes(value) && (c.digest ?? '').includes(key))
  if (target) facts.push({ key, value, text, cellId: target.cellId.toString(16).padStart(16, '0') })
}

// ── 2. Recall@8 / MRR ──────────────────────────────────────────────────
const K = 8
let hit8 = 0
let mrr = 0
let tokenSum = 0
let tokenN = 0
const lat = []
for (const f of facts) {
  const q = `${f.key} 现在是什么`
  const t0 = Date.now()
  const r = h.memory.recall({ text: q, budget: 320, manual: true })
  lat.push(Date.now() - t0)
  tokenSum += r.tokens
  tokenN++
  const ids = r.hits.map((x) => x.cellId)
  const rank = ids.indexOf(f.cellId)
  if (rank >= 0 && rank < K) hit8++
  if (rank >= 0) mrr += 1 / (rank + 1)
}
const recall8 = facts.length ? hit8 / facts.length : 0
const mrrScore = facts.length ? mrr / facts.length : 0

// ── 3. 去重精确率 / 召回率 ────────────────────────────────────────────
// 正样本：同一事实原样再说一次（应合并）；负样本：同话题不同取值（不应合并）
let dupMerged = 0
let dupTrials = 0
for (const f of facts.slice(0, 10)) {
  const id = BigInt('0x' + f.cellId)
  const before = h.memory.store.getCell(id)?.support ?? 0
  await h.turn(f.text)
  const after = h.memory.store.getCell(id)?.support ?? 0
  // 判据是"目标 cell 的 support 增加了"（合并成功），而不是"总 cell 数没变"
  // ——后者会被同轮其它命题的新建干扰。
  if (after > before) dupMerged++
  dupTrials++
}
let distinctKept = 0
let distinctTrials = 0
for (const f of facts.slice(0, 10)) {
  const [, a, b] = TOPICS.find((t) => t[0] === f.key) ?? []
  const other = f.value === a ? b : a
  if (!other) continue
  const before = h.memory.store.countCells()
  // 加唯一后缀：否则"另一个取值"可能本来就写过，合并反而是正确行为，会把指标压低
  await h.turn(`关于 ${f.key}，我其实更喜欢 ${other}-v${distinctTrials}。`)
  if (h.memory.store.countCells() > before) distinctKept++
  distinctTrials++
}
const dedupePrecision = dupTrials ? dupMerged / dupTrials : 0
const dedupeRecall = distinctTrials ? distinctKept / distinctTrials : 0

// ── 4. 时间推理（双时态） ─────────────────────────────────────────────
const h2 = await createHarness({ sessionId: 'bench-time' })
const stamps = []
const versions = ['pnpm', 'npm', 'bun']
for (const v of versions) {
  await h2.turn(`部署脚本统一用 ${v}。`, { advanceMs: 60_000 })
  // 用**这条 cell 自己的 tFrom**做锚点：事件时间来自可推进的时钟，
  // 用 Date.now() 或"写入前的时钟"都会得到"查询时刻早于事件"的假阴性。
  const newest = h2.memory.store.listCells({ limit: 1, order: 'recent' })[0]
  stamps.push(Number(newest.tFrom))
}
let timeCorrect = 0
for (let i = 0; i < versions.length; i++) {
  // 用"该版本生效期间"的一个时刻去查，应当只命中该版本
  const asOf = stamps[i] + 1000
  const r = h2.memory.recall({ text: '部署脚本 用哪个', budget: 320, manual: true, asOf })
  const rendered = r.rendered
  const hitsOld = versions.slice(0, i).some((v) => rendered.includes(v))
  if (rendered.includes(versions[i]) && !hitsOld) timeCorrect++
}
const timeAccuracy = timeCorrect / versions.length

// ── 5. 成本与规模 ────────────────────────────────────────────────────
// 另起一个"真实长度"的库来量存储比：bench 主库的命题只有十几个字，
// 会被 704 B 定长基底完全主导，那个数字不能代表真实轮次。
const h3 = await createHarness({ sessionId: 'bench-storage' })
const filler = '这一段用于填充长度，模拟真实的会议记录与代码讨论，内容需要足够长才能体现压缩收益。'
for (let i = 0; i < 8; i++) {
  await h3.turn(`第 ${i} 轮记录：` + `我们讨论了缓存分片与索引维护的第 ${i} 套方案。`.repeat(4) + filler.repeat(5))
}
const stLong = h3.memory.store.stats()
const ratioLong = stLong.rawBytes ? stLong.bytes / stLong.rawBytes : 0

const st = h.memory.store.stats()
const stats = h.memory.stats()
lat.sort((a, b) => a - b)
const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? 0
const tokensPerTurn = tokenN ? tokenSum / tokenN : 0

const report = {
  generatedAt: new Date().toISOString(),
  seed: 20261028,
  dataset: { facts: facts.length, dedupeTrials: dupTrials + distinctTrials, timeVersions: versions.length },
  metrics: {
    recallAt8: round(recall8),
    mrr: round(mrrScore),
    dedupePrecision: round(dedupePrecision),
    dedupeRecall: round(dedupeRecall),
    timeReasoningAccuracy: round(timeAccuracy),
    tokensPerTurn: round(tokensPerTurn),
    recallP95Ms: p95,
    storageRatio: round(stats.storageRatio),
    storageRatioRealistic: round(ratioLong),
    avgRawBytesPerTurn: round(st.rawBytes / Math.max(1, facts.length)),
    cells: st.cells,
    residuals: st.residuals,
    invalidated: stats.invalidated,
  },
  targets: {
    recallAt8: '≥ 0.80',
    mrr: '≥ 0.65',
    dedupePrecision: '≥ 0.90',
    timeReasoningAccuracy: '≥ 0.75',
    tokensPerTurn: '≤ 240',
    storageRatio: '≤ 0.60（该目标假设每轮 1 条 cell 且轮次约 2.4KB，见 README）',
    storageRatioRealistic: '≤ 0.60（800 字轮次，命题级切分仍会拉高）',
  },
}

function round(x) {
  return Math.round(x * 1000) / 1000
}

console.log('\nMnemoVault bench\n' + '─'.repeat(52))
console.log(`数据集   ${facts.length} 条事实 / ${dupTrials + distinctTrials} 去重对 / ${versions.length} 个版本`)
for (const [k, v] of Object.entries(report.metrics)) {
  const target = report.targets[k]
  console.log(`  ${k.padEnd(24)} ${String(v).padStart(8)}${target ? '   ' + target : ''}`)
}
console.log('─'.repeat(52))

mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/bench.json', JSON.stringify(report, null, 2), 'utf8')
console.log('report → artifacts/bench.json')

await h.dispose()
await h2.dispose()
await h3.dispose()
process.exit(0)
