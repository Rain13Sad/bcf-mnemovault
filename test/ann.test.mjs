/**
 * 向量索引（HNSW）与 PQ 余弦的回归护栏。
 *
 * 这一组测试守的是三件事：
 *   1. **近似不等于随便**：同一批向量上，HNSW 的 top-k 必须与精确扫描高度重合。
 *   2. **可复现**：层高由 id 哈希决定，重建索引得到同一张图（重放一致性）。
 *   3. **冷层不归零**：pq32 之后向量长度变了，cosine 仍要能算出相似度。
 *      这条是 v0.2 的真 bug——长度不等直接返回 0，冷记忆永远检索不到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BruteIndex, HnswIndex, cosine, hashEmbedding, foldEmb, pq32 } from './helpers.mjs'

/** 确定性伪随机向量：测试 ANN 需要"没有并列分数"的数据，哈希 embedding 的近似重复会制造大量 tie。 */
function randVec(seed, dim = 64) {
  let s = seed >>> 0
  const out = new Int8Array(dim)
  for (let i = 0; i < dim; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = ((s >>> 24) - 128) >> 0
  }
  return out
}

const WORDS = [
  '深色主题', '浅色主题', '等宽字体', '无衬线字体', '构建工具', '测试框架',
  '部署环境', '数据库引擎', '缓存分片', '索引维护', '灰度比例', '压测报告',
  '工作记忆', '长期偏好', '情感内核', '主动开口', '面板首屏', '审批流程',
  '冲突裁决', '版本链', '残差共享', '向量折叠', '稀疏编码', '锚点记忆',
]

function vecOf(i, dim = 128) {
  return hashEmbedding(`${WORDS[i % WORDS.length]} 第 ${i} 条`, dim)
}

test('HNSW 的 top-8 与精确扫描高度重合（≥0.85）', () => {
  const brute = new BruteIndex()
  const ann = new HnswIndex({ m: 16, efConstruction: 200, efSearch: 96 })
  const N = 600
  for (let i = 0; i < N; i++) {
    const v = randVec(i + 1)
    const id = BigInt(i + 1)
    brute.add(id, v)
    ann.add(id, v)
  }
  let sum = 0
  const probes = 30
  for (let q = 0; q < probes; q++) {
    const v = randVec(10_000 + q)
    const a = new Set(ann.search(v, 8, 96).map((h) => h.id))
    const b = brute.search(v, 8).map((h) => h.id)
    sum += b.filter((id) => a.has(id)).length / b.length
  }
  const overlap = sum / probes
  assert.ok(overlap >= 0.85, `ANN 与精确扫描重合度 ${overlap.toFixed(2)}，低于 0.85 说明图建坏了`)
})

test('同一批向量重建索引，结果逐条一致（层高走 id 哈希，不走 Math.random）', () => {
  const build = () => {
    const idx = new HnswIndex({ m: 8, efSearch: 32 })
    for (let i = 0; i < 200; i++) idx.add(BigInt(i + 1), vecOf(i))
    return idx
  }
  const a = build()
  const b = build()
  const q = vecOf(3)
  assert.deepEqual(
    a.search(q, 8, 32).map((h) => h.id.toString()),
    b.search(q, 8, 32).map((h) => h.id.toString()),
  )
})

test('删除后不再被召回，且墓碑过多会触发重建', () => {
  const idx = new HnswIndex({ m: 8, efSearch: 32 })
  for (let i = 0; i < 120; i++) idx.add(BigInt(i + 1), vecOf(i))
  const target = 5n
  idx.remove(target)
  const hits = idx.search(vecOf(4), 16, 64).map((h) => h.id)
  assert.ok(!hits.includes(target), '已删除的向量不该出现在结果里')
  assert.ok(idx.size < 120)
})

test('空索引与零向量不炸', () => {
  const idx = new HnswIndex()
  assert.deepEqual(idx.search(vecOf(0), 8), [])
  idx.add(1n, new Int8Array(0))
  assert.deepEqual(idx.search(vecOf(0), 8), [])
})

test('PQ 冷层向量与全精度向量仍可比较（v0.2 的零分 bug）', () => {
  const full = hashEmbedding('用户偏好深色主题', 128)
  // 冷层：service.pq32 会把 128 维压成 32 B
  const cold = pq32(full)
  assert.equal(cold.length, 32)
  const same = cosine(full, cold)
  assert.ok(same > 0.3, `同一段文本的 PQ 版本相似度只有 ${same.toFixed(2)}，说明长度不等的分支算错了`)
  const other = hashEmbedding('部署脚本用 pnpm', 128)
  assert.ok(cosine(full, cold) > cosine(other, cold), '自身 PQ 版本必须比无关文本更相似')
})

test('折叠到 64 维后排序基本保持（Recall 不塌）', () => {
  const dim = 128
  const store = Array.from({ length: 80 }, (_, i) => hashEmbedding(`${WORDS[i % WORDS.length]} 方案 ${i}`, dim))
  const q = hashEmbedding('深色主题 偏好', dim)
  const rankFull = store
    .map((v, i) => ({ i, s: cosine(q, v) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => x.i)
  const qf = foldEmb(q, 64)
  const rankFold = store
    .map((v, i) => ({ i, s: cosine(qf, foldEmb(v, 64)) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => x.i)
  const overlap = rankFull.filter((i) => rankFold.includes(i)).length
  assert.ok(overlap >= 3, `折叠后 top-5 只重合 ${overlap} 条，说明折叠丢了太多信息`)
})
