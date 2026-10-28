/**
 * 按依赖顺序编译各包。没有 bundler：每个包都是普通 ESM + tsc 产物，
 * 这样 `lib/` 可以逐包发布，也让"哪个包编译失败"一眼可见。
 */
import { spawnSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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
  console.log('ok')
}
process.exit(failed ? 1 : 0)
