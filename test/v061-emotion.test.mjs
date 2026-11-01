/**
 * v0.6.1 · 情感识别（审计稿 F4）
 *
 * v0.6.0 的英文识别基本失效（`I am happy` 的 confidence 是 0），
 * 相对 v0.2 的 `affect/appraisal.ts` 是一次**版本间退化**——而现有测试一条都没抓到，
 * 因为它们只测中文。
 *
 * 这一组用 40 条中英对照样本（含否定、程度副词、易误伤词）算**符号正确率**，
 * 而不是逐条断言具体数值：数值会随词表调参漂移，符号是语义的硬约束。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { LEXICON, LEXICON_DEDUP, estimateAffect, labelFromPad } from './helpers.mjs'

/** [文本, 期望符号]  —— 0 表示"应当判为中性" */
const SAMPLES = [
  ['我开心', 1],
  ['我不开心', -1],
  ['我不是很开心', -1],
  ['我太开心了', 1],
  ['今天太棒了', 1],
  ['终于搞定了', 1],
  ['谢谢，帮了大忙', 1],
  ['这个方案不错', 1],
  ['有点累', -1],
  ['烦死了', -1],
  ['又错了', -1],
  ['太难过了', -1],
  ['我有点担心', -1],
  ['气死我了', -1],
  ['还行吧', 1],
  ['今天太阳很好', 1],
  ['I am happy', 1],
  ['I am not happy', -1],
  ['I am very happy', 1],
  ['I feel great', 1],
  ['this is awesome', 1],
  ['I love it', 1],
  ['I am really sad', -1],
  ['I feel terrible', -1],
  ['I hate this', -1],
  ['I am not okay', -1],
  ['she is worried', -1],
  ['I am a bit tired', -1],
  ['we are confident', 1],
  ['I feel lonely', -1],
  ['the build failed', -1],
  ['shipped it finally', 1],
  ['I do not like it', -1],
  ['not bad', 1],
  ['quite good', 1],
  ['明天上午十点开会', 0],
  ['把配置改成 utf-8', 0],
  ['数据库用 node:sqlite', 0],
  ['超市很远', 0],
  ['太空真大', 0],
]

test('F4：40 条中英样本的符号正确率 ≥ 0.85', () => {
  let ok = 0
  const wrong = []
  for (const [text, want] of SAMPLES) {
    const r = estimateAffect(text)
    const got = Math.abs(r.v) < 0.08 ? 0 : Math.sign(r.v)
    if (got === want) ok++
    else wrong.push(`${text} → v=${r.v.toFixed(3)}（期望 ${want}）`)
  }
  const acc = ok / SAMPLES.length
  assert.ok(acc >= 0.85, `符号正确率 ${(acc * 100).toFixed(0)}%，不达标的样本：\n  ${wrong.join('\n  ')}`)
})

test('F4：英文不再全零——v0.6.0 的核心退化', () => {
  for (const t of ['I am happy', 'I am very happy', 'I feel terrible', 'this is awesome']) {
    const r = estimateAffect(t)
    assert.ok(r.confidence > 0, `${t} 的置信度不该是 0`)
    assert.notEqual(r.v, 0, `${t} 的效价不该是 0`)
  }
})

test('F4：英文否定结构性修复（"not" 曾经永远匹配不上）', () => {
  const pos = estimateAffect('I am happy')
  const neg = estimateAffect('I am not happy')
  assert.ok(pos.v > 0.2)
  assert.ok(neg.v < 0, `"I am not happy" 必须为负，实际 ${neg.v}`)
  const n2 = estimateAffect("I don't like it")
  assert.ok(n2.v < 0, `"I don't like it" 必须为负，实际 ${n2.v}`)
})

test('F4：程度副词真的放大强度（very > 裸词，太 > 裸词）', () => {
  const bare = estimateAffect('happy')
  const strong = estimateAffect('I am very happy')
  assert.ok(Math.abs(strong.v) > Math.abs(bare.v), `very 应放大强度：${bare.v} vs ${strong.v}`)

  const zhBare = estimateAffect('我开心')
  const zhStrong = estimateAffect('我太开心了')
  assert.ok(zhStrong.v > zhBare.v, `"太"应放大强度：${zhBare.v} vs ${zhStrong.v}`)
})

test('F4：程度副词不误伤（太阳 / 超市 / 太空 里的"太"不是强化词）', () => {
  // 这三个词本身不该产生任何情绪——如果"太"被当成强化词，
  // 它就会去放大后面碰巧出现的词，制造假阳性。
  for (const t of ['太阳', '超市', '太空']) {
    const r = estimateAffect(t)
    assert.equal(r.confidence, 0, `${t} 不该被判成有情绪（confidence=${r.confidence}）`)
    assert.equal(r.v, 0)
  }
  // 而且"太阳很好"里的情绪必须完全来自"很好"，与"太"无关：
  // 把"太"换成别的字，效价应当一致
  const a = estimateAffect('今天太阳很好')
  const b = estimateAffect('今天天气很好')
  assert.ok(Math.abs(a.v - b.v) < 1e-9, `太阳 与 天气 的效价应完全一致：${a.v} vs ${b.v}`)
})

test('F4：词表无重复条目（重复会让效价凭空翻倍）', () => {
  assert.equal(LEXICON.length, LEXICON_DEDUP.length, 'LEXICON 里存在重复词，去重前后长度应相等')
  const seen = new Set()
  for (const [w] of LEXICON_DEDUP) {
    assert.equal(seen.has(w), false, `重复词：${w}`)
    seen.add(w)
  }
  assert.ok(LEXICON_DEDUP.length >= 100, `词表规模应 ≥ 100，实际 ${LEXICON_DEDUP.length}`)
})

test('F4：中性句仍然不产生虚假情绪（宁可漏，不可编）', () => {
  for (const t of ['明天上午十点开会', '把配置改成 utf-8']) {
    const r = estimateAffect(t)
    assert.equal(r.v, 0, `${t} 不该有非零效价`)
    assert.equal(r.confidence, 0)
  }
})

test('F4：标签仍按 PAD 语义给出（负向高唤醒→愤怒，低唤醒→难过）', () => {
  const angry = labelFromPad({ v: -0.7, a: 0.85, d: 0.3, s: 0.8 }).map((l) => l.label)
  const sad = labelFromPad({ v: -0.7, a: 0.2, d: -0.4, s: 0.6 }).map((l) => l.label)
  assert.ok(angry.includes('愤怒'))
  assert.ok(sad.includes('难过'))
})
