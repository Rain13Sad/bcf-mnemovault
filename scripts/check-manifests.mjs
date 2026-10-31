/**
 * 组合包契约检查（v0.5.3）
 *
 * ── 这个脚本为什么存在 ────────────────────────────────────────────
 * v0.5.2 有四个"看起来装上了、其实一行都没加载"的包，每一个都能通过
 * build + 176 个单测 + CI：
 *
 *   · `ui`      声明了 `dsh.client` 却**没有** `dsh.bundle`
 *               → 插件管理器直接拒绝："这个包没有声明组合包，不能作为插件管理"
 *   · `devkit`  不是插件（只导出 `createHarness`），却声明了 `dsh.bundle`
 *               → 真装上去会把一个没有 `apply` 的模块当插件加载
 *   · `devkit` / `proactive` / `ui`  声明了 `dsh.bundle.patch`，**文件不存在**
 *               → DSH 装它时报 ENOENT，跳过整层
 *   · `core`    的 patch 里写了 `!!js` 表达式
 *               → 安装期 YAML 解析器不认自定义标签，整个安装被回滚
 *
 * 这四类问题的共同点：**它们都不在运行时暴露，只在"真的装一次"时暴露**。
 * 所以门禁必须检查的是**清单与磁盘的一致性**，而不是代码行为。
 *
 *   node scripts/check-manifests.mjs
 *
 * 检查项（任何一项失败即退出码 1）：
 *   ① 版本与根一致；兄弟包依赖范围是 `^<version>`
 *   ② `dsh.bundle.patch` 指向的文件必须存在、且在 `files` 白名单里
 *   ③ 声明了 `dsh.bundle` 的包，其 `lib/index.js` 必须导出 `apply` 函数与 `name` 字符串
 *   ④ 未声明 `dsh.bundle` 的包不得出现在 patch 的 insert 行里当宿主行
 *      （反过来：patch 里出现的每个包名，必须是本包的依赖或本包自己）
 *   ⑤ patch 里不得出现 `!!js`（安装期解析不了）、不得有制表符
 *   ⑥ 声明了 `dsh.client` 的包必须有 `lib/client.js`，且 `files` 覆盖它
 *   ⑦ 每个 patch 的 insert 行 id 全局唯一（同一 id 被两个包插入 = 加载期重复行）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.cwd()
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const rootPkg = read(join(root, 'package.json'))
const version = rootPkg.version
const problems = []
const notes = []

const dirs = readdirSync(join(root, 'packages')).filter((d) => existsSync(join(root, 'packages', d, 'package.json')))
const pkgs = dirs.map((d) => ({ dir: d, path: join(root, 'packages', d), pkg: read(join(root, 'packages', d, 'package.json')) }))
const siblingNames = new Set(pkgs.map((p) => p.pkg.name))

/** 极简 patch 读取：只取 `- id: x` / `name: 'y'` 两列，够做一致性检查。 */
function rowsOf(text) {
  const rows = []
  let cur = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const id = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id) {
      cur = { id: id[1] }
      rows.push(cur)
      continue
    }
    const nm = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (nm && cur) cur.name = nm[1]
  }
  return rows
}

const rowOwner = new Map()

for (const { dir, path, pkg } of pkgs) {
  // ① 版本
  if (pkg.version !== version) problems.push(`${dir}: 版本 ${pkg.version} ≠ 根 ${version}`)
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (!siblingNames.has(name)) continue
      if (field !== 'dependencies') continue
      if (range !== `^${version}`) problems.push(`${dir}: ${field}.${name} = "${range}"，应为 "^${version}"`)
    }
  }

  const bundle = pkg.dsh?.bundle
  const client = pkg.dsh?.client
  const files = pkg.files ?? []
  const covers = (rel) => files.some((f) => f === rel || f === rel.split('/')[0] || rel.startsWith(`${f}/`))

  // ② / ⑤ patch 文件
  let patchText
  if (bundle !== undefined) {
    const patches = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
    if (!Array.isArray(patches) || patches.length === 0 || !patches.every((p) => typeof p === 'string')) {
      problems.push(`${dir}: dsh.bundle.patch 必须是文件路径或路径数组`)
    } else {
      for (const rel of patches) {
        const abs = join(path, rel)
        if (!existsSync(abs)) {
          problems.push(`${dir}: dsh.bundle.patch 指向的 ${rel} 不存在（DSH 会 ENOENT 并跳过整层）`)
          continue
        }
        if (!covers(rel.replace(/^\.\//, ''))) problems.push(`${dir}: ${rel} 不在 files 白名单里，发布后缺失`)
        const raw = readFileSync(abs, 'utf8')
        // 注释里可以自由讨论 `!!js`（我们的 patch 就是这么写的），所以先剥掉整行注释再检查。
        // YAML 的注释行是唯一允许出现 tab 的地方，一并跳过。
        const text = raw
          .split(/\r?\n/)
          .filter((l) => !l.trimStart().startsWith('#'))
          .join('\n')
        if (text.includes('!!js')) {
          problems.push(`${dir}: ${rel} 含 !!js —— DSH 安装期 YAML 解析器不认该标签，安装会被回滚`)
        }
        if (text.includes('\t')) problems.push(`${dir}: ${rel} 含制表符（YAML 不允许 tab 缩进）`)
        if (!text.trim()) problems.push(`${dir}: ${rel} 是空文件`)
        if (patchText === undefined) patchText = text
        else patchText += '\n' + text
      }
    }
  }

  // ③ bundle 必须是真插件
  const mainRel = typeof pkg.main === 'string' ? pkg.main : './lib/index.js'
  const mainAbs = join(path, mainRel)
  if (bundle !== undefined) {
    if (!existsSync(mainAbs)) {
      problems.push(`${dir}: 声明了 dsh.bundle 但 ${mainRel} 不存在（先 npm run build）`)
    } else {
      const mod = await import(pathToFileURL(mainAbs).href).catch((err) => {
        problems.push(`${dir}: 加载 ${mainRel} 失败：${String(err?.message ?? err)}`)
        return undefined
      })
      if (mod) {
        if (typeof mod.apply !== 'function') problems.push(`${dir}: 声明了 dsh.bundle，但 lib/index.js 没有导出 apply()——不是 Cordis 插件`)
        if (typeof mod.name !== 'string' || mod.name.length === 0) problems.push(`${dir}: lib/index.js 没有导出 name`)
      }
    }
  }

  // ⑥ client
  if (client !== undefined) {
    const clientRel = pkg.exports?.['./client']?.default ?? './lib/client.js'
    if (!existsSync(join(path, clientRel))) problems.push(`${dir}: 声明了 dsh.client 但 ${clientRel} 不存在`)
    else if (!covers(clientRel.replace(/^\.\//, ''))) problems.push(`${dir}: ${clientRel} 不在 files 白名单里`)
    if (!Array.isArray(client.inject) || client.inject.length === 0) problems.push(`${dir}: dsh.client.inject 必须是非空数组`)
  }

  // ④ 行归属 + ⑦ id 唯一
  if (patchText) {
    const allowed = new Set([pkg.name, ...Object.keys(pkg.dependencies ?? {})])
    for (const row of rowsOf(patchText)) {
      if (!row.id) continue
      if (!row.name) {
        problems.push(`${dir}: 行 ${row.id} 没有 name`)
        continue
      }
      if (!allowed.has(row.name)) {
        problems.push(`${dir}: 行 ${row.id} 插入 ${row.name}，但它既不是本包也不是本包的依赖（装上去会解析失败）`)
      }
      if (rowOwner.has(row.id)) problems.push(`行 id "${row.id}" 被 ${rowOwner.get(row.id)} 与 ${dir} 同时插入（加载期会出现重复行）`)
      else rowOwner.set(row.id, dir)
    }
  }
}

for (const n of notes) console.log(`info  ${n}`)
if (problems.length) {
  console.error(`\n${problems.length} 项组合包契约问题：`)
  for (const p of problems) console.error(`  FAIL  ${p}`)
  console.error('\n这些问题的共同点是"构建与单测都过、只有真的装一次才暴露"。')
  process.exit(1)
}
console.log(`ok    ${pkgs.length} 个包的组合包契约一致（v${version}）：bundle/patch/client/行归属全部对齐`)
