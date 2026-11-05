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
import { createHarness } from '@rain13sad/llm-mnemo-devkit'
import { writeFileSync, mkdirSync } from 'node:fs'
import { calibrationOf, countWith } from '@rain13sad/llm-mnemo'

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
  ['lint.rule', '严格模式', '宽松模式'],
  ['router.mode', 'history 模式', 'hash 模式'],
  ['state.store', 'Zustand', 'Redux'],
  ['style.sys', 'CSS 变量', 'Tailwind'],
  ['http.client', 'fetch', 'axios'],
  ['pkg.manager', 'pnpm workspace', 'npm workspaces'],
  ['i18n.mode', '按需加载', '全量打包'],
  ['monitor.tool', 'Sentry', '自建上报'],
  ['backup.mode', '每日增量', '每周全量'],
  ['auth.session', 'JWT 短时', 'Cookie 长时'],
  ['docs.tool', 'VitePress', 'Docusaurus'],
  ['queue.mode', '内存队列', 'Redis 队列'],
]

const TEMPLATES = [
  (t, v) => `我们决定 ${t} 用 ${v}。`,
  (t, v) => `${t} 这件事上，我偏好 ${v}。`,
  (t, v) => `以后 ${t} 一律按 ${v} 来，别再改了。`,
  (t, v) => `我习惯 ${t} 是 ${v}，这样更顺手。`,
]

const h = await createHarness({ sessionId: 'bench', config: { preset: 'balanced' } })

// ── 1. 写入事实（每条事实带 ground truth：期望被哪条 query 找回） ──────────
/** key → 最后一次写入的**原句**（dedupe 要回放原句，不能回放 digest） */
const lastText = new Map()
for (let i = 0; i < FACT_COUNT; i++) {
  const [key, a, b] = pick(TOPICS)
  const value = rnd() < 0.5 ? a : b
  const text = pick(TEMPLATES)(key, value)
  await h.turn(`${text}（第 ${i} 轮）`)
  lastText.set(key, text)
}

/**
 * ── ground truth：每个 key 的**当前值**（v0.7.0 修正口径）──────────────
 *
 * 旧口径是"每写一条事实就记一条真值，最后期望 36 条全部召回"。
 * 但 36 条事实只落在 12 个 key 上，同一个 key 被写了 3 次不同取值——
 * 而系统的语义是**后写取代先写**（SUPERSEDES + tInvalid），
 * 旧值本来就不该出现在"现在是什么"的答案里。
 *
 * 于是旧口径在惩罚正确行为：改口越准，recall 越低。
 * 现在改成按 key 取当前有效的那条：既符合"现在是什么"这个问法，
 * 也顺带把审计 C1（三阶段改口后答不出当前值）变成一条可回归的指标。
 */
const facts = []
{
  const slotHas = (c, needle) => c.slots.some((s) => s.type === 'LIT' && s.value === needle)
  const all = h.memory.store.listCells({ limit: 500 }).filter((c) => c.provenance === 0)
  const byKey = new Map()
  for (const c of all) {
    for (const [key] of TOPICS) {
      if (!slotHas(c, key)) continue
      const prev = byKey.get(key)
      // 当前有效（tInvalid=0）里最新的那条
      if (Number(c.tInvalid ?? 0) !== 0) continue
      if (!prev || Number(c.tFrom) > Number(prev.tFrom)) byKey.set(key, c)
    }
  }
  for (const [key, c] of byKey) {
    const value = c.slots.find((s) => s.role === 2)?.value ?? ''
    /**
     * 同一事实可能有多条 cell（不同句式 → PRED 不同 → `sameSlots` 判否 → 不合并）。
     * 它们**都持有同一条事实**，召回任意一条都算答对——
     * 只认某一条特定 id 会把"排第 2 但其实也对"记成失败。
     */
    const cellIds = all
      .filter((x) => Number(x.tInvalid ?? 0) === 0 && slotHas(x, key) && slotHas(x, value))
      .map((x) => x.cellId.toString(16).padStart(16, '0'))
    /**
     * dedupe 阶段要回放**原句**，不能回放 digest。
     *
     * digest 是归一后的结构化摘要（谓词已被映射成 `uses`），
     * 回放它得到的槽位与原始 cell 不完全相同（PRED 从 `decides` 变 `uses`），
     * `sameSlots` 判否 → 不合并 → 指标被"摘要格式"而不是"去重能力"决定。
     */
    facts.push({
      key,
      value,
      text: lastText.get(key) ?? c.digest ?? '',
      cellIds: cellIds.length ? cellIds : [c.cellId.toString(16).padStart(16, '0')],
      cellId: c.cellId.toString(16).padStart(16, '0'),
    })
  }
}

// ── 2. Recall@8 / MRR ──────────────────────────────────────────────────
const K = 8
let hit8 = 0
let mrr = 0
let tokenSum = 0
/**
 * 校准口径的 token 数（v0.6.1）。
 *
 * `r.tokens` 是 core 的**启发式上界**：CJK 每字按 1 token 估，
 * 而真实 tokenizer 是 0.65–0.88 token/字。实测中文样本高估约 45%，
 * 于是"预算利用率"只有 79%——白扔约 2 条记忆的容量。
 *
 * 这一版**不改运行时行为**（改它会让召回条数变化，属于独立议题），
 * 但把真实口径也报出来：README 不该拿上界当卖点。
 */
let tokenSumCalibrated = 0
let tokenN = 0
const lat = []
for (const f of facts) {
  const q = `${f.key} 现在是什么`
  const t0 = Date.now()
  const r = h.memory.recall({ text: q, budget: 320, manual: true })
  lat.push(Date.now() - t0)
  tokenSum += r.tokens
  tokenSumCalibrated += countWith(r.rendered, calibrationOf('cjk-ratio'))
  tokenN++
  const ids = r.hits.map((x) => x.cellId)
  // 命中任意一条同 (key,value) 的 cell 即算命中，取其中最好的名次
  let rank = -1
  for (const want of f.cellIds) {
    const at = ids.indexOf(want)
    if (at >= 0 && (rank < 0 || at < rank)) rank = at
  }
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
// 会被定长基底完全主导，那个数字不能代表真实轮次。
//
// ⚠ 这里曾经有一个测量错误：注释写着"800 字轮次"，实际构造的文本只有 311 字
// （≈885 B），而目标 0.45–0.60× 的推导前提是"一轮 ≈2.4 KB"。
// 分母比假设小 2.7 倍，指标自然永远不达标——这是**测量错**，不是实现错。
//
// 现在按文档口径构造：中英混排约 800 字（UTF-8 约 2.3–2.4 KB），
// 且**不用逐字重复的句子**——重复句会让 brotli 压到 0.10，
// 得出一个只在这个 fixture 里成立的漂亮数字。
const h3 = await createHarness({ sessionId: 'bench-storage' })
const SENTENCES = [
  '我们先把缓存分片的键设计讲清楚，按 workspace 与 session 两级拼，避免热点落在单个分片上。',
  '索引维护排期定在每周三凌晨，避开白天的发布窗口，回滚方案沿用上季度的蓝绿切换。',
  '灰度比例从 5% 起步，观察两小时错误率与 p95 延迟，没有异常再放到 25% 与 50%。',
  '压测报告由我下周跟进，重点看十万 cell 规模下的召回延迟与内存占用两条曲线。',
  '另外提醒一句：迁移脚本必须幂等，重复执行不能产生第二份残差，否则重建会翻倍。',
  '日志要带上 cell id 与 query id，否则线上排查时无法把召回结果和具体记忆对上。',
  '关于编码侧，命题切分保持单一谓词，一条断言只讲一件事，复合句一律拆开处理。',
  '冷层降级之后向量会压到三十二字节，召回时要按段展开再算余弦，否则冷记忆永远拿零分。',
  '面板首屏的预算给两百毫秒，单页五十条，图谱两百个节点，超出就分页而不是硬渲染。',
  '审批面只在用户明说要记住时免审，模型自己主动记录的那条必须走确认，避免静默写库。',
  '工作记忆上限十六条，本轮摸过的排在前面，跨轮只保留引用不保留内容，省上下文。',
  '残差按轮共享而不是按命题各存一份，否则一条长轮次被切成四条时定长成本会翻四倍。',
  '矛盾检测只看同一施事同一谓词家族，客体或极性不同才算冲突，取值相同一律合并。',
  '导出清单要能脱敏，导出前把手机号与邮箱替换成占位符，占位符本身不写回晶格。',
]
const turnText = (i) => {
  const parts = [`第 ${i} 轮记录：`]
  for (let k = 0; k < 18; k++) parts.push(SENTENCES[(i * 5 + k) % SENTENCES.length])
  return parts.join('')
}
for (let i = 0; i < 8; i++) await h3.turn(turnText(i))
const stLong = h3.memory.store.stats()
const ratioLong = stLong.rawBytes ? stLong.bytes / stLong.rawBytes : 0
const longCells = h3.memory.store.countCells()
const longTurns = 8
const longResidual = stLong.residualBytes ?? 0
const residualShare = stLong.rawBytes ? longResidual / stLong.rawBytes : 0
const longCellBytes = stLong.bytes - longResidual
const bytesPerCellLong = longCellBytes / Math.max(1, longCells)
const cellsPerTurnLong = longCells / longTurns
const avgCharsPerTurn = turnText(0).length
// 存储比降到 1.0× 所需的轮次字数：解 (n·b + s·L)/L = 1 → L = n·b/(1−s)
const breakEvenChars = residualShare < 0.98 ? (cellsPerTurnLong * bytesPerCellLong) / (1 - residualShare) : Infinity

// 对照组：把切分预算放大到"每轮一条"，验证存储比对切分粒度的敏感度。
// 这不是为了刷数字——它回答的是"文档 0.45–0.60× 到底在什么前提下成立"。
const h4 = await createHarness({ sessionId: 'bench-storage-coarse', encoder: { cellsPerTurnChars: 4000, cellsPerTurnFloor: 1 } })
for (let i = 0; i < 8; i++) await h4.turn(turnText(i))
const stCoarse = h4.memory.store.stats()
const coarseRatio = stCoarse.rawBytes ? stCoarse.bytes / stCoarse.rawBytes : 0
const coarseCells = h4.memory.store.countCells() / longTurns

const st = h.memory.store.stats()
const stats = h.memory.stats()
lat.sort((a, b) => a - b)
const p95 = lat[Math.min(lat.length - 1, Math.floor(lat.length * 0.95))] ?? 0
const tokensPerTurn = tokenN ? tokenSum / tokenN : 0
const tokensPerTurnCalibrated = tokenN ? tokenSumCalibrated / tokenN : 0

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
    tokensPerTurnCalibrated: round(tokensPerTurnCalibrated),
    recallP95Ms: p95,
    storageRatio: round(stats.storageRatio),
    storageRatioRealistic: round(ratioLong),
    storageRatioCoarse: round(coarseRatio),
    avgRawBytesPerTurn: round(st.rawBytes / Math.max(1, facts.length)),
    avgRawBytesPerTurnRealistic: round(stLong.rawBytes / longTurns),
    avgCharsPerTurnRealistic: avgCharsPerTurn,
    cellsPerTurnRealistic: round(longCells / longTurns),
    cellsPerTurnCoarse: round(coarseCells),
    bytesPerCell: round(bytesPerCellLong),
    residualShare: round(residualShare),
    storageBreakEvenChars: Math.round(breakEvenChars),
    cells: st.cells,
    residuals: st.residuals,
    invalidated: stats.invalidated,
  },
  // v0.7.2：以前这里写的是"设计目标"，与 ci-assert-bench.mjs 的**硬门槛**不是同一组数，
  // 读者会误以为 MRR 0.65 / dedupe 0.90 / coarse 0.70 是 CI 判据。现在显式区分两者。
  targets: {
    recallAt8: 'CI ≥ 0.80',
    mrr: 'CI ≥ 0.60（设计目标 0.65）',
    dedupePrecision: 'CI ≥ 0.85（设计目标 0.90）',
    dedupeRecall: 'CI ≥ 0.95',
    timeReasoningAccuracy: 'CI ≥ 0.75',
    tokensPerTurn: 'CI ≤ 240',
    storageRatio: '诊断口径（短轮次库，定长基底主导，不作门槛）',
    storageRatioRealistic: 'CI ≤ 0.90（残差压缩 0.47 是硬下界）',
    storageRatioCoarse: 'CI ≤ 0.72（设计目标 0.70）',
    storageBreakEvenChars: '参考值：存储比降到 1.0× 所需的轮次字数',
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
await h4.dispose()
process.exit(0)
