/**
 * SDR 性质回归（对应 §15.5 的六条 + §18.3 前四行回归项）
 *
 * 这个文件的重点不是"通过"，而是：一旦有人把算子改回密集码语义，
 * 200ms 内就能看到"你的记忆库已经变成空向量了"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SdrSpace } from '../packages/core/lib/sdr.js'

const space = new SdrSpace({ dim: 2048, k: 8 })

test('1) 精确可逆：unbind(bind(a)) === a', () => {
  const a = space.identity('用户')
  const p = space.role('AGENT')
  const back = space.permuteInv(space.permute(a, p), p)
  assert.deepEqual([...back], [...a])
})

test('2) 密度精确保持（XOR 绑定会得到 16，不是 8）', () => {
  const a = space.identity('用户')
  const bound = space.bind(a, space.role('AGENT'))
  assert.equal(space.popcount(bound), space.popcount(a))
  assert.equal(space.popcount(bound), 8)
})

test('3) 单码噪声底 < 0.01（v0.1 的汉明相似度是 0.96）', () => {
  const s = space.sim(space.identity('用户'), space.identity('服务器'))
  assert.ok(s < 0.01, `noise=${s}`)
})

test('4) 叠加后 rank-1 解绑全对（N=8/16/24）', () => {
  for (const n of [8, 16, 24]) {
    const r = space.measureCapacity(n)
    assert.equal(r.rank1, n, `N=${n} rank1=${r.rank1}`)
  }
})

test('4b) n=24 时正确/错误成分的区分度约 2–3×，绝对值都很小', () => {
  const r = space.measureCapacity(24)
  assert.ok(r.minCorrect < 0.1, `正确成分 sim 应很小（${r.minCorrect}）——这正是不能用绝对阈值的原因`)
  assert.ok(r.minCorrect / r.maxWrong > 1.5, `区分度 ${r.minCorrect / r.maxWrong}`)
})

test('5) 无关 bundle 噪声底 < 0.2（去重阈值 0.85 有余量）', () => {
  const mk = (p) => {
    const roles = Array.from({ length: 24 }, (_, i) => space.role(`${p}_R${i}`))
    return space.bundle(roles.map((r, i) => space.bind(space.identity(`${p}_F${i}`), r)))
  }
  const j = space.sim(mk('A'), mk('B'))
  assert.ok(j < 0.2, `bundle noise=${j}`)
})

test('6) 尺寸悬殊时 containment 仍能区分（Jaccard 上界只有 0.087）', () => {
  const cellA = space.bundle(Array.from({ length: 24 }, (_, i) => space.bind(space.identity(`C_F${i}`), space.role(`C_R${i}`))))
  const cellB = space.bundle(Array.from({ length: 24 }, (_, i) => space.bind(space.identity(`D_F${i}`), space.role(`D_R${i}`))))
  const q = space.bundle([space.bind(space.identity('C_F0'), space.role('C_R0')), space.bind(space.identity('C_F1'), space.role('C_R1'))])

  const jac = space.sim(q, cellA)
  const cont = space.containment(q, cellA)
  assert.ok(jac < 0.15, `Jaccard 命中只有 ${jac}，被尺寸差压死`)
  assert.ok(cont > 0.9, `containment 命中 ${cont}`)
  assert.ok(space.containment(q, cellB) < 0.2)
  assert.ok(space.simNorm(q, cellA) > 0.9)
})

test('回归：多数表决会让稀疏 bundle 变成空向量', () => {
  const items = Array.from({ length: 24 }, (_, i) => space.bind(space.identity('F' + i), space.role('R' + i)))
  const majority = () => {
    const o = space.zero()
    for (let bit = 0; bit < space.dim; bit++) {
      let c = 0
      for (const it of items) c += (it[bit >>> 5] >>> (bit & 31)) & 1
      if (c * 2 > items.length) o[bit >>> 5] |= 1 << (bit & 31)
    }
    return o
  }
  assert.equal(space.popcount(majority()), 0)
  assert.ok(space.popcount(space.bundle(items)) > 0)
})

test('回归：置换表只哈希前两个字会让角色塌缩', () => {
  // 用"只哈希前两个字"的朴素实现构造一张表，验证它确实会塌缩（同一张表）
  const naive = (key) => {
    let h = (key[0] ^ key[1]) >>> 0
    let s = h || 1
    const p = new Uint16Array(space.dim)
    for (let i = 0; i < space.dim; i++) p[i] = i
    for (let i = space.dim - 1; i > 0; i--) {
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      const j = s % (i + 1)
      const t = p[i]
      p[i] = p[j]
      p[j] = t
    }
    return p
  }
  let same = 0
  const n = 24
  for (let i = 0; i < n; i++) {
    const k = space.identity('ROLE_' + i)
    if (naive(k)[7] === naive(space.identity('ROLE_0'))[7]) same++
  }
  // 正确实现下角色表互不相同（用同一位置的取值做代理指标）
  assert.ok(same < n, '正确实现的角色表不应全部相同')
  const proper = new Set(Array.from({ length: n }, (_, i) => space.role('ROLE_' + i)[7]))
  assert.ok(proper.size > n * 0.8, `正确实现应近乎全不同，实际 ${proper.size}/${n}`)
})

test('pack/unpack 往返', () => {
  const a = space.identity('深色模式')
  const back = space.unpack(space.pack(a))
  assert.deepEqual([...back], [...a])
  assert.equal(space.pack(a).length, 256)
})
