/**
 * 生成面板预览产物（不启动服务器）
 *
 * 做法：把编译产物 `packages/ui/lib/client` 原样搬到 `artifacts/panel/`，把两个
 * 裸模块名（`react` / `react/jsx-runtime`）改写成指向本地 shim 的相对路径，
 * shim 从 React 的 UMD 构建（window.React）取实现。
 *
 * 为什么不用打包器：本机 esbuild 读文件被拒（winapi #5），而"预览必须能跑"
 * 比"预览必须被打包"重要。这个方案还有个额外好处——预览跑的就是宿主里那份
 * 编译产物，不存在"预览用 A、上线用 B"。
 *
 *   node scripts/panel-build.mjs      # 只产出 artifacts/panel/
 *   node scripts/panel-dev.mjs 5178   # 产出 + 起静态服务器
 *
 * 之所以拆成两个脚本：`npm test` 里 `test/panel-bundle.test.mjs` 要直接 import
 * 这份产物，CI 里不能起一个不退出的服务器。于是构建与伺服分离。
 */
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 构建面板产物。返回输出目录。 */
export function buildPanel(root = process.cwd()) {
  const outDir = join(root, 'artifacts', 'panel')
  const snapshotPath = join(root, 'artifacts', 'panel-snapshot.json')

  if (!existsSync(snapshotPath)) {
    throw new Error('缺少 artifacts/panel-snapshot.json，先跑 `npm run demo`')
  }
  const clientDir = join(root, 'packages', 'ui', 'lib', 'client')
  if (!existsSync(clientDir)) {
    throw new Error('缺少 packages/ui/lib/client，先跑 `npm run build`')
  }

  mkdirSync(outDir, { recursive: true })
  cpSync(clientDir, join(outDir, 'client'), { recursive: true })
  mkdirSync(join(outDir, 'vendor'), { recursive: true })
  for (const [from, to] of [
    ['node_modules/react/umd/react.production.min.js', 'vendor/react.js'],
    ['node_modules/react-dom/umd/react-dom.production.min.js', 'vendor/react-dom.js'],
  ]) {
    cpSync(join(root, from), join(outDir, to))
  }

  // ── shim：从 UMD 全局取 React，暴露 ESM 形状 ─────────────────────
  writeFileSync(
    join(outDir, 'vendor', 'react-shim.js'),
    `const R = window.React
export const createElement = R.createElement
export const Fragment = R.Fragment
export const StrictMode = R.StrictMode
export const useState = R.useState
export const useEffect = R.useEffect
export const useMemo = R.useMemo
export const useRef = R.useRef
export const useCallback = R.useCallback
export const useReducer = R.useReducer
export const useLayoutEffect = R.useLayoutEffect
export default R
`,
    'utf8',
  )

  writeFileSync(
    join(outDir, 'vendor', 'jsx-shim.js'),
    `const R = window.React
function split(props) {
  const { children, ...rest } = props || {}
  return [rest, children === undefined ? [] : [].concat(children)]
}
export const Fragment = R.Fragment
export function jsx(type, props, key) {
  const [rest, kids] = split(props)
  if (key !== undefined) rest.key = key
  return R.createElement(type, rest, ...kids)
}
export const jsxs = jsx
export const jsxDEV = jsx
export default { jsx, jsxs, Fragment }
`,
    'utf8',
  )

  writeFileSync(join(outDir, 'vendor', 'empty.js'), 'export {}\n', 'utf8')

  // ── 改写裸模块名（按文件深度算相对路径）─────────────────────────
  const files = []
  const walk = (dir, depth) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full, depth + 1)
      else if (entry.endsWith('.js') && !entry.endsWith('.map')) files.push({ full, depth })
    }
  }
  walk(join(outDir, 'client'), 0)

  for (const f of files) {
    const rel = '../'.repeat(f.depth + 1) + 'vendor/'
    let src = readFileSync(f.full, 'utf8')
    src = src.replace(/from\s*["']react\/jsx-runtime["']/g, `from "${rel}jsx-shim.js"`)
    src = src.replace(/from\s*["']react["']/g, `from "${rel}react-shim.js"`)
    // client 侧只用到类型，理论上不会有这条运行时导入；有的话指向空模块兜底
    src = src.replace(/from\s*["']@bcf\/dsh-mnemo-core["']/g, `from "${rel}empty.js"`)
    writeFileSync(f.full, src, 'utf8')
  }

  const snapshot = readFileSync(snapshotPath, 'utf8')
  writeFileSync(
    join(outDir, 'index.html'),
    `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MnemoVault · 记忆面板预览</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f1115; overflow: hidden; }
  body { display: grid; place-items: center; font: 13px/1.5 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .frame { width: min(420px, 100vw); min-width: 0; max-width: 100vw; height: min(780px, 100vh); background: #fff; border-radius: 12px; overflow: hidden;
           box-shadow: 0 20px 60px rgba(0,0,0,.45); display: flex; flex-direction: column; position: relative; }
  #root { flex: 1; min-height: 0; display: flex; }
  #root > .mnv-root { flex: 1; }
  @media (prefers-color-scheme: dark) { .frame { background: #14171c; } }
</style>
</head>
<body>
  <div class="frame"><div id="root"></div></div>
  <script src="./vendor/react.js"></script>
  <script src="./vendor/react-dom.js"></script>
  <script>window.__MNEMO_SNAPSHOT__ = ${snapshot};</script>
  <script type="module">
    import { createElement } from './vendor/react-shim.js'
    const { MnemoPanel } = await import('./client/Panel.js')
    const { createDemoSource } = await import('./client/data.js')
    const root = window.ReactDOM.createRoot(document.getElementById('root'))
    root.render(createElement(MnemoPanel, {
      source: createDemoSource(window.__MNEMO_SNAPSHOT__),
      pageSize: 50,
      graphMaxNodes: 200,
      initialTab: (location.hash || '#overview').slice(1),
      affectEnabled: true,
      ignition: 0.42,
      runCommand: (line) => '（预览模式）已执行 /mnemo ' + line + '；真实命令面在宿主内生效。',
    }))
  </script>
</body>
</html>`,
    'utf8',
  )

  return outDir
}

// 直接 `node scripts/panel-build.mjs` 时才执行；被 import 时只导出 buildPanel
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  try {
    const out = buildPanel()
    console.log(`panel bundle → ${out}`)
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
