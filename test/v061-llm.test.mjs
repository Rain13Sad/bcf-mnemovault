/**
 * v0.6.1 · 端口装配的一致性（审计稿 F7）
 *
 * `provider` 决定**端点与鉴权**，`model` 决定**token 口径与价格**。
 * v0.6.0 的 tokenizer 取自 provider、价格取自 model，两者之间没有任何校验：
 * `provider: 'openai'` + `model: 'deepseek-chat'` 会用 cl100k 的 token 数乘 DeepSeek 的价格。
 * 同一段中文两个口径差 18%，叠加模型别名问题可差 40%+ —— 而且**不报错**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnginePorts, createTokenizer, countWith, calibrationOf } from '../packages/llm/lib/index.js'

test('F7：provider 与 model 不是同一家时，口径按模型校正并留 note', () => {
  const r = createEnginePorts({ provider: 'openai', model: 'deepseek-chat', embeddingEnabled: false })
  assert.ok(
    r.notes.some((n) => n.includes('不是同一家') && n.includes('cjk-ratio')),
    `notes 应说明口径已校正：${r.notes.join(' | ')}`,
  )
  assert.equal(r.ports.tokenizer.name, 'deepseek/cjk-ratio', `tokenizer 应跟模型走，实际 ${r.ports.tokenizer.name}`)
  assert.equal(r.ports.model.provider, 'deepseek')
})

test('F7：provider 与 model 一致时不产生噪音 note', () => {
  const r = createEnginePorts({ provider: 'deepseek', model: 'deepseek-v3' })
  assert.equal(
    r.notes.some((n) => n.includes('不是同一家')),
    false,
    `同源时不该有口径告警：${r.notes.join(' | ')}`,
  )
  assert.equal(r.ports.tokenizer.name, 'deepseek/cjk-ratio')
})

test('F7：ollama + llama 的口径是 llama（不是 cjk-ratio）', () => {
  const r = createEnginePorts({ provider: 'ollama', model: 'llama3.1:8b' })
  assert.equal(r.ports.model.tokenizer, 'llama')
  assert.equal(r.ports.tokenizer.name, 'ollama/llama')
  // llama 的系数明显高于 cjk-ratio：同一段中文应当数出更多 token
  const text = '我们的记忆库用 node:sqlite，不引入第三方依赖。'
  assert.ok(countWith(text, calibrationOf('llama')) > countWith(text, calibrationOf('cjk-ratio')))
})

test('F7：未知模型 → 保守档 + 明确 note（价格按最贵估，不是免费）', () => {
  const r = createEnginePorts({ provider: 'openai-compatible', model: 'no-such-model-xyz' })
  assert.ok(r.notes.some((n) => n.includes('不在画像表里')), `应提示未知模型：${r.notes.join(' | ')}`)
  assert.ok(r.ports.model.inputPricePerMTok > 0, '未知模型不能按免费算')
  assert.equal(r.ports.model.strongSchema, false, '未知模型按保守档（prose）')
})

test('F7：provider 没有 embedding 端点时明确降级，而不是静默返回空向量', () => {
  const r = createEnginePorts({ provider: 'deepseek', model: 'deepseek-chat', embeddingEnabled: true })
  assert.equal(r.embedding, null, 'DeepSeek 没有 embedding 端点')
  assert.ok(r.notes.some((n) => n.includes('embedding')), `notes 应说明原因：${r.notes.join(' | ')}`)
})

test('F7：openai-compatible 未填 baseUrl 时给出可执行的提示', () => {
  const r = createEnginePorts({ provider: 'openai-compatible', model: 'qwen-max' })
  assert.ok(r.notes.some((n) => n.includes('baseUrl')), `应提示填 baseUrl：${r.notes.join(' | ')}`)
})

test('F7：tokenizer 系数单调（claude > gpt > deepseek > llama 不对，llama 最高）', () => {
  const text = '记忆库用 node:sqlite 内置模块，不引入第三方依赖。'
  const d = countWith(text, calibrationOf('cjk-ratio'))
  const g = countWith(text, calibrationOf('cl100k'))
  const c = countWith(text, calibrationOf('claude'))
  const l = countWith(text, calibrationOf('llama'))
  assert.ok(g > d, `gpt ${g} 应 > deepseek ${d}`)
  assert.ok(c > g, `claude ${c} 应 > gpt ${g}`)
  assert.ok(l > c, `llama ${l} 应 > claude ${c}（小词表更碎）`)
})

test('F7：同一个 tokenizer 的 count 与 truncate 自洽', () => {
  const tk = createTokenizer({ kind: 'claude' })
  const text = '把这段中文按预算截断，不能切出半个词。'
  for (const budget of [5, 10, 20]) {
    const cut = tk.truncate(text, budget)
    assert.ok(tk.count(cut) <= budget, `budget ${budget}：截断后 ${tk.count(cut)} 越界`)
    assert.ok(text.startsWith(cut), '截断必须保留前缀')
  }
})
