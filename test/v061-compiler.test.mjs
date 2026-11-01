/**
 * v0.6.1 · 编译器闸门与模型画像（审计稿 F1 / F2）
 *
 * 这一组的原则写在审计稿里：**凡 reasons 里写了"按 X 裁剪"，就必须有一条断言证明 X 真的变了。**
 * 所以断言全部落在 `rows` / `cost` 这些**行为量**上，而不是 `fits` / `reasons` 这些报告字段。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FALLBACK_PROFILE,
  MODEL_PROFILES,
  compileContext,
  estimateCost,
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
  '加固态盘比机械盘快很多',
  '每周五下午做一次复盘',
]

async function sampleCells() {
  const h = await createHarness({ sessionId: 'v061-compiler' })
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
const GPT = resolveModel('gpt-4o')

test('F1：价格上限必须真的裁剪——上限越低，条数越少', () => {
  assert.ok(CELLS.length >= 8, `需要足够多的记忆，实际 ${CELLS.length}`)
  const caps = [undefined, 0.004, 0.002, 0.001, 1e-9]
  const rows = caps.map((p) => compileContext({ cells: CELLS, model: GPT, maxTokens: 320, maxPrice: p }))
  // 单调不增
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].rows <= rows[i - 1].rows, `上限收紧后条数不应变多：${caps[i - 1]} → ${rows[i - 1].rows}，${caps[i]} → ${rows[i].rows}`)
  }
  // 无上限时应该能发出若干条
  assert.ok(rows[0].rows >= 5, `无上限时应有若干条，实际 ${rows[0].rows}`)
  // 收紧后条数必须真的变少（不是"报告了但没动"）
  assert.ok(rows[1].rows < rows[0].rows, '把上限压到 ¥0.004 之后条数必须减少')
  // 极低上限 → 一条都不发，且不计费
  assert.equal(rows[4].rows, 0, '上限 1e-9 时不能发任何记忆')
  assert.equal(rows[4].cost, 0, '不发就不该计费')
  assert.equal(rows[4].suppressed, true, 'suppressed 必须为真，调用方据此知道"是被预算压掉的"')
})

test('F1：只要发了记忆，成本就必须落在上限之内（逐点验证）', () => {
  for (const cap of [0.02, 0.01, 0.006, 0.003, 0.0015]) {
    const r = compileContext({ cells: CELLS, model: GPT, maxTokens: 320, maxPrice: cap })
    if (r.rows > 0) assert.ok(r.cost <= cap + 1e-12, `cap ${cap} 下成本 ${r.cost} 越界`)
    assert.ok(r.tokens <= 320, `cap ${cap} 下 token ${r.tokens} 越界`)
  }
})

test('F1：token 闸与价格闸共用一条裁剪路径（都靠丢条目达成）', () => {
  const tightToken = compileContext({ cells: CELLS, model: GPT, maxTokens: 120 })
  assert.ok(tightToken.tokens <= 120, `必须落在 token 预算内，实际 ${tightToken.tokens}`)
  assert.ok(tightToken.rows < CELLS.length, '预算收紧必须真的少发几条')
  assert.equal(tightToken.droppedByBudget, CELLS.length - tightToken.rows, 'dropped 必须与 rows 对得上')

  // 价格闸用同一把尺子：条数变少，成本跟着变低
  const loose = compileContext({ cells: CELLS, model: GPT, maxTokens: 320 })
  const tightPrice = compileContext({ cells: CELLS, model: GPT, maxTokens: 320, maxPrice: 0.002 })
  assert.ok(tightPrice.rows <= loose.rows)
  assert.ok(tightPrice.cost <= loose.cost)
})

/** 真实模型名清单（≥30 个，含版本号/日期后缀/大小写/厂商简写）。 */
const REAL_NAMES = [
  'deepseek-chat',
  'deepseek-v3',
  'DeepSeek-V3',
  'deepseek-reasoner',
  'deepseek-r1',
  'deepseek-chat-0324',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4o-2024-11-20',
  'gpt-5',
  'gpt-5-mini',
  'o3-mini',
  'claude-3-5-sonnet',
  'claude-sonnet-4-5',
  'claude-3-5-haiku',
  'claude-haiku-4',
  'claude-opus-4',
  'gemini',
  'gemini-1.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-pro',
  'llama3.1:8b',
  'llama3.1',
  'llama-3.1-70b',
  'qwen',
  'qwen2.5-72b',
  'qwen-max',
  'glm-4',
  'yi-large',
  'mistral-large',
  'phi-3-mini',
  'local-weak',
]

test('F2：32 个真实模型名必须全部命中画像（不允许落保守档）', () => {
  const missed = []
  for (const name of REAL_NAMES) {
    const m = resolveModel(name)
    if (m === FALLBACK_PROFILE || m.id === 'unknown' || m.inputPricePerMTok === FALLBACK_PROFILE.inputPricePerMTok && m.label === FALLBACK_PROFILE.label) {
      missed.push(`${name} → ${m.id}`)
    }
  }
  assert.deepEqual(missed, [], `这些名字落到了保守档：${missed.join(', ')}`)
})

test('F2：命中后的能力位必须与厂商一致（不能把强模型判成弱模型）', () => {
  // DeepSeek / GPT / Claude / Gemini / Qwen 都能吃行式；本地小模型不能
  for (const name of ['deepseek-v3', 'deepseek-chat', 'gpt-4o', 'gpt-5', 'claude-sonnet-4-5', 'gemini-2.5-flash', 'qwen-max']) {
    assert.equal(resolveModel(name).strongSchema, true, `${name} 应支持行式`)
  }
  assert.equal(resolveModel('llama3.1:8b').strongSchema, false, '本地小模型不支持行式')
  assert.equal(resolveModel('llama3.1:8b').tokenizer, 'llama', 'llama 系的 tokenizer 必须是 llama')
})

test('F2：deepseek-v3 不能再被降级成 prose（这是 README 116 token 卖点的前提）', () => {
  const r = compileContext({ cells: CELLS, model: resolveModel('deepseek-v3'), maxTokens: 320 })
  assert.equal(r.mode, 'rows', 'deepseek-v3 必须走行式')
  assert.ok(!r.reasons.some((x) => x.includes('prose')), `不应出现 prose 降级：${r.reasons.join(' / ')}`)
})

test('F2：只写厂商名时行为确定（家族表，不是双向前缀）', () => {
  assert.equal(resolveModel('deepseek').provider, 'deepseek')
  assert.equal(resolveModel('deepseek').strongSchema, true)
  assert.equal(resolveModel('claude').provider, 'anthropic')
  assert.equal(resolveModel('gemini').provider, 'google')
  // gemini 不能再命中 flash（最弱档），claude 也不能随版本漂移
  assert.equal(resolveModel('gemini').id, 'gemini-1.5-pro')
})

test('F2：未知模型不等于免费（否则价格闸对它永远不触发）', () => {
  const m = resolveModel('totally-unknown-model-xyz')
  assert.ok(m.inputPricePerMTok > 0, `未知模型的价格必须 > 0，实际 ${m.inputPricePerMTok}`)
  const r = compileContext({ cells: CELLS, model: m, maxTokens: 320, maxPrice: 0.0000001 })
  assert.equal(r.rows, 0, '未知模型 + 极低预算：必须一条都不发')
})

test('F2：画像表自身没有重复 id，别名不与他人 id 冲突', () => {
  const ids = new Set()
  for (const m of MODEL_PROFILES) {
    assert.equal(ids.has(m.id), false, `重复的画像 id：${m.id}`)
    ids.add(m.id)
  }
  for (const m of MODEL_PROFILES) {
    for (const a of m.aliases ?? []) {
      if (ids.has(a.toLowerCase()) && a.toLowerCase() !== m.id) {
        assert.fail(`别名 ${a}（属于 ${m.id}）与另一个画像的 id 冲突`)
      }
    }
  }
})

test('F2：estimateCost 与画像价格一致（回归：不能出现第二份价格表）', () => {
  for (const m of MODEL_PROFILES) {
    assert.equal(estimateCost(1_000_000, m), m.inputPricePerMTok, `${m.id} 的成本换算不一致`)
  }
})
