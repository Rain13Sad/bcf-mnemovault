/**
 * 发布前门禁：版本一致性 + lockfile 同步
 *
 * ── 这个脚本为什么存在 ───────────────────────────────────────────
 * v0.3.0 把 10 个包的 version 升到 0.3.0，但 8 个 package.json 里对兄弟包的依赖
 * 还写着 `^0.2.0`。semver 里 `^0.2.0` = `>=0.2.0 <0.3.0`，于是：
 *   · `npm ci` 直接失败（lockfile 与 package.json 不匹配）
 *   · `npm install` 会从 registry 拉真正的 0.2.0 副本装进各子包，
 *     affect/consolidator 就近解析到旧 core → 编译报 TS2339
 *   · 真发出去的话，装 0.3.0 encoder 的人会拿到不兼容的 0.2.0 core
 *
 * 一个 8 处字符串替换的问题让整个版本不可用，说明缺的不是能力，是**门禁**。
 * 这个脚本把三件事变成会失败的断言：
 *   1. 根与 10 个子包的 version 完全一致
 *   2. 每个包对兄弟包的依赖范围恰好是 `^<同一个版本>`
 *   3. package-lock.json 里的 workspace 版本与之同步
 *
 *   node scripts/ci-check-publish.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))

const problems = []
const notes = []

const rootPkg = read(join(root, 'package.json'))
const version = rootPkg.version
notes.push(`目标版本 ${version}`)

const dirs = readdirSync(join(root, 'packages')).filter((d) => existsSync(join(root, 'packages', d, 'package.json')))
const pkgs = dirs.map((d) => ({ dir: d, pkg: read(join(root, 'packages', d, 'package.json')) }))

// ① 版本一致
for (const { dir, pkg } of pkgs) {
  if (pkg.version !== version) problems.push(`packages/${dir} 版本 ${pkg.version} ≠ 根 ${version}`)
}

// ② 兄弟包依赖范围必须是 ^<同版本>
const siblingNames = new Set(pkgs.map((p) => p.pkg.name))
for (const { dir, pkg } of pkgs) {
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!siblingNames.has(name)) continue
      const expect = `^${version}`
      if (range !== expect) {
        problems.push(`packages/${dir} 的 ${field}.${name} 是 "${range}"，应为 "${expect}"`)
      }
    }
  }
}

// ③ lockfile 同步
const lockPath = join(root, 'package-lock.json')
if (!existsSync(lockPath)) {
  problems.push('缺少 package-lock.json')
} else {
  const lock = read(lockPath)
  if (lock.version !== version) problems.push(`package-lock.json 顶层 version ${lock.version} ≠ ${version}`)
  const ws = lock.packages ?? {}
  if (ws['']?.version !== version) problems.push(`lockfile 根节点 version ${ws['']?.version} ≠ ${version}`)
  for (const { dir, pkg } of pkgs) {
    const key = `packages/${dir}`
    const entry = ws[key]
    if (!entry) {
      problems.push(`lockfile 缺少 ${key}（需要重新生成）`)
      continue
    }
    if (entry.version !== version) problems.push(`lockfile ${key} version ${entry.version} ≠ ${version}`)
    for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!siblingNames.has(name)) continue
      const locked = entry.dependencies?.[name]
      if (locked !== range) problems.push(`lockfile ${key} 的依赖 ${name} 是 "${locked}"，package.json 是 "${range}"`)
    }
  }
}

/**
 * ④ lockfile 平台中立性（v0.5）。
 *
 * v0.4 的 lockfile 只记录了 esbuild 的 `@esbuild/win32-x64` 一个平台包——
 * npm 10 不校验，**npm 11 直接 `npm ci` 失败**。而 esbuild 其实从没被用过
 * （panel-build 不用打包器），所以 v0.5 直接把它从 devDependencies 删掉。
 * 这条检查防止下次有人再引入一个原生依赖而没意识到发布矩阵会崩。
 */
const NATIVE_DEPS = ['esbuild', 'sharp', 'fsevents', '@swc/core', 'node-gyp', 'canvas', 'bcrypt']
const allDeps = { ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) }
for (const name of NATIVE_DEPS) {
  if (allDeps[name]) {
    problems.push(`根依赖里有原生/平台相关包 "${name}"：lockfile 会只锁当前平台，npm ≥11 在其它平台会 npm ci 失败`)
  }
}
if (existsSync(lockPath)) {
  const lock = read(lockPath)
  const platformPinned = Object.entries(lock.packages ?? {}).filter(
    ([k, v]) => k && (v?.os || v?.cpu) && !k.includes('node_modules/@types/'),
  )
  if (platformPinned.length > 0) {
    const names = platformPinned.map(([k]) => k.replace('node_modules/', '')).slice(0, 6)
    problems.push(`lockfile 里有 ${platformPinned.length} 个平台限定包（${names.join(', ')}…）：跨平台 npm ci 会失败`)
  } else {
    notes.push('lockfile 平台中立（无 os/cpu 限定条目）')
  }
}

for (const n of notes) console.log(`info  ${n}`)
if (problems.length) {
  console.error(`\n${problems.length} 项不一致：`)
  for (const p of problems) console.error(`  FAIL  ${p}`)
  console.error('\n修法：把版本与兄弟包依赖一起改，然后 `rm -rf node_modules package-lock.json && npm install`，')
  console.error('再在一个干净目录里跑一遍 `npm ci && npm run build`——这一步是 v0.3.0 漏掉的那一步。')
  process.exit(1)
}
console.log(`ok    ${pkgs.length} 个包的版本与兄弟依赖一致（${version}）`)
console.log('ok    package-lock.json 已同步')
