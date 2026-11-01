/**
 * v0.6 · 跨模型上下文编译器（创新 I5）
 *
 * 这一组测三件事，每件都对应一个**会静默出错**的场景：
 *   1. 弱模型拿到行式 → 不报错，只是白花 2.5× token 且解析不了
 *   2. 预算越界 → 不报错，只是被模型截断或额外计费
 *   3. 价格越界 → 不报错，只是月底账单吓人
 * 所以断言都写成"闸门必须拦住"，而不是"格式看起来对"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_PROFILE,
  MODEL_PROFILES,
  compileContext,
  estimateCost,
  previewAcrossModels,
  resolveModel,
} from './helpers.mjs'
import { createHarness } from '../packages/devkit/lib/index.js'

const TEXTS = [
  '我更喜欢用 pnpm 而不是 npm',
  '我们的部署环境是 linux arm64',
  '上次决定把记忆库放在 ~/.dsh/mnemo',
  '这个项目用 TypeScript 写，不要引入第三方依赖',
  '我讨厌红色按钮',
  '数据库用 node:sqlite 内置模块',
  '上周三我们讨论过保留度七因子',
  '把 token 预算压到 320',
  '测试必须能离线跑',
  '面板要有星图',
]

/** 一个 harness 供全部用例复用：每个 createHarness 要装 8 个插件，别在循环里建。 */
async function sampleCells() {
  const h = await createHarness({ sessionId: 'v06-compiler' })
  try {
    for (const t of TEXTS) await h.turn(t)
    const cells = []
    h.memory.store.forEachCell((c) => cells.push({ cell: c, shortId: c.cellId.toString(16).slice(-4) }))
    return cells
  } finally {
    await h.dispose()
  }
}

const CELLS = await sampleCells()

test('resolveModel：前缀匹配取最长，未知模型走保守档', () => {
  assert.equal(resolveModel('gpt-4o-2024-11-20').id, 'gpt-4o')
  assert.equal(resolveModel('gpt-4o-mini-2024').id, 'gpt-4o-mini', 'mini 不能被 gpt-4o 抢走')
  assert.equal(resolveModel('deepseek-chat').provider, 'deepseek')
  const unknown = resolveModel('some-company-model-x')
  assert.equal(unknown.strongSchema, FALLBACK_PROFILE.strongSchema, '未知模型必须保守（不吃行式）')
  assert.equal(unknown.tokenizer, FALLBACK_PROFILE.tokenizer)
})

test('compileContext：弱模型直接降 prose 并说明原因', () => {
  const model = resolveModel('llama3.1-8b')
  const out = compileContext({ cells: [], model, maxTokens: 320 })
  assert.equal(out.mode, 'prose')
  assert.ok(out.reasons.some((r) => r.includes('prose')), `原因里应说明降级：${out.reasons.join(' / ')}`)
})

test('compileContext：预算越界时先换格式、再丢条目，且 dropped 如实上报', () => {
  assert.ok(CELLS.length >= 3, `需要至少 3 条记忆，实际 ${CELLS.length}`)
  const model = resolveModel('deepseek-chat')
  const tight = compileContext({ cells: CELLS, model, maxTokens: 90 })
  assert.ok(tight.tokens <= 90, `必须落在预算内，实际 ${tight.tokens}`)
  assert.ok(tight.rows <= CELLS.length)
  assert.equal(tight.droppedByBudget, CELLS.length - tight.rows, 'dropped 必须与 rows 对得上')

  const loose = compileContext({ cells: CELLS, model, maxTokens: 800 })
  assert.ok(loose.rows >= tight.rows, '预算放宽后条目数不得减少')
})

test('compileContext：价格闸用钱而不是 token 表达', () => {
  const cheap = resolveModel('gpt-4o-mini')
  const pricey = resolveModel('claude-3-5-sonnet')
  const a = compileContext({ cells: CELLS, model: cheap, maxTokens: 320 })
  const b = compileContext({ cells: CELLS, model: pricey, maxTokens: 320 })
  assert.ok(b.cost > a.cost, '同一批记忆在贵模型上成本必须更高')
  assert.equal(estimateCost(1_000_000, pricey), pricey.inputPricePerMTok)
  // v0.6.1：价格闸现在**真的裁剪**。旧断言只看 fits=false（字段），
  // 看不到"一条没少"这个事实——审计稿 F1 就是这么漏过去的。
  const gated = compileContext({ cells: CELLS, model: pricey, maxTokens: 320, maxPrice: 0.0000001 })
  assert.equal(gated.rows, 0, '价格上限低到承担不起图例时，必须一条都不发')
  assert.equal(gated.cost, 0, '不发就不该计费')
  assert.equal(gated.suppressed, true, '必须显式标记"因闸门被压制"')
  assert.ok(
    gated.reasons.some((r) => r.includes('价格') || r.includes('图例')),
    `原因里应说明是价格/图例：${gated.reasons.join(' / ')}`,
  )
})

test('previewAcrossModels：同一批记忆给出多模型成本表，且不越预算', () => {
  const rows = previewAcrossModels(CELLS, 200)
  assert.ok(rows.length >= 4)
  for (const r of rows) {
    assert.ok(r.tokens <= 200, `${r.id} 越预算：${r.tokens}`)
    assert.ok(Number.isFinite(r.cost))
  }
  const cheap = rows.find((r) => r.id === 'gpt-4o-mini')
  const pricey = rows.find((r) => r.id === 'claude-3-5-sonnet')
  if (cheap && pricey) assert.ok(cheap.cost < pricey.cost)
})

test('MODEL_PROFILES：画像表自身一致（窗口 > 输出、价格非负、tokenizer 合法）', () => {
  const kinds = new Set(['cjk-ratio', 'cl100k', 'claude', 'gemini', 'llama'])
  for (const m of MODEL_PROFILES) {
    assert.ok(m.contextWindow > m.maxOutput, `${m.id} 的窗口必须大于输出上限`)
    assert.ok(m.inputPricePerMTok >= 0 && m.outputPricePerMTok >= 0)
    assert.ok(kinds.has(m.tokenizer), `${m.id} 的 tokenizer 非法：${m.tokenizer}`)
    assert.ok(m.id.length > 0)
  }
})

test('compileContext：token 单调（同格式下条目越多 token 不减）', () => {
  const model = resolveModel('deepseek-chat')
  let prev = -1
  for (let n = 0; n <= CELLS.length; n++) {
    const out = compileContext({ cells: CELLS.slice(0, n), model, maxTokens: 2000 })
    assert.ok(out.tokens >= prev, `条目 ${n} 的 token ${out.tokens} 小于前一个 ${prev}`)
    prev = out.tokens
  }
})
