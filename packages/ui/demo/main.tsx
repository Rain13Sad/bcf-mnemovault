/**
 * 面板独立预览入口（不属于插件包，只用于开发时看效果）。
 *
 * 它 import 的是**编译产物** lib/client/*，所以这里看到的就是宿主里跑的那份代码，
 * 不存在"预览用了一套、上线用另一套"的问题。
 */
import { createElement as h, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MnemoPanel } from '../lib/client/Panel.js'
import { createDemoSource, createRemoteSource } from '../lib/client/data.js'

declare const window: Window & {
  __MNEMO_SNAPSHOT__?: unknown
  __MNEMO_REMOTE__?: unknown
}

const snap = window.__MNEMO_SNAPSHOT__
if (!snap) {
  document.body.innerHTML = '<pre style="padding:20px;font:13px ui-monospace">缺少 __MNEMO_SNAPSHOT__：先跑 npm run demo</pre>'
} else {
  const source = window.__MNEMO_REMOTE__
    ? createRemoteSource(window.__MNEMO_REMOTE__ as never)
    : createDemoSource(snap as never)

  const root = createRoot(document.getElementById('root')!)
  root.render(
    h(
      StrictMode,
      null,
      h(MnemoPanel, {
        source,
        pageSize: 50,
        graphMaxNodes: 200,
        initialTab: 'timeline',
        affectEnabled: true,
        ignition: 0.42,
        runCommand: (line: string) => `（预览模式）已执行 /mnemo ${line}，真实命令面在宿主内生效。`,
      }),
    ),
  )
}
