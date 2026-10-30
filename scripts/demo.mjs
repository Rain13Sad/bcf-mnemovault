/**
 * 端到端演示：装载全部插件 → 跑 26 轮中文对话 → 注入 / 巩固 / 统计。
 *
 *   node scripts/demo.mjs
 *
 * 这个脚本存在的意义：证明"文档里的每一章都在同一条代码路径上生效"，
 * 而不是各章各自有一个漂亮的单测。
 */
import { createHarness } from '@rain13sad/dsh-mnemo-devkit'
import { writeFileSync, mkdirSync } from 'node:fs'

const SCRIPT = [
  ['我叫阿哲，在一家做开发者工具的小公司负责前端。', {}],
  ['我们的仓库叫 dsh-ui，主要用 TypeScript 和 React。', {}],
  ['我习惯用深色主题，浅色看久了眼睛疼。', {}],
  ['字体我也偏好等宽，读代码更舒服。', {}],
  ['API key 存在 ~/.config/dsh/credentials.json 里，别写进代码。', {}],
  ['上周三我们在评审会上决定 V2 的缓存方案先回滚。', {}],
  ['那个缓存 bug 是李工提的，跟并发写有关。', {}],
  ['以后不要在我没确认的情况下直接改 package.json。', {}],
  ['我不喜欢自动生成的 commit message，太啰嗦。', {}],
  ['其实我更喜欢无衬线字体，等宽只用在代码块里。', {}],
  ['记住：部署脚本要用 pnpm，不要用 npm。', {}],
  ['CI 现在跑 6 分钟，主要是 e2e 太慢。', {}],
  ['我们决定把 e2e 拆成 smoke 和 full 两档。', {}],
  ['三周前讨论过的那个虚拟滚动方案，最后没做。', {}],
  ['我现在有点烦，构建又挂了。', {}],
  ['构建挂是因为 lockfile 冲突，删掉重装就好。', {}],
  ['团队里小王负责设计系统，他偏好更克制的配色。', {}],
  ['我们下周要交付 0.3 版本，重点是记忆面板。', {}],
  ['面板首屏要控制在 200 毫秒以内。', {}],
  ['我确认一下：深色主题这件事你记对了吗？', {}],
  ['对，就是这样。', {}],
  ['另外我喜欢把日志放在 stderr，stdout 留给数据。', {}],
  ['那个 API key 在 ~/.config/dsh/credentials.json，记住别外发。', {}],
  ['我们决定不用 Redux，状态全放 URL 和本地缓存。', {}],
  ['最后确认一下我之前说的字体偏好是什么？', {}],
  ['好，先这样。', {}],
]

const harness = await createHarness({ sessionId: 'demo-1', config: { preset: 'balanced' } })
const log = (...a) => console.log(...a)

log('=== 1. 编码 26 轮 ===')
let injectedCount = 0
for (let i = 0; i < SCRIPT.length; i++) {
  const [text, opts] = SCRIPT[i]
  await harness.turn(text, { assistant: opts.assistant, tools: opts.tools, advanceMs: 3_600_000 })
  // 每轮都跑一次 pre-step，看门控是否生效
  const injected = await harness.preStep(text)
  if (injected) injectedCount++
  if (i === 0 || i === 3 || i === 8 || i === 25) {
    log(`\n--- turn ${i + 1}: ${text.slice(0, 30)}…`)
    log(injected ? injected.content[0].text : '（本轮未注入）')
  }
}

log(`\n注入轮次 ${injectedCount}/${SCRIPT.length}`)

log('\n=== 2. 巩固 pass ===')
const pass = harness.consolidate()
log(pass)

log('\n=== 3. 统计 ===')
const s = harness.stats()
log({
  cells: s.cells,
  edges: s.edges,
  byKind: s.byKind,
  hitRate: Number(s.hitRate.toFixed(2)),
  tokensPerTurn: Number(s.tokensPerTurn.toFixed(1)),
  disputed: s.disputed,
  contradictions: s.contradictions,
  p95: s.recallP95Ms,
})

log('\n=== 4. 体检 ===')
log(harness.memory.doctor())

log('\n=== 5. 情感 ===')
log(harness.affect?.report())

log('\n=== 6. 冲突版本链（字体偏好）===')
const hits = harness.memory.recall({ text: '字体偏好 等宽 无衬线', budget: 400, manual: true })
log(hits.rendered)
for (const h of hits.hits) {
  const c = harness.memory.store.getCell(BigInt('0x' + h.cellId))
  if (c) log(`  ${h.shortId} support=${c.support} importance=${c.importance.toFixed(2)} disputed=${(c.flags & 4) !== 0} ${c.digest}`)
}

log('\n=== 7. 命令面 ===')
const toolsMod = harness.tools.get('mnemo_command')
if (toolsMod) {
  for (const line of ['stats', 'affect', 'doctor']) {
    const out = await toolsMod.execute({ line })
    log(`\n/mnemo ${line}\n${out.text}`)
  }
}

log('\n=== 8. egress 守卫 ===')
try {
  await harness.invokeTool('memory_recall', { query: '深色主题' })
  log('普通检索：放行 ✓')
} catch (e) {
  log('普通检索被拒：', e.message)
}
// 把记忆原文塞进外发工具参数：守卫应 fail-closed
const leaked = harness.guard('web_fetch', { url: 'https://example.com', body: '我习惯用深色主题，浅色看久了眼睛疼。' })
log(leaked ? 'web_fetch 被拦截 ✓：' + leaked : 'web_fetch 未被拦截 ✗')
const clean = harness.guard('web_fetch', { url: 'https://example.com/docs' })
log(clean ? '正常外发被误拦 ✗：' + clean : '正常外发放行 ✓')

// ── 9. 陪伴层：情感记忆 / 联想 / 叙事 / 主动 ─────────────────────
log('\n=== 9. 情感记忆（不参与衰减）===')
const emo = harness.memory.store.listCells({ limit: 200 }).filter((c) => (c.flags & 64) !== 0)
log(`情感记忆 ${emo.length} 条：`)
for (const c of emo.slice(0, 5)) log(`  ${c.cellId.toString(16).slice(-4)}  V${c.valence.toFixed(2)}  ${c.digest}`)

log('\n=== 10. 联想链 ===')
// 挑一个"确实有边"的种子：孤立节点当然联想不出东西
const seedEdge = harness.memory.store.allEdges().find((e) => e.rel === 14 || e.rel === 15)
const seedCell = seedEdge ? harness.memory.store.getCell(seedEdge.src) : emo[0]
const chain = seedCell ? harness.memory.associate(seedCell.cellId, { depth: 2, limit: 5 }) : []
if (chain.length === 0) log('  （还没有联想边，多聊几轮或跑巩固会长出来）')
for (const x of chain) log(`  ${'→'.repeat(x.hop)} ${x.shortId}  ${x.score.toFixed(2)}  [${x.lens}]  ${x.digest.slice(0, 40)}`)

log('\n=== 11. 叙事层 ===')
const stories = harness.memory.store.listCells({ kind: 6, limit: 3 })
if (stories.length === 0) log('  （情感事件不足 3 条，暂未成篇）')
for (const st of stories) log(`  ${st.cellId.toString(16).slice(-4)}  ${st.digest}`)

log('\n=== 12. 依恋与阶段 ===')
log(`  依恋 ${harness.affect.attachment()}  阶段 ${harness.affect.stage().label}`)

log('\n=== 13. 主动开口 ===')
const pro = harness.proactiveService()
if (!pro) log('  （未装载 proactive）')
else {
  // 用可推进的时钟（harness.now()）而不是固定日期：事件时间都挂在这个时钟上
  pro.config.requireReason = false
  pro.config.idleMin = 1
  pro.config.quietStart = 0
  pro.config.quietEnd = 0
  const cand = harness.proactive(harness.now() + 2 * 3600_000)
  log(cand ? `  [${cand.kind}] ${cand.reason}\n  ${cand.text}` : '  （此刻不该开口，原因见面板"最近为什么没说"）')
}

log('\n=== 14. 保留度与六档处置 ===')
// 把一批记忆推到很久以前，再跑降档：v0.5 要证明的是"库真的会出手"。
// 400 天 → 冷层；900 天 → 墓碑（残差与向量被释放，只留摘要，且不再参与召回）。
const pool = harness.memory.store.listCells({ limit: 200 })
const targets = pool.filter((c) => c.provenance === 0 && c.kind <= 2 && !(c.flags & 1 << 1)).slice(0, 6)
const clock = harness.now()
for (const c of targets) {
  c.tAccess = BigInt(clock - 900 * 86_400_000)
  c.tIngest = BigInt(clock - 1400 * 86_400_000)
  harness.memory.store.putCell(c)
}
const bytesBefore = harness.memory.store.stats().bytes
for (let i = 0; i < 8; i++) harness.memory.demoteDue()
const bytesAfter = harness.memory.store.stats().bytes
const ret = harness.memory.panelSnapshot().retention
log(`  六档分布：${JSON.stringify(ret.byDisposition)}`)
for (const e of ret.entries.slice(0, 5)) {
  log(`  ${e.shortId}  ${e.disposition} ${e.score.toFixed(2)}  tier=${e.tier}  ${e.protectedBy ?? '无闸门'}  ${e.why}`)
}
log(`  字节 ${bytesBefore} → ${bytesAfter}（墓碑压实：残差与向量已释放）`)
const doc = harness.memory.doctor()
log(`  doctor：墓碑 ${doc.tombstones} 条 / ${doc.tombstoneBytes} B；失效未降档 ${doc.invalidNotDemoted} 条；孤儿残差 ${doc.orphanResiduals}`)
const fixed = harness.memory.doctor({ fix: true })
log(`  doctor --fix 后：孤儿残差 ${fixed.orphanResiduals} 条；${fixed.fixed.join('；') || '无需修复'}`)
log(`  召回是否还会命中墓碑：${harness.memory.recall({ text: 'pnpm 部署', budget: 400, manual: true, readOnly: true }).hits.length} 条候选`)

// 落一份面板快照，供 UI 预览使用
const panel = harness.panel()
mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/panel-snapshot.json', JSON.stringify(panel, null, 2), 'utf8')
log(`\n面板快照已写入 artifacts/panel-snapshot.json（${panel.cells.length} cells / ${panel.edges.length} edges）`)

await harness.dispose()
process.exit(0)
