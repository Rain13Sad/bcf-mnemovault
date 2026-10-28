/**
 * 校验"改写后的 client 产物"真的能在浏览器语义下加载：
 * 用 window.React 作为全局（模拟 UMD），再 import 改写过的 ESM。
 * 这一步覆盖的是预览链路本身（shim + 相对路径改写），不是业务逻辑。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const req = createRequire(import.meta.url)
globalThis.window = { React: req('react') }

const { MnemoPanel } = await import('../artifacts/panel/client/Panel.js')
const { renderToStaticMarkup } = req('react-dom/server')
const { createElement } = req('react')

const snap = JSON.parse(readFileSync('artifacts/panel-snapshot.json', 'utf8'))
const source = {
  kind: 'demo',
  writable: true,
  load: async () => snap,
  act: async () => ({ ok: true, message: 'ok' }),
  subscribe: () => () => {},
  dispose() {},
}

const html = renderToStaticMarkup(
  createElement(MnemoPanel, {
    source,
    pageSize: 50,
    graphMaxNodes: 200,
    initialTab: 'timeline',
    affectEnabled: true,
    ignition: 0.42,
  }),
)
console.log('rendered chars', html.length, 'root:', html.includes('mnv-root'))
// SSR 不会等 useEffect 里的异步 load()，所以这里只能看到首屏骨架。
// 这恰好是要断言的东西：**改写后的模块能被加载并渲染出骨架**；
// 数据态由 panel-ssr.test.mjs 用纯组件覆盖。
if (!html.includes('mnv-root') || !html.includes('正在读取记忆库')) {
  console.error('FAIL: 改写后的 client 产物没有渲染出面板骨架')
  console.error(html.slice(0, 200))
  process.exit(1)
}
console.log('client bundle path ok')
