/**
 * 按依赖顺序发布 10 个包。
 *
 *   node scripts/publish-all.mjs                 # 真发（需要已登录 + 2FA）
 *   node scripts/publish-all.mjs --dry-run       # 只打包预演
 *   node scripts/publish-all.mjs --otp=123456    # 带上一次性验证码
 *   node scripts/publish-all.mjs --only=core     # 只发某一个（重试用）
 *
 * ── 为什么要自己排序 ─────────────────────────────────────────────
 * `npm publish --workspaces` 不保证按依赖顺序发。先发 affect 而 core 还没发，
 * 会短暂出现"安装 affect@0.3.1 时它依赖的 core@^0.3.1 不存在"的空窗。
 * 顺序写死在这里，是因为依赖图很小且稳定（core 是根，ui/devkit 是叶）。
 *
 * 另外：v0.3.0 的发布事故不是"发错了顺序"，而是**版本与兄弟依赖没同步**。
 * 所以这个脚本第一步就跑 ci-check-publish，不通过直接退出。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const otp = args.find((a) => a.startsWith('--otp='))?.slice(6)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

/** 拓扑序：core 最先，ui / devkit 最后 */
const ORDER = ['core', 'affect', 'encoder', 'recall', 'consolidator', 'proactive', 'tools', 'settings', 'devkit', 'ui']

const root = process.cwd()

// ① 门禁：版本 / 兄弟依赖 / lockfile 三项一致
const gate = spawnSync(process.execPath, [join(root, 'scripts', 'ci-check-publish.mjs')], { stdio: 'inherit' })
if (gate.status !== 0) {
  console.error('\n门禁未通过，已中止发布。')
  process.exit(1)
}

const targets = only ? ORDER.filter((p) => p === only) : ORDER
if (targets.length === 0) {
  console.error(`--only=${only} 不在发布列表里：${ORDER.join(', ')}`)
  process.exit(1)
}

const failed = []
for (const name of targets) {
  const dir = join(root, 'packages', name)
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`跳过 ${name}：没有 package.json`)
    continue
  }
  const argv = ['publish', '--access', 'public']
  if (dryRun) argv.push('--dry-run')
  if (otp) argv.push(`--otp=${otp}`)

  process.stdout.write(`→ ${name} … `)
  // Windows 上直接 spawn 'npm.cmd' 会 ENOENT（npm 是 .cmd，不是可执行文件）；
  // 走 shell 才能解析。参数里没有空格，拼接是安全的。
  const r = spawnSync(`npm ${argv.join(' ')}`, { cwd: dir, encoding: 'utf8', shell: true })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.status === 0) {
    console.log('ok')
  } else {
    const err = out
      .split('\n')
      .filter((l) => /npm error/.test(l))
      .slice(0, 2)
      .join(' | ')
    console.log(`FAIL  ${err}`)
    failed.push(name)
    // EOTP / E429 之后继续发只会加重限流，直接停
    if (/EOTP|E429/.test(out)) {
      console.error('\n遇到 2FA 相关错误，已停止（继续尝试会触发 OTP 限流）。')
      break
    }
  }
}

if (failed.length) {
  console.error(`\n失败 ${failed.length} 个：${failed.join(', ')}`)
  console.error(`重试：node scripts/publish-all.mjs --only=<包名> --otp=<新验证码>`)
  process.exit(1)
}
console.log(`\n${dryRun ? '预演' : '发布'}完成：${targets.length} 个包`)
