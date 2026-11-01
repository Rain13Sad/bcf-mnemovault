/**
 * 规模门槛（v0.5.2）。
 *
 * ── 为什么单独一个脚本 ────────────────────────────────────────────
 * `ci-assert-bench.mjs` 校验的是**质量**（Recall/MRR/存储比），跑在 `bench.mjs` 的
 * 300 轮语料上。规模是另一回事：它要一份**大库**，造库本身有成本，
 * 混在一起会让"质量门槛"变成"跑十分钟"。
 *
 * ── 这个门槛验的是什么 ────────────────────────────────────────────
 * 1 万 cell 合成语料下 `recall p95 ≤ 60 ms`（v0.6 起，口径见下方注释）——这正是 README 一直写着、
 * 而 CI 里**从来没有断言过**的那个数（D25）。合成语料只测延迟，
 * 所以这里只卡延迟，不卡 Recall（Recall 由 bench:eval 卡）。
 *
 *   node scripts/ci-assert-scale.mjs                 # 跑 1 万档并校验
 *   node scripts/ci-assert-scale.mjs --from-report   # 只读 artifacts/bench-scale.json
 */
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const fromReport = process.argv.includes('--from-report')
const CELLS = 10_000
/**
 * v0.6：40 → 60。
 *
 * 不是"允许它变慢"，而是**这一档测的东西变了**：
 *   · v0.5.2：`annThreshold=2000`，1 万 cell 走 HNSW，候选池只有 ~128 条
 *   · v0.6：`annThreshold=20000`，1 万 cell 走**精确扫描**，候选池 6000+ 条
 * 实测同一台机器上两种口径：HNSW p50 37 ms / 精确扫描 p50 11–38 ms（取决于进程堆状态），
 * p95 都在 47–55 ms。也就是说 v0.5.2 的 25 ms 是"近似索引 + 更小候选池"的读数，
 * 与现在的读数不可直接比。
 *
 * 这条门槛真正要挡的是**O(n) 爆炸**（v0.5.1 之前是 226 ms）。60 ms 仍然能挡住它。
 * 口径变更写在 CHANGELOG 首段，不静默调。
 */
const P95_BUDGET_MS = 60

if (!fromReport) {
  const r = spawnSync(process.execPath, ['scripts/bench-scale.mjs', '--corpus', String(CELLS)], {
    encoding: 'utf8',
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error('✗ 规模基准本身失败')
    process.exit(1)
  }
}

if (!existsSync('artifacts/bench-scale.json')) {
  console.error('✗ 找不到 artifacts/bench-scale.json')
  process.exit(1)
}
const report = JSON.parse(readFileSync('artifacts/bench-scale.json', 'utf8'))
const row = (report.rows ?? []).find((x) => x.mode === 'corpus' && x.sdrIndex !== false)
if (!row) {
  console.error('✗ 报告里没有合成语料行')
  process.exit(1)
}

const checks = []
const must = (name, ok, detail) => checks.push({ name, ok, detail })

must(
  `${row.corpus} cell · recall p95 ≤ ${P95_BUDGET_MS} ms`,
  row.recallP95Ms <= P95_BUDGET_MS,
  `${row.recallP95Ms} ms`,
)
// 索引必须在预算内建立（否则"开索引"这件事本身就成了新的启动负担）
must('索引构建 ≤ 3000 ms', row.indexBuildMs <= 3000, `${row.indexBuildMs} ms`)
// 索引内存要可解释：10 万 cell 的预算是 32 MB，1 万档应在 4 MB 以内
must('索引内存 ≤ 4096 KB', row.indexBytes / 1024 <= 4096, `${Math.round(row.indexBytes / 1024)} KB`)

let failed = 0
for (const c of checks) {
  if (c.ok) console.log(`ok    ${c.name}  (${c.detail})`)
  else {
    console.log(`FAIL  ${c.name}  (${c.detail})`)
    failed++
  }
}
if (failed) {
  console.error(`\n${failed} 项规模门槛未过`)
  process.exit(1)
}
console.log('\n规模门槛全部通过')
