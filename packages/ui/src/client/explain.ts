/**
 * 打分拆解的解释器（§12.5）
 *
 * 注意：这里**重写了**一遍格式化，而不是 import core 的 formatBreakdown。
 * 原因很实际——core 依赖 node:fs/node:sqlite，client bundle 不能引它。
 * 代价是两处逻辑必须保持一致，因此测试里有一条对拍（test/explain.test.mjs）：
 * 同一份 breakdown 在 host 与 client 两侧渲染出的文本必须逐字节相同。
 */
import type { ScoreBreakdown } from '@bcf/dsh-mnemo-core'

const LABEL: Record<string, string> = {
  sim: 'sim     ',
  recency: 'recency ',
  freq: 'freq    ',
  affect: 'affect  ',
  goal: 'goal    ',
  cue: 'cue     ',
  interf: 'interf  ',
}

export function formatBreakdownClient(b: ScoreBreakdown, threshold: number): string {
  const keys = Object.keys(b.parts) as Array<keyof ScoreBreakdown['parts']>
  const lines = keys.map((k) => {
    const raw = b.raw[k] ?? 0
    const w = b.weights[k] ?? 0
    const contrib = b.parts[k] ?? 0
    const sign = k === 'interf' ? '' : ' '
    return `  ${LABEL[k] ?? k} ${raw.toFixed(2)} × ${w.toFixed(2)} = ${sign}${contrib.toFixed(2)}`
  })
  return [
    `cell ${b.cellId.slice(-4)}  总分 ${b.score.toFixed(2)}（阈值 ${threshold.toFixed(2)}，槽位 ${b.slot + 1}）`,
    ...lines,
    '  ─────────────────────────────',
    `  raw ${b.rawSum.toFixed(2)} / Σw ${b.activeW.toFixed(2)} = ${b.score.toFixed(2)}`,
    ...b.notes.map((n) => `  · ${n}`),
  ].join('\n')
}
