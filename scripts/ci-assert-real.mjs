/**
 * 真实语料门槛（v0.7.0）
 *
 * 与 `ci-assert-bench.mjs` 分工：
 *   · 那个守**合成集**（Recall@8 / MRR / 去重 / 存储比）——参数一调，数字变了就看得见；
 *   · 这个守**手写语料**（单跳 / 改口 / 多跳 / 陷阱 / 情感）——它才反映"真人怎么问"。
 *
 * 阈值刻意留余量：手写语料只有 12 条 query，样本小，卡太紧会被随机波动打红。
 * 但 **trap 与 update 必须是 1.00**：前者是抗幻觉底线，后者是改口正确性——
 * 这两类错一次就足以让用户不再信任这个记忆系统。
 */
import { readFileSync } from 'node:fs'

const raw = readFileSync('artifacts/bench-real.json', 'utf8')
const r = JSON.parse(raw)
const acc = r.accuracy ?? {}
let bad = 0
const check = (name, actual, ok, want) => {
  if (ok) console.log(`ok    ${name.padEnd(22)} ${actual}      目标 ${want}`)
  else {
    console.log(`FAIL  ${name.padEnd(22)} ${actual}      目标 ${want}`)
    bad++
  }
}

console.log(`\n真实语料门槛（${r.queries} 条 query / ${r.cases} 段对话）`)
console.log('─'.repeat(64))
check('overall', acc.overall, acc.overall >= 0.8, '≥ 0.80')
check('single（单跳）', acc.single ?? 0, (acc.single ?? 0) >= 0.7, '≥ 0.70')
check('update（改口）', acc.update ?? 0, (acc.update ?? 0) === 1, '= 1.00')
check('trap（陷阱弃权）', acc.trap ?? 0, (acc.trap ?? 0) === 1, '= 1.00')
check('multi（多跳）', acc.multi ?? 0, (acc.multi ?? 0) >= 0.6, '≥ 0.60')
check('affect（情感）', acc.affect ?? 0, (acc.affect ?? 0) >= 0.8, '≥ 0.80')
console.log('─'.repeat(64))

if (bad > 0) {
  console.log(`\n${bad} 项未达标。失败用例：`)
  for (const x of r.results.filter((y) => !y.ok)) console.log(`  · [${x.kind}] ${x.q}（${x.note}）`)
  process.exit(1)
}
console.log('\n真实语料门槛全部通过\n')
