/**
 * v0.6 · LLM 适配层
 *
 * 全部用例用**假 fetch**：这一层测的是"协议适配对不对"，不是"模型聪不聪明"。
 * 真模型不可测（不确定、要钱、要网），但**响应形状**是可测的——
 * 而线上事故几乎都出在形状上（`data[0].embedding` 还是 `embedding.values`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDERS,
  PROVIDER_IDS,
  HttpEmbeddingProvider,
  HttpError,
  LlmExtractor,
  authHeaders,
  calibrationOf,
  countWith,
  createEnginePorts,
  createTokenizer,
  endpointOf,
  extractText,
  parseEmbedding,
  parseFacts,
  postJson,
  resolveProvider,
} from '../packages/llm/lib/index.js'

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')), headers: init?.headers ?? {} })
    const r = await handler({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) }, calls.length)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    }
  }
  impl.calls = calls
  return impl
}

test('parseEmbedding：三种响应形状都能吃', () => {
  const openai = parseEmbedding({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
  assert.equal(openai.length, 3)
  const ollama = parseEmbedding({ embedding: [1, 2, 3, 4] })
  assert.equal(ollama.length, 4)
  const gemini = parseEmbedding({ embedding: { values: [0.5, 0.5] } })
  assert.equal(gemini.length, 2)
  const nested = parseEmbedding({ embeddings: [[1, 0, 0]] })
  assert.equal(nested.length, 3)
  assert.equal(parseEmbedding({ data: [] }), null)
  assert.equal(parseEmbedding({ data: [{ embedding: ['x'] }] }), null, '非数字必须拒绝，不能变 NaN')
})

test('HttpEmbeddingProvider：L2 归一化 + 缓存命中 + peek 同步可读', async () => {
  const f = fakeFetch(() => ({ status: 200, body: { data: [{ embedding: [3, 4] }] } }))
  const p = new HttpEmbeddingProvider({ provider: 'openai', model: 'text-embedding-3-small', apiKey: 'k', fetchImpl: f })
  const v = await p.embed('hello')
  assert.ok(Math.abs(Math.hypot(v[0], v[1]) - 1) < 1e-6, '必须归一化')
  assert.equal(f.calls.length, 1)
  assert.ok(p.peek('hello'), 'peek 必须能同步读到')
  await p.embed('hello')
  assert.equal(f.calls.length, 1, '第二次必须走缓存')
  assert.equal(p.peek('未预热'), null)
})

test('HttpEmbeddingProvider：空间里带 provider 与模型名（换模型 = 换空间）', () => {
  const a = new HttpEmbeddingProvider({ provider: 'openai', model: 'text-embedding-3-small' })
  const b = new HttpEmbeddingProvider({ provider: 'ollama', model: 'nomic-embed-text' })
  assert.equal(a.space, 'provider:openai:text-embedding-3-small')
  assert.notEqual(a.space, b.space)
})

test('postJson：4xx 不重试，5xx 重试到上限', async () => {
  const deny = fakeFetch(() => ({ status: 401, body: { error: 'bad key' } }))
  await assert.rejects(() => postJson('https://x.test/v1/embeddings', {}, { fetchImpl: deny, retries: 2, timeoutMs: 500 }), HttpError)
  assert.equal(deny.calls.length, 1, '4xx 重试是浪费')

  const flaky = fakeFetch((_r, n) => (n < 3 ? { status: 503, body: 'busy' } : { status: 200, body: { ok: true } }))
  const out = await postJson('https://x.test/v1/embeddings', {}, { fetchImpl: flaky, retries: 2, timeoutMs: 500 })
  assert.deepEqual(out, { ok: true })
  assert.equal(flaky.calls.length, 3)
})

test('postJson：超时必须中止，而不是挂住整轮对话', async () => {
  const slow = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    })
  await assert.rejects(() => postJson('https://x.test/slow', {}, { fetchImpl: slow, retries: 0, timeoutMs: 30 }))
})

test('parseFacts：纯数组 / {facts:[]} / ```json 包裹都能解析', () => {
  const a = parseFacts('[{"predicate":"prefers","object":"pnpm"}]')
  assert.equal(a.length, 1)
  const b = parseFacts('{"facts":[{"predicate":"uses","object":"sqlite"}]}')
  assert.equal(b.length, 1)
  const c = parseFacts('```json\n[{"predicate":"decided","object":"v0.6"}]\n```')
  assert.equal(c.length, 1)
  const d = parseFacts('抱歉，我无法完成')
  assert.equal(d, null, '不可解析必须返回 null（调用方据此降级）')
  const e = parseFacts('[{"predicate":"x"}] 以上是结果')
  assert.equal(e.length, 1, '带尾随说明也要能抠出来')
})

test('extractText：四家响应形状', () => {
  assert.equal(extractText({ choices: [{ message: { content: 'A' } }] }, 'openai'), 'A')
  assert.equal(extractText({ content: [{ type: 'text', text: 'B' }] }, 'anthropic'), 'B')
  assert.equal(extractText({ candidates: [{ content: { parts: [{ text: 'C' }] } }] }, 'google'), 'C')
  assert.equal(extractText({ message: { content: 'D' } }, 'ollama'), 'D')
  assert.equal(extractText({}, 'openai'), null)
})

test('LlmExtractor：成功路径返回清洗后的命题', async () => {
  const f = fakeFetch(() => ({
    status: 200,
    body: { choices: [{ message: { content: '[{"predicate":"prefers","object":"pnpm","valence":0.4,"salience":0.8}]' } }] },
  }))
  const x = new LlmExtractor({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'k', fetchImpl: f })
  const r = await x.extract({ text: '我更喜欢用 pnpm 而不是 npm' })
  assert.equal(r.length, 1)
  assert.equal(r[0].object, 'pnpm')
  assert.equal(r[0].valence, 0.4)
})

test('LlmExtractor：失败返回 null 而不是抛错（抽取是增强，不是前置）', async () => {
  const bad = fakeFetch(() => ({ status: 200, body: { choices: [{ message: { content: '我不知道' } }] } }))
  const x = new LlmExtractor({ provider: 'openai', model: 'gpt-4o-mini', fetchImpl: bad })
  assert.equal(await x.extract({ text: '这是一句足够长的话' }), null)
  assert.ok(x.error, '失败必须留下可读原因')

  const short = fakeFetch(() => ({ status: 200, body: {} }))
  const y = new LlmExtractor({ provider: 'openai', model: 'gpt-4o-mini', fetchImpl: short })
  assert.equal(await y.extract({ text: '嗯' }), null, '过短输入不该发起调用')
  assert.equal(short.calls.length, 0)
})

test('provider 预设表：端点、鉴权、能力边界都写清了', () => {
  for (const id of PROVIDER_IDS) {
    const p = PROVIDERS[id]
    assert.equal(p.id, id)
    assert.ok(p.label.length > 0)
    assert.ok(p.note.length > 10, `${id} 必须有边界说明`)
    assert.ok(p.chatPath || p.embedPath, `${id} 至少要有一个端点`)
  }
  assert.equal(PROVIDERS.deepseek.embedPath, null, 'DeepSeek 没有 embedding 端点，不能假装有')
  assert.equal(PROVIDERS.anthropic.embedPath, null)
  assert.ok(PROVIDERS.openai.embedPath)
  assert.equal(PROVIDERS.ollama.auth, 'none')
})

test('endpointOf / authHeaders / withQueryKey', () => {
  const gemini = resolveProvider('google')
  assert.match(endpointOf(gemini, 'chat', 'gemini-1.5-flash'), /models\/gemini-1\.5-flash:generateContent$/)
  const openai = resolveProvider('openai', 'https://proxy.test/v1/')
  assert.equal(endpointOf(openai, 'embed', 'x'), 'https://proxy.test/v1/embeddings', '末尾斜杠必须归一')
  assert.deepEqual(authHeaders(openai, 'k'), { Authorization: 'Bearer k' })
  assert.deepEqual(authHeaders(PROVIDERS.anthropic, 'k'), { 'x-api-key': 'k' })
  assert.deepEqual(authHeaders(PROVIDERS.ollama, ''), {}, '无密钥不是错误')
})

test('createEnginePorts：没有 embedding 端点时明确降级并留 note', () => {
  const r = createEnginePorts({ provider: 'deepseek', model: 'deepseek-chat', embeddingEnabled: true, extractEnabled: false })
  assert.equal(r.embedding, null, 'DeepSeek 不能给出真 embedding')
  assert.ok(r.notes.some((n) => n.includes('embedding')), `notes 应说明原因：${r.notes.join(' | ')}`)
  assert.ok(r.ports.tokenizer, '即使没有 embedding，tokenizer 也必须有')
})

test('tokenizer：按模型校准且单调（claude > gpt > deepseek），截断不越界', () => {
  const text = '我们的记忆库用 node:sqlite 内置模块，不引入第三方依赖。'
  const d = countWith(text, calibrationOf('cjk-ratio'))
  const g = countWith(text, calibrationOf('cl100k'))
  const c = countWith(text, calibrationOf('claude'))
  assert.ok(c > g && g > d, `系数必须单调：claude ${c} > gpt ${g} > deepseek ${d}`)

  const tk = createTokenizer({ kind: 'cl100k' })
  const cut = tk.truncate(text, 20)
  assert.ok(tk.count(cut) <= 20, `截断后必须 ≤ 20，实际 ${tk.count(cut)}`)
  assert.ok(text.startsWith(cut), '截断必须保留前缀')
  assert.equal(tk.truncate(text, 0), '')
})
