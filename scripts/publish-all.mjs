/**
 * 按依赖顺序发布 10 个包。
 *
 *   node scripts/publish-all.mjs                 # 真发：npm 会逐个包提示输入验证码
 *   node scripts/publish-all.mjs --dry-run       # 只打包预演（不需要登录）
 *   node scripts/publish-all.mjs --otp=123456    # 带上一次性验证码
 *   node scripts/publish-all.mjs --only=core     # 只发某一个（重试用）
 *   node scripts/publish-all.mjs --republish     # 已存在的版本也重发（默认跳过）
 *
 * ── v0.5.1 加的两道前置检查（都是踩过的坑）───────────────────────
 * ① **登录态预检**：token 过期时 `npm publish` 只报一句 `E401 Unauthorized`，
 *    而脚本会把它当成普通失败继续往下试，10 个包全红之后才发现是没登录。
 *    现在先跑 `npm whoami`，失败就直接停并告诉你 `npm login`。
 * ② **幂等发布**：中途失败重跑时，已发出去的版本会被 npm 拒绝（E403
 *    "cannot publish over the previously published versions"）。现在先查
 *    `npm view <pkg>@<version>`，已存在就跳过——重跑是安全的。
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
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const republish = args.includes('--republish')
const otp = args.find((a) => a.startsWith('--otp='))?.slice(6)
const only = args.find((a) => a.startsWith('--only='))?.slice(7)

/** 拓扑序：core 最先，ui / devkit 最后 */
const ORDER = ['core', 'affect', 'encoder', 'recall', 'consolidator', 'proactive', 'tools', 'settings', 'devkit', 'ui']

const root = process.cwd()
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

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

/** 跑一条 npm 命令，返回 { ok, out }。用 pipe 才能拿到错误文本。 */
function npm(argsArr, cwd = root) {
  const r = spawnSync(`npm ${argsArr.join(' ')}`, { cwd, encoding: 'utf8', shell: true })
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

// ② 登录态预检：dry-run 不需要登录，其余必须先确认 whoami 能通
if (!dryRun) {
  const me = npm(['whoami'])
  if (!me.ok) {
    const line = me.out.split('\n').find((l) => /E401|ENEEDAUTH|Unauthorized/.test(l)) ?? me.out.split('\n')[0]
    console.error('✗ 未登录或 token 已失效：' + line.trim())
    console.error('')
    console.error('  npm 的 authToken 会过期（v0.4.0 发布时是好的，隔天可能就 E401 了）。')
    console.error('  修法：')
    console.error('    1) npm login            # 浏览器 + 2FA，会重写 ~/.npmrc 里的 _authToken')
    console.error('    2) npm whoami           # 应输出 rain13sad')
    console.error('    3) node scripts/publish-all.mjs')
    console.error('')
    console.error('  不要靠重试解决 E401：那是凭证问题，不是网络问题。')
    process.exit(1)
  }
  console.log(`info  已登录：${me.out.trim()}`)
}

const failed = []
const skipped = []
for (const name of targets) {
  const dir = join(root, 'packages', name)
  if (!existsSync(join(dir, 'package.json'))) {
    console.error(`跳过 ${name}：没有 package.json`)
    continue
  }
  // ② 幂等：这个版本已经在 registry 上就跳过（重跑安全）
  if (!dryRun && !republish) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const seen = npm(['view', `${pkg.name}@${pkg.version}`, 'version'])
    if (seen.ok && seen.out.trim()) {
      console.log(`=  ${name}  ${pkg.version} 已在 registry 上，跳过`)
      skipped.push(name)
      continue
    }
  }

  const argv = ['publish', '--access', 'public']
  if (dryRun) argv.push('--dry-run')
  if (otp) argv.push(`--otp=${otp}`)

  console.log(`→ ${name} …`)
  // Windows 上直接 spawn 'npm.cmd' 会 ENOENT（npm 是 .cmd，不是可执行文件）；
  // 走 shell 才能解析。参数里没有空格，拼接是安全的。
  //
  // stdio 的选择很关键：
  //   · 没带 --otp 时必须 **inherit**，否则子进程拿不到 TTY，npm 无法弹出验证码输入，
  //     只会直接报 EOTP（我第一版就是这样，白试了 5 次还触发了限流）。
  //   · 带了 --otp 或 --dry-run 时用 pipe，才能把错误抓出来判断要不要提前停。
  const interactive = !otp && !dryRun
  const r = interactive
    ? spawnSync(`npm ${argv.join(' ')}`, { cwd: dir, shell: true, stdio: 'inherit' })
    : spawnSync(`npm ${argv.join(' ')}`, { cwd: dir, encoding: 'utf8', shell: true })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`

  if (r.status === 0) {
    console.log(`  ✓ ${name}`)
    continue
  }

  const err = out
    .split('\n')
    .filter((l) => /npm error/.test(l))
    .slice(0, 2)
    .join(' | ')
  console.log(`  ✗ ${name}  ${err || `退出码 ${r.status}`}`)
  failed.push(name)
  if (/E401|ENEEDAUTH|Unauthorized/.test(out)) {
    console.error('\n✗ 凭证失效（E401）：先 `npm login` 再重跑。重试不会让 token 复活。')
    break
  }
  if (/E403/.test(out) && /cannot publish over|previously published/i.test(out)) {
    console.error(`\n✗ ${name}@${version} 已存在于 registry。这是幂等重跑的正常情况，用 --only 跳过它即可。`)
    continue
  }
  if (/EOTP|E429/.test(out)) {
    console.error('\n遇到 2FA 相关错误，已停止（继续重试会触发 OTP 限流，通常要等 15 分钟）。')
    break
  }
  if (!interactive) break
}

if (failed.length) {
  console.error(`\n失败 ${failed.length} 个：${failed.join(', ')}`)
  console.error(`重试：node scripts/publish-all.mjs --only=<包名> --otp=<新验证码>`)
  console.error('（已成功发出去的版本会被自动跳过，重跑整批也是安全的）')
  process.exit(1)
}
const skipNote = skipped.length ? `（跳过已存在 ${skipped.length} 个）` : ''
console.log(`\n${dryRun ? '预演' : '发布'}完成：${targets.length - skipped.length} 个包${skipNote}`)
