/**
 * v0.6 · 情感记忆引擎的算法层（纯函数，无 I/O）
 *
 * 这一组测的不是"情感像不像人"，而是**四条机制是否按研究说的方向起作用**：
 *   ① 评价 → PAD 的单调性（目标受挫必须降低效价）
 *   ② 心境一致性的**不对称**（负向侧打折，这是反刍的闸）
 *   ③ 唤醒对巩固的**倒 U**（峰值在中等唤醒，两端回落）
 *   ④ 情感摘要的**字节稳定**（同一状态必须产生同一行，否则 prefix cache 失效）
 *
 * 最后一条容易被忽略：`emotionBrief` 的输出会进 prompt，
 * 它每次抖动都会让缓存命中率归零——所以格式化必须确定。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  arousalBoost,
  behaviorHints,
  dampedAffectWeight,
  emotionBrief,
  estimateAffect,
  integrateMood,
  labelFromPad,
  moodCongruence,
  padFromAppraisal,
  sanitizeFacts,
} from './helpers.mjs'

test('estimateAffect：正负词给出相反效价，且强度随程度副词上升', () => {
  const pos = estimateAffect('今天太棒了，终于搞定')
  const neg = estimateAffect('又错了，烦死了')
  assert.ok(pos.v > 0.2, `正向效价应 > 0.2，实际 ${pos.v}`)
  assert.ok(neg.v < -0.2, `负向效价应 < -0.2，实际 ${neg.v}`)

  const mild = estimateAffect('有点累')
  const strong = estimateAffect('非常累')
  assert.ok(Math.abs(strong.v) >= Math.abs(mild.v), '程度副词应放大强度')
})

test('estimateAffect：中性句不产生虚假情绪（宁可漏，不可编）', () => {
  const r = estimateAffect('明天上午十点开会')
  assert.equal(r.confidence, 0)
  assert.equal(r.labels.length, 0)
  assert.equal(r.v, 0)
})

test('estimateAffect：否定翻转效价，但不把"不难过"变成"开心"', () => {
  const negated = estimateAffect('不难过')
  assert.ok(negated.v > 0, '否定后效价应转正')
  assert.ok(negated.v < 0.55, '但不应达到"开心"的强度')
})

test('labelFromPad：高唤醒负向给"愤怒"，低唤醒负向给"难过"', () => {
  const angry = labelFromPad({ v: -0.7, a: 0.85, d: 0.3, s: 0.8 }).map((l) => l.label)
  const sad = labelFromPad({ v: -0.7, a: 0.2, d: -0.4, s: 0.6 }).map((l) => l.label)
  assert.ok(angry.includes('愤怒'), `期望含愤怒，实际 ${angry.join(',')}`)
  assert.ok(sad.includes('难过'), `期望含难过，实际 ${sad.join(',')}`)
  assert.ok(!sad.includes('愤怒'))
})

test('padFromAppraisal：目标受挫降效价、目标推进升效价', () => {
  const base = { goalRel: 0.5, goalCon: 0.5, agency: 0.5, certainty: 0.5, novelty: 0.3, norm: 0.5, charge: 0 }
  const win = padFromAppraisal({ ...base, goalRel: 0.9, goalCon: 0.1 })
  const lose = padFromAppraisal({ ...base, goalRel: 0.1, goalCon: 0.9 })
  assert.ok(win.v > lose.v, '推进的效价必须高于受挫')
  assert.ok(lose.a > win.a - 0.001, '受挫应至少不比推进更平静')
})

test('moodCongruence：负向侧被打折（反刍闸），低显著度不吃增益', () => {
  const happy = { v: 0.8, a: 0.5, d: 0.2, s: 0.6 }
  const sad = { v: -0.8, a: 0.4, d: -0.3, s: 0.6 }
  const posGain = moodCongruence(happy, 0.8, 0.6)
  const negGain = Math.abs(moodCongruence(sad, -0.8, 0.6))
  assert.ok(posGain > 0)
  assert.ok(negGain < posGain, `负向增益 ${negGain} 必须小于正向 ${posGain}`)

  const lowSalience = moodCongruence(happy, 0.8, 0.0)
  assert.ok(lowSalience < posGain, '低显著度记忆应被闸住')
  assert.equal(moodCongruence({ v: 0.02, a: 0.5, d: 0, s: 0 }, 0.9), 0, '接近中性的心境不产生偏置')
})

test('arousalBoost：倒 U，峰值在 0.5，两端回落', () => {
  const calm = arousalBoost(0)
  const mid = arousalBoost(0.5)
  const extreme = arousalBoost(1)
  assert.ok(mid > calm, '中等唤醒应强于平静')
  assert.ok(mid > extreme, '中等唤醒应强于极度唤醒')
  assert.ok(Math.abs(calm - 0.85) < 1e-9 && Math.abs(extreme - 0.85) < 1e-9, '两端应同为下界')
  assert.ok(mid <= 1.36)
})

test('dampedAffectWeight：连续负面时压低情感权重，但不归零', () => {
  const base = 0.25
  assert.equal(dampedAffectWeight(base, [-0.2, 0.1, 0.3]), base, '样本不足时不干预')
  const heavy = dampedAffectWeight(base, [-0.5, -0.4, -0.6, -0.3, 0.1, 0.2])
  assert.ok(heavy < base, '负面占比高时必须折')
  assert.ok(heavy >= base * 0.4 - 1e-9, '但不得低于 40%')
})

test('integrateMood：τ 越大越稳（同一步的移动更小）', () => {
  const prev = { v: 0, a: 0.5, d: 0, s: 0 }
  const cur = { v: 1, a: 0.5, d: 0, s: 1 }
  const fast = integrateMood(prev, cur, 5)
  const slow = integrateMood(prev, cur, 40)
  assert.ok(fast.v > slow.v, 'τ 小的应更快靠近当前情绪')
  assert.ok(fast.v <= 1 && slow.v >= 0)
})

test('emotionBrief：字节稳定 + 含 mood/lab 两段', () => {
  const pad = { v: -0.42, a: 0.61, d: -0.2, s: 0.7 }
  const a = emotionBrief({ pad, labels: labelFromPad(pad), trust: 0.72, familiarity: 0.55, unresolved: 1 })
  const b = emotionBrief({ pad, labels: labelFromPad(pad), trust: 0.72, familiarity: 0.55, unresolved: 1 })
  assert.equal(a, b, '同一状态必须逐字节一致')
  assert.match(a, /^A\|mood:-0\.42\/0\.61\/-0\.20\|lab:/)
  assert.match(a, /\|rel:t72,f55/)
  assert.match(a, /\|open:1/)
  assert.ok(!a.includes('undefined'))
})

test('behaviorHints：未平复情绪优先于风格微调', () => {
  const hints = behaviorHints({ pad: { v: -0.5, a: 0.8, d: 0, s: 0.8 }, unresolved: 2 })
  assert.equal(hints[0], '先接住情绪再谈事')
  assert.ok(hints.length <= 3)
})

test('sanitizeFacts：拒绝垃圾、裁剪越界、保留合法字段', () => {
  const raw = [
    { predicate: 'prefers', object: 'pnpm', valence: 5, arousal: -3, confidence: 'x' },
    { predicate: '', object: 'noise' },
    { predicate: 'decided', object: 'v0.6', category: 'bogus', salience: 0.9 },
    null,
    'string',
    { predicate: 'uses', object: 'sqlite', category: 'fact', quote: 'q'.repeat(200) },
  ]
  const out = sanitizeFacts(raw)
  assert.equal(out.length, 3, '空谓词与非对象必须被丢掉')
  assert.equal(out[0].valence, 1, '越界效价应被裁到 1')
  assert.equal(out[0].arousal, 0, '负唤醒应被裁到 0')
  assert.equal(out[0].confidence, undefined, '非数字置信度应丢弃')
  assert.equal(out[1].category, undefined, '未知类别应丢弃')
  assert.ok(out[2].quote.length <= 60, '引文应被截断')
})

test('sanitizeFacts：最多 12 条（防止模型话痨撑爆一轮预算）', () => {
  const raw = Array.from({ length: 30 }, (_, i) => ({ predicate: 'p' + i, object: 'o' }))
  assert.equal(sanitizeFacts(raw).length, 12)
})
