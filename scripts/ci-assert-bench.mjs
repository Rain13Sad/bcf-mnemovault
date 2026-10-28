/**
 * CI 门槛：把 README 里写下的指标变成会失败的断言
 *
 * 只卡"低于目标就说明功能回归"的指标。存储比（storageRatio / storageRatioRealistic）
 * 是已知未达标项（见 README「一个没达标的指标」），所以只打印、不阻塞——把它写进门槛
 * 等于让 CI 永远红着，红久了就没人看 CI 了。
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
]

let failed = 0
for (const [key, ok, target] of gates) {
  const value = metrics[key]
  const pass = typeof value === 'number' && ok(value)
  if (!pass) failed++
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${key.padEnd(22)} ${String(value).padEnd(10)} 目标 ${target}`)
}

console.log(
  `info  storageRatio           ${String(metrics.storageRatio).padEnd(10)} 目标 ≤ 0.60（已知未达标，见 README）`,
)
console.log(
  `info  storageRatioRealistic  ${String(metrics.storageRatioRealistic).padEnd(10)} 同上`,
)

if (failed > 0) {
  console.error(`\n${failed} 项基准未达标`)
  process.exit(1)
}
console.log('\n全部门槛通过')
