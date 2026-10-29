/**
 * 接线回归：L1 端口形状、命令面探测、remote 数据面。
 *
 * 这三块在 v0.2 里都是"接口就绪、实机未验证"。未验证的代码最容易在 rc 升级时静默失效，
 * 所以这里用**假的宿主形状**把它们逐个钉住：认不出就必须降级，认出就必须能跑通。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHarness } from '@rain13sad/dsh-mnemo-devkit'
import { Context } from '@deepseek-ai/cordis'
import { fromHostLlm, normalizeLlmOutput, parseLlmPropositions, probeLlmPort, segmentWithPort } from '../packages/encoder/lib/l1.js'
import { attachCommandFace } from '../packages/tools/lib/bridge.js'

const PROPS = '[{"text":"用户偏好深色主题","agent":"用户","pred":"prefers"}]'

test('fromHostLlm：识别 chat({messages}) 并归一 OpenAI 风格返回', async () => {
  const port = fromHostLlm({
    chat: async (req) => {
      assert.ok(Array.isArray(req.messages), 'chat 形状必须传 messages')
      return { choices: [{ message: { content: PROPS } }] }
    },
  })
  assert.ok(port)
  assert.equal(port.entry, 'chat')
  assert.equal(port.shape, 'messages')
  const props = await segmentWithPort('我偏好深色主题', port)
  assert.equal(props.length, 1)
  assert.equal(props[0].text, '用户偏好深色主题')
})

test('fromHostLlm：识别 complete(prompt) 并处理 {text} / {content:[…]}', async () => {
  const a = fromHostLlm({ complete: async () => ({ text: PROPS }) })
  assert.equal(a.entry, 'complete')
  assert.equal((await a.complete('x')).trim(), PROPS)

  const b = fromHostLlm({ generate: async () => ({ content: [{ type: 'text', text: PROPS }] }) })
  assert.equal(b.entry, 'generate')
  assert.equal((await b.complete('x')).trim(), PROPS)
})

test('fromHostLlm：识别嵌套在 client 下的入口', () => {
  const port = fromHostLlm({ client: { invoke: async () => PROPS } })
  assert.ok(port)
  assert.equal(port.entry, 'client.invoke')
})

test('fromHostLlm：流式（async iterable）也能拼成文本', async () => {
  async function* stream() {
    yield { delta: '[{"text":"用 pnpm' }
    yield { delta: ' 构建"}]' }
  }
  const text = await normalizeLlmOutput(stream())
  assert.ok(text.includes('pnpm'), text)
  const props = parseLlmPropositions(text)
  assert.equal(props.length, 1)
})

test('fromHostLlm：一个入口都没有就返回 null（不做猜测性调用）', () => {
  assert.equal(fromHostLlm({}), null)
  assert.equal(fromHostLlm(null), null)
  assert.equal(fromHostLlm({ foo: 1 }), null)
})

test('probeLlmPort：失败不抛错，只把结论写进 note', async () => {
  const bad = await probeLlmPort({ available: () => true, complete: async () => { throw new Error('401 unauthorized') } })
  assert.equal(bad.ok, false)
  assert.match(bad.note, /401|自检失败/)

  const good = await probeLlmPort({ available: () => true, complete: async () => PROPS })
  assert.equal(good.ok, true)
  assert.ok(good.ms >= 0)

  const none = await probeLlmPort(null)
  assert.equal(none.ok, false)
})

test('host 侧提供了 mnemoRemote / mnemoCommands / mnemoSnapshot 三个面', async () => {
  const h = await createHarness({ sessionId: 'bridge' })
  const remote = h.ctx.get('mnemoRemote')
  const cmds = h.ctx.get('mnemoCommands')
  const snap = h.ctx.get('mnemoSnapshot')
  assert.ok(remote?.snapshot, 'mnemoRemote 必须提供 snapshot()')
  assert.ok(cmds?.run, 'mnemoCommands 必须提供 run()')
  assert.ok(snap?.get, 'mnemoSnapshot 必须提供 get()')

  await h.turn('我偏好深色主题，部署脚本统一用 pnpm。')
  const s = await remote.snapshot()
  assert.ok(s.cells.length > 0)
  assert.equal(s.runtime?.remoteFace, true)
  assert.ok(Array.isArray(s.runtime?.tools) && s.runtime.tools.includes('memory_recall'))

  // 面板动作走同一条 applyAction，不需要经过 remote 注册表
  const cell = s.cells[0]
  const r = await remote.act({ kind: 'pin', cellId: cell.cellId, pinned: true })
  assert.equal(r.ok, true)
  const s2 = await remote.snapshot()
  assert.equal(s2.cells.find((c) => c.cellId === cell.cellId)?.pinned, true)

  // 命令桥与 /mnemo 命令共用 runCommand
  const out = await cmds.run('stats')
  assert.match(out, /cell/)
  await h.dispose()
})

test('命令面：识别 command().command().description().action() 链式形状', async () => {
  const ctx = new Context()
  const calls = []
  const chain = {
    command(name) {
      return {
        command(spec) {
          return {
            description(d) {
              calls.push(['desc', d])
              return { action(fn) { calls.push(['action', typeof fn]) } }
            },
          }
        },
      }
    },
  }
  ctx.provide('cmdline', chain)
  const face = attachCommandFace(ctx, async (argv) => argv.join(' '))
  assert.equal(face, 'cmdline')
  assert.ok(calls.some(([k]) => k === 'action'))
})

test('命令面：只有 register() 的宿主也能接上，全无则返回 none', async () => {
  const ctx = new Context()
  let registered = null
  ctx.provide('cmdline', { register: (def) => { registered = def } })
  assert.equal(attachCommandFace(ctx, async () => ''), 'cmdline')
  assert.equal(registered.name, 'mnemo')

  const empty = new Context()
  assert.equal(attachCommandFace(empty, async () => ''), 'none')
})
