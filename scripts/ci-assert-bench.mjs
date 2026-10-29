/**
 * CI 门槛：把 README 里写下的指标变成会失败的断言
 *
 * 存储比从 v0.3 起**进门槛**了，但要按两个口径分别卡：
 *   · storageRatioRealistic —— 默认切分（约 2.25 条/轮），残差压缩 0.47 是硬下界，
 *     实测 0.84，门槛 0.90；
 *   · storageRatioCoarse —— 每轮一条 cell 的粗粒度口径，实测 0.68，门槛 0.72。
 * 之所以不卡 0.60：在 2 KB 轮次上，残差压缩（0.45）+ 一条 cell（0.17）已经是 0.62，
 * 0.60 低于算术下界。这条推导写在 README「存储比」一节，改了记得同步。
 *
 *   node scripts/ci-assert-bench.mjs
 */
import { readFileSync, existsSync } from 'node:fs'

const path = 'artifacts/bench.json'
if (!existsSync(path)) {
  console.error(`缺少 ${path}，先跑 \`npm run bench:eval\``)
  process.exit(1)
}

const { metrics } = JSON.parse(readFileSync(path, 'utf8'))

/** [指标, 判据, 目标描述] */
const gates = [
  ['recallAt8', (v) => v >= 0.8, '≥ 0.80'],
  ['mrr', (v) => v >= 0.6, '≥ 0.65（留 0.05 浮动，防随机种子漂移）'],
  ['dedupePrecision', (v) => v >= 0.85, '≥ 0.90（留 0.05 浮动）'],
  ['dedupeRecall', (v) => v >= 0.95, '= 1.00（留 0.05 浮动）'],
  ['timeReasoningAccuracy', (v) => v >= 0.75, '≥ 0.75'],
  ['tokensPerTurn', (v) => v <= 240, '≤ 240'],
  ['storageRatioRealistic', (v) => v <= 0.9, '≤ 0.90（默认切分，残差 0.47 为下界）'],
  ['storageRatioCoarse', (v) => v <= 0.72, '≤ 0.72（每轮一条 cell）'],
]

let failed = 0
for (const [key, ok, target] of gates) {
  const value = metrics[key]
  const pass = typeof value === 'number' && ok(value)
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${key.padEnd(22)} ${String(value).padEnd(10)} 目标 ${target}`)
}

console.log(
  `info  storageRatio           ${String(metrics.storageRatio).padEnd(10)} 短轮次库：定长基底主导，只作诊断口径`,
)
console.log(
  `info  storageBreakEvenChars  ${String(metrics.storageBreakEvenChars).padEnd(10)} 存储比降到 1.0× 所需轮次字数`,
)

if (failed > 0) {
  console.error(`\n${failed} 项基准未达标`)
  process.exit(1)
}
console.log('\n全部门槛通过')
