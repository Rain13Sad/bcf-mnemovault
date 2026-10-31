/**
 * 按依赖顺序编译各包。
 *
 * 每个包都是普通 ESM + tsc 产物（`lib/` 可以逐包发布，也让"哪个包编译失败"一眼可见），
 * 唯一的例外是 **ui 的 client 入口**：宿主只伺服单个 `client.js`，且它必须是
 * `window.__ModuleLoader__.load({...})` 的形状（见 `scripts/client-build.mjs` 顶部的长注释）。
 * 所以 tsc 之后再跑一步"折包"，把 `lib/client/**` 折成 `lib/client.js`。
 *
 *   node scripts/build.mjs
 *   node scripts/build.mjs --clean
 */
import { spawnSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeClientBundle } from './client-build.mjs'

const order = ['core', 'affect', 'encoder', 'recall', 'consolidator', 'proactive', 'tools', 'settings', 'devkit', 'ui']
const clean = process.argv.includes('--clean')
const root = process.cwd()
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

if (clean) {
  for (const p of order) rmSync(join(root, 'packages', p, 'lib'), { recursive: true, force: true })
  console.log('cleaned')
  process.exit(0)
}

let failed = false
for (const p of order) {
  const dir = join(root, 'packages', p)
  if (!existsSync(join(dir, 'tsconfig.json'))) continue
  process.stdout.write(`build ${p} ... `)
  const r = spawnSync(process.execPath, [tsc, '-p', dir], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.log('FAILED')
    console.log(r.stdout || '')
    console.log(r.stderr || '')
    failed = true
    break
  }
  if (p === 'ui') {
    // client 入口折包：失败必须让构建失败，否则发布出去的是一个"装了但面板不出现"的包
    try {
      const { modules, bytes } = writeClientBundle(dir)
      console.log(`ok (client bundle: ${modules.length} modules, ${Math.round(bytes / 1024)} KB)`)
      continue
    } catch (err) {
      console.log('CLIENT BUNDLE FAILED')
      console.log(err instanceof Error ? err.message : String(err))
      failed = true
      break
    }
  }
  console.log('ok')
}
process.exit(failed ? 1 : 0)
