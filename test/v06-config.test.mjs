/**
 * v0.6 · 配置单一真相 + 路径解析 + 首次安装自愈
 *
 * 这一组守的是 v0.5.3 现场报告里最贵的两个缺陷：
 *   D5：`embStoreDim` 有两张默认值表（schema 64 / defaultConfig 128），
 *       而它参与**布局键** —— 照着 README 写代码的人会打不开自己宿主建的库
 *   D1：`SqliteStore.open()` 不建父目录 —— 全新机器上 core 必然起不来，
 *       而症状甩给下游 6 层（全部 pending），用户只看到"面板在、一条记忆都没有"
 *
 * 两条都**没有报错**，所以只能靠断言守住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  Config,
  SqliteStore,
  SdrSpace,
  defaultConfig,
  productionConfig,
  expandDotted,
  expandHome,
  resolveVaultPath,
  tuningValues,
} from './helpers.mjs'

test('D5：参与布局键的四个字段，defaultConfig 与 schema 必须逐字段相等', () => {
  const schema = Config({})
  const def = defaultConfig()
  for (const k of ['sdrDim', 'sdrK', 'embDim', 'embStoreDim']) {
    assert.equal(def[k], schema[k], `${k} 有两张默认值表（schema ${schema[k]} vs defaultConfig ${def[k]}）`)
  }
  // 64 是既成事实：0.5.3 已经发出去，盘上的库就是 …:64:3
  assert.equal(schema.embStoreDim, 64, 'schema 的落盘向量维度必须是 64（存量库不可变）')
})

test('D5：嵌套段也来自同一张表（recall / consolidation / index / llm）', () => {
  const schema = Config({})
  const def = defaultConfig()
  assert.equal(def.recall.ignition, schema.recall.ignition)
  assert.equal(def.recall.wAffect, schema.recall.wAffect)
  assert.equal(def.consolidation.everyTurns, schema.consolidation.everyTurns)
  assert.equal(def.index.demoteBatch, schema.index.demoteBatch)
  assert.equal(def.llm.model, schema.llm.model)
  assert.equal(def.llm.embeddingEnabled, false, '真 embedding 默认必须关（零依赖承诺）')
  assert.equal(def.llm.extractEnabled, false, 'LLM 抽取默认必须关')
})

test('默认库路径：测试用内存库，部署用 ~/.dsh/mnemo', () => {
  assert.equal(defaultConfig().dbPath, ':memory:')
  assert.equal(productionConfig().dbPath, '~/.dsh/mnemo/vault.db')
  assert.equal(productionConfig().embStoreDim, 64)
})

test('expandHome：只认 ~ 与 ~/x，不猜 ~user', () => {
  assert.equal(expandHome('~', '/home/u'), '/home/u')
  assert.ok(expandHome('~/a/b', '/home/u').endsWith(join('a', 'b')), '展开后必须保留相对部分')
  assert.equal(expandHome('~user/x', '/home/u'), '~user/x', '不确定的形态原样返回，比猜错好')
  assert.equal(expandHome('/abs/p', '/home/u'), '/abs/p')
})

test('resolveVaultPath：非路径标记原样、绝对原样、相对按 profile 目录', () => {
  assert.equal(resolveVaultPath(':memory:'), ':memory:')
  assert.equal(resolveVaultPath('file::memory:?cache=shared'), 'file::memory:?cache=shared')
  assert.equal(resolveVaultPath(''), '')
  assert.equal(resolveVaultPath('/var/lib/x.db', undefined, '/home/u'), '/var/lib/x.db')
  // 用真实的 file: URL（Windows 上 fileURLToPath 要求带盘符，手写 file:///profiles 会抛）
  const profileDir = mkdtempSync(join(tmpdir(), 'mnemo-profile-'))
  try {
    const rel = resolveVaultPath('mnemo/vault.db', pathToFileURL(profileDir + '/').href, '/home/u')
    assert.ok(rel.startsWith(profileDir), `相对路径应落在 profile 目录，实际 ${rel}`)
    assert.ok(rel.endsWith(join('mnemo', 'vault.db')))
  } finally {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
  const home = resolveVaultPath('~/mnemo/v.db', undefined, '/home/u')
  assert.ok(home.endsWith(join('mnemo', 'v.db')), `~ 必须展开到主目录，实际 ${home}`)
  assert.ok(!home.includes('~'), '不能留下未展开的 ~')
})

test('D1：SqliteStore.open() 自己建父目录（全新机器上 core 不会起不来）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mnemo-d1-'))
  const nested = join(root, 'a', 'b', 'c', 'vault.db')
  const space = new SdrSpace({ dim: 2048, k: 8 })
  assert.equal(existsSync(join(root, 'a')), false, '前置条件：目录确实不存在')
  const store = new SqliteStore(space, nested)
  try {
    store.open()
    assert.ok(existsSync(nested), '打开后库文件必须出现')
    store.setMeta('probe', '1')
    assert.equal(store.meta('probe'), '1')
  } finally {
    store.close()
    // Windows 上 close() 之后 WAL 的收尾可能还差一拍：直接 rmdir 会 ENOTEMPTY。
    // 重试几次而不是断言失败——这条测的是"目录被建出来"，不是"删除的原子性"。
    await new Promise((r) => setTimeout(r, 30))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('expandDotted：点号路径展开一层，扁平键原样', () => {
  assert.deepEqual(expandDotted({ 'recall.ignition': 0.5, maxSlots: 3 }), {
    recall: { ignition: 0.5 },
    maxSlots: 3,
  })
  assert.deepEqual(expandDotted({ 'a.b': 1, 'a.c': 2 }), { a: { b: 1, c: 2 } })
})

test('tuningValues：只暴露"改了立刻有效"的项，不含需要重启/重建的', () => {
  const v = tuningValues(defaultConfig())
  assert.equal(typeof v['recall.ignition'], 'number')
  assert.equal(typeof v.maxSlots, 'number')
  assert.equal(v.surfaceMode, 'rows')
  for (const forbidden of ['dbPath', 'embDim', 'sdrDim', 'sdrK', 'embStoreDim']) {
    assert.equal(forbidden in v, false, `${forbidden} 需要重启或重建，不该做成滑杆`)
  }
})
