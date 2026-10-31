/**
 * client 入口契约（v0.5.3）
 *
 * 这个测试存在的理由：面板在宿主里"能不能出现"取决于一个**格式契约**，
 * 而它不在任何纯函数单测的覆盖范围里。
 *
 * 宿主（`@deepseek-ai/dsh-client-modules`）对 `exports["./client"]` 的处理是：
 *   1. 只伺服**一个文件**到 `/plugins/<id>/client.js`
 *   2. 浏览器里由内核 `import()` 它
 *   3. 该文件必须调用 `window.__ModuleLoader__.load({ id, factory })`
 *   4. `factory(require)` 返回的命名空间就是插件：要有 `apply` / `inject`
 *
 * v0.5.2 的 ui 包四条全不满足（文件不存在 + 普通 ESM + 相对导入 + 没有 load 调用），
 * 但 `npm test` 全绿——因为它测的是 `lib/client/Panel.js`，那是另一条路。
 *
 * 所以这里用**假的内核**把真产物跑一遍：不给 `import`，只给 `__ModuleLoader__` 和 `require`。
 * 它跑得通，宿主里就跑得通。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundlePath = join(root, 'packages', 'ui', 'lib', 'client.js')
const require = createRequire(import.meta.url)

/** 假内核：只认 `window.__ModuleLoader__.load`，别的一概没有。 */
function loadInFakeKernel() {
  assert.ok(existsSync(bundlePath), `缺少 ${bundlePath}——先 npm run build`)
  const code = readFileSync(bundlePath, 'utf8')

  const React = require('react')
  const jsxRuntime = {
    Fragment: React.Fragment,
    jsx(type, props, key) {
      const { children, ...rest } = props ?? {}
      if (key !== undefined) rest.key = key
      return React.createElement(type, rest, ...(children === undefined ? [] : [].concat(children)))
    },
    jsxs(type, props, key) {
      return jsxRuntime.jsx(type, props, key)
    },
  }

  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => void (captured = def) } },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)

  assert.ok(captured, 'client.js 没有调用 window.__ModuleLoader__.load()——宿主里它会被当成死模块')
  assert.equal(captured.id, '@rain13sad/dsh-mnemo-ui', 'load() 的 id 必须是包名')

  const mod = captured.factory((spec) => {
    if (spec === 'react') return React
    if (spec === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`bundle 请求了未声明的外部模块：${spec}`)
  })
  return mod
}

test('client bundle 以宿主认识的 __ModuleLoader__ 形状加载', () => {
  const mod = loadInFakeKernel()
  assert.equal(typeof mod.apply, 'function', 'factory 返回的命名空间必须有 apply')
  assert.equal(mod.name, 'mnemo-ui')
  // 注意：数组来自另一个 vm realm，原型不是本 realm 的 Array.prototype，
  // deepStrictEqual 会因"结构相同但引用不等"而失败，所以先摊平成本地数组。
  assert.deepEqual([...mod.inject], ['slots', 'layout'])
  assert.equal(mod.PANEL_ID, 'mnemo')
})

test('client apply 注册主面板与侧栏入口，并把 disposer 交给 ctx.effect', () => {
  const mod = loadInFakeKernel()
  const registered = []
  const effects = []
  const ctx = {
    effect(fn, label) {
      effects.push(label)
      const dispose = fn()
      return () => dispose?.()
    },
    slots: {
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    layout: { selectPanel() {} },
    logger: () => ({ info() {}, warn() {} }),
  }

  mod.apply(ctx, mod.defaultConfig)

  const names = registered.map((r) => r.options.name)
  assert.deepEqual(names, ['main', 'sidebar.panellist'], '必须同时注册主面板与侧栏图标，否则面板没有入口')
  assert.equal(registered[0].options.key, 'mnemo', 'main 槽是 keyed，key 必须等于 PANEL_ID')
  assert.equal(registered[1].options.id, 'mnemo', '侧栏 id 必须与 main key 对齐，否则点图标打不开面板')
  assert.ok(effects.length >= 2, '两个注册都必须包在 ctx.effect 里，否则热重载后残留')
})

test('bundle 不引用未声明的外部模块', () => {
  // 只允许 react 家族：其余裸模块（尤其是 @rain13sad/*）会被 require 抛错，
  // 而那条错误在浏览器里只表现为"面板不出现"。
  const code = readFileSync(bundlePath, 'utf8')
  const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
  const foreign = required.filter((s) => s !== 'react' && s !== 'react/jsx-runtime' && !s.startsWith('react/'))
  assert.deepEqual([...new Set(foreign)], [], `bundle 里有未声明的外部依赖：${foreign.join(', ')}`)
})
