/**
 * 规模基准：**真实 SQLite 路径**下的写入与检索延迟。
 *
 * 与 `bench.mjs` 的区别：那个用 `MemoryStore`（纯内存 Map），只测算子；
 * 这个走 `SqliteStore`（node:sqlite + WAL + blob + 列），测的是部署时真正跑的那条路。
 * 两者在 v0.3 时相差 43 倍，所以数字必须分开报。
 *
 *   node scripts/bench-scale.mjs            # 默认 200 / 500 / 1000
 *   node scripts/bench-scale.mjs 2000       # 单档
 *
 * 输出既打印也写进 `artifacts/bench-scale.json`，供 README 与 CI 引用。
 */
import { createHarness } from '@rain13sad/dsh-mnemo-devkit'
import { writeFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const TIERS = args.length ? args.map(Number) : [200, 500, 1000]

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
}

const rows = []
for (const n of TIERS) {
  const h = await createHarness({ sessionId: `scale-${n}` })
  const t0 = Date.now()
  for (let i = 0; i < n; i++) {
    await h.turn(`第 ${i} 条：我们决定模块 ${i % 97} 用方案 ${i % 13}，以后按这个来。`)
  }
  const loadMs = Date.now() - t0

  const lat = []
  for (let i = 0; i < 30; i++) {
    const t = Date.now()
    h.memory.recall({ text: `模块 ${i % 97} 现在是什么`, budget: 320, manual: true })
    lat.push(Date.now() - t)
  }

  let scanned = 0
  const t2 = Date.now()
  h.memory.store.forEachCell(() => scanned++)
  const scanMs = Date.now() - t2

  rows.push({
    cells: h.memory.store.countCells(),
    driver: h.memory.store.kind,
    loadSec: Number((loadMs / 1000).toFixed(1)),
    writeMsPerCell: Number((loadMs / Math.max(1, n)).toFixed(1)),
    recallP50Ms: pct(lat, 0.5),
    recallP95Ms: pct(lat, 0.95),
    forEachCellMs: scanMs,
  })
  await h.dispose()
}

console.log('\nMnemoVault scale bench（真实 SQLite 路径）\n' + '─'.repeat(64))
console.log('  cells  driver   load(s)  write(ms/cell)  recall p50  recall p95  forEachCell')
for (const r of rows) {
  console.log(
    `  ${String(r.cells).padStart(5)}  ${r.driver.padEnd(7)}  ${String(r.loadSec).padStart(6)}  ${String(r.writeMsPerCell).padStart(13)}  ${String(r.recallP50Ms).padStart(9)}ms ${String(r.recallP95Ms).padStart(9)}ms ${String(r.forEachCellMs).padStart(9)}ms`,
  )
}
console.log('─'.repeat(64))
console.log('  说明：写入仍是 O(n)（去重 + 冲突检测各一次全扫），v0.3.1 只削掉了常数因子；')
console.log('        下一步是 SDR 倒排索引（把两次全扫变成 posting 交集）。')

mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/bench-scale.json', JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2), 'utf8')
console.log('report → artifacts/bench-scale.json')
process.exit(0)
