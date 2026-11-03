/**
 * 真实语料评测（v0.7.0）
 *
 * ── 为什么还要有第二个 bench ──────────────────────────────────────
 * `bench-eval.mjs` 是**合成**的：24 个 topic × 4 个句式模板，query 由模板拼出来。
 * 独立审计对它的批评很准：**query 按事实模板自动生成，Recall 天然偏乐观**。
 * 真实用户不会问"ui.theme 现在是什么"，他会问"我之前说主题用啥来着？"。
 *
 * 这个文件补的就是那一半：**手写对话 + 手写 query**，不做模板生成。
 * 语料是中文日常对话（含口语、省略、指代、改口），query 是真人会说的话。
 *
 * ── 它回答什么 ────────────────────────────────────────────────────
 *   single  —— 单跳：一句话里的事实，能不能被一句话问出来
 *   update  —— 改口：说过两次不同的话，问"现在"要给新的、且不能给旧的
 *   multi   —— 多跳：答案需要两条记忆（命中任意一条算部分分）
 *   trap    —— 陷阱：从没发生过的事，必须**弃权**而不是编
 *   affect  —— 情感：情绪化表达要能被当作感受记住
 *
 * ── 口径 ──────────────────────────────────────────────────────────
 * 判据是"渲染结果里出现期望片段"，不是 cell id——真实使用时模型看到的就是渲染文本。
 * 陷阱题判据是 `verdict !== 'hit'`（v0.6.2 引入的弃权原语）。
 */
import { createHarness } from '@rain13sad/llm-mnemo-devkit'
import { writeFileSync, mkdirSync } from 'node:fs'

/**
 * 语料：每段是一个独立会话（`turns`），后面跟针对它的手写 query。
 * `expect` 是渲染里必须出现的片段（大小写不敏感）；`reject` 是必须不出现的片段。
 */
const CASES = [
  {
    id: 'eng-stack',
    turns: ['我们仓库叫 dsh-ui，用 TypeScript 写。', '构建统一用 pnpm，别用 npm。', 'CI 跑 6 分钟，smoke 和 full 两档。'],
    queries: [
      { q: '我们用什么构建来着？', kind: 'single', expect: ['pnpm'] },
      { q: '仓库叫什么名字？', kind: 'single', expect: ['dsh-ui'] },
      { q: 'CI 要跑多久？', kind: 'single', expect: ['6'] },
    ],
  },
  {
    id: 'pref-ui',
    turns: ['我字体偏好等宽，主题用深色。', '浅色看久了眼睛疼。'],
    queries: [
      { q: '我主题偏好什么？', kind: 'single', expect: ['深色'] },
      { q: '字体我习惯用什么？', kind: 'single', expect: ['等宽'] },
    ],
  },
  {
    id: 'update-deploy',
    turns: ['部署脚本用 pnpm。', '算了，部署脚本改用 npm 吧。'],
    queries: [
      // 改口后问"现在"：必须给新值，且**不能**再给旧值
      { q: '部署脚本现在用哪个？', kind: 'update', expect: ['npm'], reject: ['pnpm'] },
    ],
  },
  {
    /**
     * 审计 R1 的原始形态：三阶段改口，且**后两句都没有主语**。
     *
     * 这条用例是本轮新增的（v0.7.1）。它比 update-deploy 更狠：
     *   · "办公室在浦东" 是"X 在 Y"句式，旧抽取根本不成帧（0 条 cell）；
     *   · 后两句省略主语，靠跨轮话题锚接上；
     *   · 三个谓词分属 located / lives / located，靠 conflictFamily 归一才连得起来。
     * 任何一环断掉，答案都会停在中间那一版——而那是最坏的一种错：听起来很确定。
     */
    id: 'update-office',
    turns: ['办公室在浦东。', '其实搬到徐汇了。', '最终定在静安寺。'],
    queries: [
      { q: '办公室在哪？', kind: 'update', expect: ['静安寺'], reject: ['浦东', '徐汇'] },
    ],
  },
  {
    id: 'life-cat',
    turns: ['我的猫叫雪球，今年三岁。', '我下周要去北京出差三天。'],
    queries: [
      { q: '我的猫叫什么？', kind: 'single', expect: ['雪球'] },
      { q: '我下周去哪出差？', kind: 'single', expect: ['北京'] },
    ],
  },
  {
    id: 'affect-companion',
    turns: ['今天真的很难受，感觉自己什么都做不好。', '谢谢你一直陪着我。'],
    queries: [
      { q: '我最近心情怎么样？', kind: 'affect', expect: ['难受', '陪', '低落', '感受'] },
    ],
  },
  {
    id: 'multi-hop',
    turns: ['项目代号是 aurora。', 'aurora 的 deadline 是下个月十号。'],
    queries: [
      { q: 'aurora 什么时候截止？', kind: 'multi', expect: ['十号', 'deadline', '截止', 'aurora'] },
    ],
  },
  {
    id: 'trap-never-happened',
    turns: ['我们仓库叫 dsh-ui，用 TypeScript 写。'],
    queries: [
      // 从没提过狗：正确行为是弃权，不是拿"猫/仓库"去凑
      { q: '我养的狗叫什么名字？', kind: 'trap' },
      { q: '我上次说的那家餐厅在哪？', kind: 'trap' },
    ],
  },
]

const results = []
let seed = 0

for (const c of CASES) {
  const h = await createHarness({ sessionId: `real-${c.id}-${seed++}` })
  try {
    for (const t of c.turns) await h.turn(t)
    for (const q of c.queries) {
      const r = h.memory.recall({ text: q.q, budget: 400, manual: true })
      const rendered = (r.rendered ?? '').toLowerCase()
      let ok = false
      let note = ''
      if (q.kind === 'trap') {
        ok = r.verdict !== 'hit'
        note = `verdict=${r.verdict} hits=${r.hits.length}`
      } else {
        const hitAny = q.expect.some((e) => rendered.includes(String(e).toLowerCase()))
        const violated = (q.reject ?? []).some((e) => rendered.includes(String(e).toLowerCase()))
        ok = hitAny && !violated
        note = `hits=${r.hits.length} tokens=${r.tokens}${violated ? ' 出现旧值' : ''}`
      }
      results.push({ case: c.id, q: q.q, kind: q.kind, ok, note, verdict: r.verdict ?? null })
    }
  } finally {
    await h.dispose()
  }
}

const byKind = {}
for (const r of results) {
  const b = (byKind[r.kind] ??= { total: 0, pass: 0 })
  b.total++
  if (r.ok) b.pass++
}
const acc = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Number((v.pass / v.total).toFixed(3))]))
const overall = Number((results.filter((r) => r.ok).length / results.length).toFixed(3))

const report = {
  generatedAt: new Date().toISOString(),
  note: '手写对话 + 手写 query，无模板生成。判据是渲染文本包含期望片段；陷阱题判据是 verdict≠hit。',
  cases: CASES.length,
  queries: results.length,
  accuracy: { overall, ...acc },
  counts: byKind,
  results,
}

mkdirSync('artifacts', { recursive: true })
writeFileSync('artifacts/bench-real.json', JSON.stringify(report, null, 2))

console.log('\nMnemoVault 真实语料评测（手写语料 / 手写 query）')
console.log('─'.repeat(64))
for (const [k, v] of Object.entries(byKind)) {
  console.log(`  ${k.padEnd(8)} ${String(v.pass).padStart(2)}/${v.total}   ${(v.pass / v.total).toFixed(2)}`)
}
console.log(`  ${'overall'.padEnd(8)} ${results.filter((r) => r.ok).length}/${results.length}   ${overall.toFixed(2)}`)
console.log('─'.repeat(64))
const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.log('未通过：')
  for (const f of failed) console.log(`  · [${f.kind}] ${f.q}  （${f.note}）`)
} else {
  console.log('全部通过')
}
console.log('report → artifacts/bench-real.json\n')
