/**
 * README 数字校验（v0.5.1 新增）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * 一次外部评审把五份 README 逐条核对后，发现**同一个事实最多有四个值**：
 * 代码规模 4 套说法、Node 版本 4 个答案、测试数 3 个数、缺点条数 4 个数，
 * 还有一句"零运行时依赖"与 8 个包里的 `import z from '@deepseek-ai/schemastery'` 直接矛盾。
 *
 * 根因不是"写错了"，而是**这些数字是手写死的**：只要还在手维护，下个版本还会再漂一次。
 * 这个脚本把"文档里的数字"变成"会失败的断言"。
 *
 *   node scripts/check-readme.mjs                # 全量（会跑一次测试拿真实条数）
 *   node scripts/check-readme.mjs --no-tests     # 跳过跑测试（CI 里已跑过可用）
 *
 * 口径（写进 README 的同一口径）：
 *   · 源文件 = packages/<pkg>/src 下的 .ts + .tsx
 *   · 行数   = 上面这些文件的总行数，README 里写"约 N 行"，允许 ±2%
 *   · 测试   = `node --test test/*.test.mjs` 输出的 `# tests N`
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const withTests = !args.includes('--no-tests')
const root = process.cwd()
const problems = []
const notes = []

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

// ── 真实值 ────────────────────────────────────────────────────────
const pkgDirs = readdirSync(join(root, 'packages')).filter((d) => existsSync(join(root, 'packages', d, 'src')))
const srcFiles = pkgDirs.flatMap((d) => walk(join(root, 'packages', d, 'src')))
const srcLines = srcFiles.reduce((n, f) => n + readFileSync(f, 'utf8').split('\n').length, 0)
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = rootPkg.version
const nodeMin = String(rootPkg.engines?.node ?? '').replace(/^[>=^~\s]+/, '')
const nodeMM = nodeMin.split('.').slice(0, 2).join('.')

let testCount = null
if (withTests) {
  const r = spawnSync(process.execPath, ['--test', 'test/*.test.mjs'], { encoding: 'utf8', shell: false, cwd: root })
  const m = /^# tests (\d+)$/m.exec(`${r.stdout ?? ''}\n${r.stderr ?? ''}`)
  if (m) testCount = Number(m[1])
  else problems.push('跑测试拿不到 `# tests N`（先 `npm run build && npm test` 确认基线）')
}

const guide = readFileSync(join(root, 'docs', 'PROJECT-GUIDE.md'), 'utf8')
const dCount = (guide.match(/^\*\*D\d+｜/gm) ?? []).length

notes.push(`真实值：${srcFiles.length} 个源文件 / ${srcLines} 行 / ${testCount ?? '?'} 条测试 / Node ≥${nodeMin} / 缺点 ${dCount} 条 / v${version}`)

// ── 断言 ──────────────────────────────────────────────────────────
const readme = (f) => readFileSync(join(root, f), 'utf8')
const must = (file, cond, msg) => {
  if (!cond) problems.push(`${file}: ${msg}`)
}

const LANGS = ['README.md', 'README.zh-CN.md', 'README.ja.md', 'README.ko.md', 'README.es.md']

for (const f of LANGS) {
  if (!existsSync(join(root, f))) continue
  const txt = readme(f)

  // ① DOC-VERSION 必须等于 package.json
  const dv = /<!--\s*DOC-VERSION:\s*([0-9.]+)\s*-->/.exec(txt)
  must(f, Boolean(dv), '缺少 <!-- DOC-VERSION: x.y.z --> 标记')
  if (dv) must(f, dv[1] === version, `DOC-VERSION ${dv[1]} ≠ package.json ${version}`)

  // ② 必须有 H1（npm 页面与屏幕阅读器都靠它）
  must(f, /^# \S/m.test(txt), '缺少 H1 标题')

  // ③ Node 版本：正文与徽章都不许出现其它版本号
  const versions = new Set([
    ...[...txt.matchAll(/(?:>=|≥)\s*(2[0-9]\.\d+(?:\.\d+)?)/g)].map((m) => m[1]),
    ...[...txt.matchAll(/node-%E2%89%A5([0-9.]+)/g)].map((m) => m[1]),
  ])
  for (const v of versions) {
    must(f, v === nodeMin || v === nodeMM, `Node 版本写的是 ${v}，应为 ${nodeMin}`)
  }

  // ④ 不许再写"零运行时依赖"（运行期确实 import 了 schemastery）
  must(f, !/零运行时依赖|zero runtime dependencies/i.test(txt), '仍写着"零运行时依赖"，与 schemastery 矛盾')
  must(f, /@deepseek-ai\/\*/.test(txt), '缺少依赖口径说明（应写明"不含非 @deepseek-ai/* 的第三方包"）')

  // ⑤ 代码块必须标注语言。
  //    只看**开栅栏**：闭栅栏本来就是裸的 ```，把它算进来会得到"13 个未标注"的假阳性
  //    （第一版就是这么写的，四份 README 全红）。
  let inFence = false
  let unlabeled = 0
  for (const line of txt.split('\n')) {
    if (!line.startsWith('```')) continue
    if (!inFence) {
      if (line.slice(3).trim() === '') unlabeled++
      inFence = true
    } else {
      inFence = false
    }
  }
  must(f, unlabeled === 0, `有 ${unlabeled} 个代码块没标语言（bash / ts / text / json）`)
}

// ⑥ 规模与测试数：只对英/中两份做严格断言（另三份是摘要，见各自声明）
for (const f of ['README.md', 'README.zh-CN.md']) {
  const txt = readme(f)
  const files = /(\d+)\s*(?:source files|个源文件)/.exec(txt)
  must(f, Boolean(files), '规模行缺少源文件数')
  if (files) must(f, Number(files[1]) === srcFiles.length, `源文件数写的是 ${files[1]}，实际 ${srcFiles.length}`)

  const lines = /(?:~|约)?\s*([\d,]{4,})\s*(?:lines|行)/.exec(txt)
  must(f, Boolean(lines), '规模行缺少行数')
  if (lines) {
    const stated = Number(lines[1].replace(/,/g, ''))
    const off = Math.abs(stated - srcLines) / srcLines
    must(f, off <= 0.02, `行数写的是 ${stated}，实际 ${srcLines}（偏差 ${(off * 100).toFixed(1)}% > 2%）`)
  }

  if (testCount !== null) {
    const t = /(\d{2,4})\s*(?:tests|条测试)/.exec(txt)
    must(f, Boolean(t), '缺少测试条数')
    if (t) must(f, Number(t[1]) === testCount, `测试数写的是 ${t[1]}，实际 ${testCount}`)
  }

  // ⑦ 缺点条数必须与 PROJECT-GUIDE 的 D1..Dn 对齐
  const dc = /(\d+)\s*(?:known weaknesses|条缺点)/.exec(txt)
  must(f, Boolean(dc), '缺少缺点条数')
  if (dc) must(f, Number(dc[1]) === dCount, `缺点条数写的是 ${dc[1]}，PROJECT-GUIDE 有 ${dCount} 条`)

  // ⑧ 存储比必须写清"长文本 / 短配置句"两个区间（评审指出的口径缺失）
  must(f, /0\.839|短配置|short config/i.test(txt), '缺少存储比的适用区间说明（长文本 0.839× vs 短配置句 ~6×）')
}

// ⑨ .nvmrc 与 engines 一致
if (existsSync(join(root, '.nvmrc'))) {
  const nvm = readFileSync(join(root, '.nvmrc'), 'utf8').trim()
  must('.nvmrc', nvm === nodeMin || nvm === nodeMM, `.nvmrc 是 ${nvm}，engines.node 是 ${nodeMin}`)
}

for (const n of notes) console.log(`info  ${n}`)
if (problems.length) {
  console.error(`\n${problems.length} 处不一致：`)
  for (const p of problems) console.error(`  FAIL  ${p}`)
  console.error('\n修法：改文档里的数字，或（更可能）是代码变了而文档没跟上。')
  process.exit(1)
}
console.log('ok    README 数字与代码一致')
