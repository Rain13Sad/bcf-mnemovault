/**
 * 规模基准：**真实 SQLite 路径**下的写入与检索延迟（v0.5.2 重写）。
 *
 * 与 `bench.mjs` 的区别：那个用 `MemoryStore`（纯内存 Map），只测算子；
 * 这个走 `SqliteStore`（node:sqlite + WAL + blob + 列），测的是部署时真正跑的那条路。
 * 两者在 v0.3 时相差 43 倍，所以数字必须分开报。
 *
 * ── v0.5.2 新增的三种测法 ────────────────────────────────────────
 * ① **走真实 ingest 的渐进档**（默认 200/500/1000）：测"每轮耗时随规模怎么变"，
 *    也就是 §0 那条 O(T²) 曲线的原始数据。
 * ② **合成语料档**（`--corpus 10000`）：测大库上的延迟。语料由 `gen-corpus.mjs`
 *    批量 putCell 造出来，**不是真实对话长出来的**（没有残差、没有真实访问分布），
 *    所以它只回答"多快"，不回答"准不准"。这个口径写进 JSON 与 README。
 * ③ **倒排索引效果对照**（`--ab`）：同一个语料下开关索引各测一次，
 *    得到剪枝比与吞吐提升倍数——这是 D4/D5 的验收数字。
 *
 *   node scripts/bench-scale.mjs                     # 渐进档 200/500/1000
 *   node scripts/bench-scale.mjs 2000                # 单档
 *   node scripts/bench-scale.mjs --corpus 10000      # 合成语料 1 万
 *   node scripts/bench-scale.mjs --corpus 10000 --ab # 语料 + 索引开关对照
 *
 * 输出既打印也写进 `artifacts/bench-scale.json`，供 README 与 CI 引用。
 */
import { createHarness } from '@rain13sad/dsh-mnemo-devkit'
import { generateCorpus } from './gen-corpus.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('-'))
const args = argv.filter((a) => !a.startsWith('-'))
const corpusArg = argv.find((a) => a.startsWith('--corpus='))?.slice(9)
const corpusSize = corpusArg ? Number(corpusArg) : flags.includes('--corpus') ? Number(args[0] ?? 10000) : null
const doAB = flags.includes('--ab')

function pct(xs, p) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0
}

function med(xs) {
  return pct(xs, 0.5)
}

const rows = []

// ── ① 渐进档：走真实 ingest ────────────────────────────────────────
if (corpusSize === null) {
  const TIERS = args.length ? args.map(Number) : [200, 500, 1000]
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
      h.memory.recall({ text: `模块 ${i % 97} 现在是什么`, budget: 320, manual: true, readOnly: true })
      lat.push(Date.now() - t)
    }

    // 单次 ingest 的稳态耗时（已含索引维护）
    const ingestLat = []
    for (let i = 0; i < 20; i++) {
      const t = process.hrtime.bigint()
      await h.turn(`补充说明 ${i}：模块 ${i} 继续用方案 ${i % 13}。`)
      ingestLat.push(Number(process.hrtime.bigint() - t) / 1e6)
    }

    const tDemote = Date.now()
    h.memory.demoteDue()
    const demoteMs = Date.now() - tDemote

    const tPanel = Date.now()
    h.memory.panelSnapshot()
    const panelMs = Date.now() - tPanel

    const idx = h.memory.indexInfo()
    rows.push({
      mode: 'ingest',
      cells: h.memory.store.countCells(),
      driver: h.memory.store.kind,
      loadSec: Number((loadMs / 1000).toFixed(1)),
      turnMs: Number((loadMs / Math.max(1, n)).toFixed(2)),
      recallP50Ms: pct(lat, 0.5),
      recallP95Ms: pct(lat, 0.95),
      ingestP50Ms: Number(med(ingestLat).toFixed(2)),
      demoteMs,
      panelMs,
      indexCells: idx.cells,
      indexBytes: idx.bytes,
      indexBuildMs: idx.buildMs,
    })
    await h.dispose()
  }
} else {
  // ── ②③ 合成语料档 ────────────────────────────────────────────────
  const dbPath = join(tmpdir(), `mnemo-corpus-${corpusSize}.db`)
  const gen = await generateCorpus({ cells: corpusSize, dbPath })
  const variants = doAB ? [true, false] : [true]

  for (const sdrEnabled of variants) {
    const h = await createHarness({
      sessionId: 'corpus',
      config: { dbPath, index: { sdrEnabled, sdrMaxCells: 200_000, demoteBatch: 2000, retentionTtlMs: 6 * 3600_000 } },
    })

    // 预热索引（首次用到时懒建），并记录构建耗时
    const tIdx = Date.now()
    h.memory.sdrCandidates(h.memory.store.listCells({ limit: 1 })[0].sdr, 3)
    const indexBuildMs = Date.now() - tIdx
    const idx = h.memory.indexInfo()

    const lat = []
    for (let i = 0; i < 60; i++) {
      const t = process.hrtime.bigint()
      h.memory.recall({ text: `我们决定 ${['pnpm', 'bun', 'vite', 'sqlite'][i % 4]} 用哪个方案`, budget: 400, manual: true, readOnly: true })
      lat.push(Number(process.hrtime.bigint() - t) / 1e6)
    }

    // 写入吞吐：在语料库上继续 ingest 20 轮（测的是 O(n) 有没有被削掉）
    const ingestLat = []
    for (let i = 0; i < 20; i++) {
      const t = process.hrtime.bigint()
      await h.turn(`新决定 ${i}：模块 ${i} 改用方案 ${(i * 7) % 13}，以后按这个来。`)
      ingestLat.push(Number(process.hrtime.bigint() - t) / 1e6)
    }

    const tDemote = Date.now()
    h.memory.demoteDue()
    const demoteMs = Date.now() - tDemote

    const tPanel = Date.now()
    h.memory.panelSnapshot()
    const panelMs = Date.now() - tPanel

    rows.push({
      mode: 'corpus',
      corpus: gen.cells,
      corpusEdges: gen.edges,
      corpusBuildMs: gen.buildMs,
      sdrIndex: sdrEnabled,
      indexCells: idx.cells,
      indexBytes: idx.bytes,
      indexBuildMs,
      cells: h.memory.store.countCells(),
      recallP50Ms: Number(med(lat).toFixed(2)),
      recallP95Ms: Number(pct(lat, 0.95).toFixed(2)),
      ingestP50Ms: Number(med(ingestLat).toFixed(2)),
      demoteMs,
      panelMs,
      caveat: gen.caveat,
    })
    await h.dispose()
  }
}

// ── 输出 ────────────────────────────────────────────────────────────
console.log('\nMnemoVault scale bench（真实 SQLite 路径）\n' + '─'.repeat(78))
if (corpusSize === null) {
  console.log('  cells  turn(ms)  recall p50  recall p95  ingest p50  demote  panel  索引')
  for (const r of rows) {
    console.log(
      `  ${String(r.cells).padStart(5)}  ${String(r.turnMs).padStart(8)}  ${String(r.recallP50Ms).padStart(10)}ms ${String(
        r.recallP95Ms,
      ).padStart(10)}ms ${String(r.ingestP50Ms).padStart(10)}ms ${String(r.demoteMs).padStart(6)}ms ${String(r.panelMs).padStart(5)}ms  ${r.indexCells} 条 / ${Math.round(
        r.indexBytes / 1024,
      )} KB（建 ${r.indexBuildMs}ms）`,
    )
  }
  console.log('─'.repeat(78))
  console.log('  说明：turn(ms) 是"从零造到第 n 条"的平均每轮耗时——它随 n 增长说明写入仍与规模相关。')
  console.log('        ingest p50 是**稳态**单轮耗时（库已建好），这才是索引要压的那个数。')
} else {
  console.log('  语料 cells  索引   recall p50  recall p95  ingest p50  demote  panel  索引内存')
  for (const r of rows) {
    console.log(
      `  ${String(r.corpus).padStart(10)}  ${String(r.sdrIndex ? 'on ' : 'off').padStart(4)}  ${String(r.recallP50Ms).padStart(10)}ms ${String(
        r.recallP95Ms,
      ).padStart(10)}ms ${String(r.ingestP50Ms).padStart(10)}ms ${String(r.demoteMs).padStart(6)}ms ${String(r.panelMs).padStart(5)}ms  ${Math.round(
        r.indexBytes / 1024,
      )} KB`,
    )
  }
  console.log('─'.repeat(78))
  console.log('  口径：合成语料（批量 putCell + 合成边，无残差、访问历史均匀）。')
  console.log('        它只回答"多快"，不回答"准不准"——Recall 数字不能与真实库比较。')
}

mkdirSync('artifacts', { recursive: true })
writeFileSync(
  'artifacts/bench-scale.json',
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      mode: corpusSize === null ? 'ingest-progression' : 'synthetic-corpus',
      caveat:
        corpusSize === null
          ? null
          : '合成语料：批量 putCell + 合成边，无残差、访问历史均匀。仅用于延迟/吞吐，Recall 不可与真实库比较。',
      rows,
    },
    null,
    2,
  ),
  'utf8',
)
console.log('report → artifacts/bench-scale.json')
process.exit(0)
