/**
 * 库路径解析（v0.5.3）
 *
 * 回归的是两个"静默错位"：
 *   ① schema 默认值是 `~/.dsh/mnemo/vault.db`，但代码从不展开 `~`——
 *      于是真的在当前工作目录里建一个名字叫 `~` 的文件夹。
 *   ② v0.5.2 的 patch 用 `!!js ${ctx.baseDir}/…` 指定路径，而 `ctx.baseDir`
 *      在 Loader 上并不存在（Loader 叫 `baseUrl`），拿到的是 `undefined`。
 * 两者都不会报错，只会把库写到错的地方——这类 bug 只有断言能抓住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expandHome, resolveVaultPath, baseUrlOf } from '../packages/core/lib/paths.js'

test('expandHome 展开 ~ 与 ~/x，不动 ~user 与绝对路径', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u')
  // Windows 上 resolve('/home/u') 会补盘符，所以期望值也用 resolve 算，避免平台差异
  assert.equal(expandHome('~/mnemo/vault.db', '/home/u'), resolve('/home/u', 'mnemo/vault.db'))
  assert.equal(expandHome('~user/x', '/home/u'), '~user/x')
  assert.equal(expandHome('/abs/x', '/home/u'), '/abs/x')
})

test('resolveVaultPath 保留非路径标记', () => {
  assert.equal(resolveVaultPath(':memory:'), ':memory:')
  assert.equal(resolveVaultPath('file::memory:?cache=shared'), 'file::memory:?cache=shared')
  assert.equal(resolveVaultPath(''), '')
})

test('resolveVaultPath 用 schema 默认值时落到用户主目录', () => {
  const p = resolveVaultPath('~/.dsh/mnemo/vault.db')
  assert.ok(isAbsolute(p), '默认路径必须解析成绝对路径')
  assert.ok(p.startsWith(homedir()), `${p} 应该在主目录下`)
  assert.ok(!p.includes('~'), '解析结果里不该再残留 ~')
})

test('resolveVaultPath 把相对路径解析到 profile 目录（ctx.baseUrl）', () => {
  const baseUrl = pathToFileURL(join(homedir(), '.dsh', 'profiles', 'desktop') + '/').href
  const p = resolveVaultPath('mnemo/vault.db', baseUrl)
  assert.equal(p, join(homedir(), '.dsh', 'profiles', 'desktop', 'mnemo', 'vault.db'))
})

test('baseUrlOf 只认字符串，不认识的宿主实现安静降级', () => {
  assert.equal(baseUrlOf({ baseUrl: 'file:///x/' }), 'file:///x/')
  assert.equal(baseUrlOf({ baseUrl: '' }), undefined)
  assert.equal(baseUrlOf({}), undefined)
  assert.equal(baseUrlOf(undefined), undefined)
  assert.equal(baseUrlOf({ baseDir: '/x' }), undefined, 'ctx.baseDir 不是 Loader 的属性，不能当成 baseUrl 用')
})
