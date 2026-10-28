/**
 * SDR 性质验证（对应文档 §6.5 / §15.5，以及工作区原脚本 mnemo-sdr-check.mjs）
 *
 * 与原脚本的关系：原脚本是**独立实现**（用于证伪 v0.1 的数学），
 * 这里改为直接调用 `packages/core` 的 `SdrSpace`——它验证的是**发布的那份代码**，
 * 而不是一份平行实现。两者结论一致，但这里的失败意味着产品代码坏了。
 *
 *   node scripts/sdr-check.mjs
 */
import { SdrSpace, SIM_FLOOR } from '../packages/core/lib/sdr.js'

const space = new SdrSpace({ dim: 2048, k: 8 })
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) {
    pass++
    console.log(`  ok    ${msg}`)
  } else {
    fail++
    console.log(`  FAIL  ${msg}`)
  }
}

console.log('\n[1] 自逆与密度保持')
const a = space.identity('用户')
const pa = space.role('AGENT')
const round = space.permuteInv(space.permute(a, pa), pa)
ok([...round].every((w, i) => w === a[i]), 'unbind(bind(a)) === a')
ok(space.popcount(space.bind(a, pa)) === space.popcount(a), `bind 密度保持 = ${space.popcount(space.bind(a, pa))}`)

console.log('\n[2] 噪声底')
const noise = space.sim(space.identity('用户'), space.identity('服务器'))
ok(noise < 0.01, `无关单码 Jaccard = ${noise.toFixed(4)}`)

console.log('\n[3] 叠加容量（rank-1 解绑准确率）')
for (const n of [8, 16, 24, 30, 32]) {
  const roles = Array.from({ length: n }, (_, i) => space.role('ROLE_' + i))
  const fills = Array.from({ length: n }, (_, i) => space.identity('FILL_' + i))
  const P = space.bundle(roles.map((r, i) => space.bind(fills[i], r)))
  let rank1 = 0
  let minCorrect = 1
  let maxWrong = 0
  for (let i = 0; i < n; i++) {
    const q = space.unbind(P, roles[i])
    const scored = fills.map((f, j) => ({ j, s: space.sim(q, f) })).sort((x, y) => y.s - x.s)
    if (scored[0].j === i) rank1++
    minCorrect = Math.min(minCorrect, scored.find((s) => s.j === i).s)
    maxWrong = Math.max(maxWrong, ...scored.filter((s) => s.j !== i).map((s) => s.s))
  }
  const density = ((space.popcount(P) / space.dim) * 100).toFixed(2)
  const ratio = (minCorrect / Math.max(maxWrong, 1e-6)).toFixed(1)
  console.log(`  N=${String(n).padStart(2)} 密度=${density}% rank1=${rank1}/${n} 正确=${minCorrect.toFixed(3)} 错误=${maxWrong.toFixed(3)} 区分度=${ratio}x`)
  if (n <= 24) ok(rank1 === n, `N=${n} 全对`)
  else console.log(`  note  N=${n} 超出工程建议上限 24，允许退化`)
}

console.log('\n[4] 无关 bundle 的噪声底（去重阈值必须高于此值）')
const mk = (prefix) =>
  space.bundle(
    Array.from({ length: 24 }, (_, i) => space.bind(space.identity(prefix + 'f' + i), space.role(prefix + 'r' + i))),
  )
const bundleNoise = space.sim(mk('A'), mk('B'))
console.log(`  无关 bundle(24) Jaccard = ${bundleNoise.toFixed(3)}`)
ok(bundleNoise < 0.2, 'bundle 噪声底 < 0.2（去重阈值 0.85 有充足余量）')

console.log('\n[5] 尺寸悬殊时的检索度量（query 短码 vs cell 长码）')
const cellA = mk('C')
const cellB = mk('D')
const qSmall = space.bundle([
  space.bind(space.identity('Cf0'), space.role('Cr0')),
  space.bind(space.identity('Cf1'), space.role('Cr1')),
])
const hit = space.containment(qSmall, cellA)
const miss = space.containment(qSmall, cellB)
const jHit = space.sim(qSmall, cellA)
console.log(`  Jaccard  命中=${jHit.toFixed(3)}（上界 |q|/|c|=${(space.popcount(qSmall) / space.popcount(cellA)).toFixed(3)}，被尺寸差压死）`)
console.log(`  containment 命中=${hit.toFixed(3)} 未命中=${miss.toFixed(3)} 标定后=${space.simNorm(qSmall, cellA).toFixed(3)}`)
ok(hit > 0.9, 'containment 完全命中 > 0.9')
ok(miss < 0.2, 'containment 未命中 < 0.2')
ok(space.simNorm(qSmall, cellA) > 0.9, '标定后命中接近 1')
ok(SIM_FLOOR === 0.09, `标定常量 = ${SIM_FLOOR}`)

console.log('\n[6] v0.1 缺陷复现（应全部表现为失效）')
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
console.log(`  多数表决后 popcount = ${space.popcount(majority())}（v0.1 会得到 0，即全零向量）`)
ok(space.popcount(majority()) === 0, '多数表决确实退化为空向量')

const hammingSim = (x, y) => {
  let diff = 0
  for (let i = 0; i < space.words; i++) {
    let v = x[i] ^ y[i]
    v = v - ((v >>> 1) & 0x55555555)
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
    diff += (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24)
  }
  return 1 - diff / space.dim
}
const hs = hammingSim(space.identity('用户'), space.identity('服务器'))
console.log(`  汉明相似度(无关码) = ${hs.toFixed(3)}（v0.1 会得到 0.96+，所有阈值失效）`)
ok(hs > 0.9, '汉明相似度确实让无关码看起来 96% 相似')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
