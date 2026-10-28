/**
 * 情感视图（§12.4）
 *
 * PAD 散点（x=valence, y=arousal，点大小=salience）+ 六变量条 + 策略表读数。
 * 关键约束（§19.3）：这一页展示的是**工程参数**，措辞里不能出现"它感到"。
 * 面板底部常驻一行说明，因为这是最容易被误读的一页。
 */
import { createElement as h, type ReactNode } from 'react'
import type { PanelCellView, PanelSnapshot } from '@bcf/dsh-mnemo-core'
import { Bar, Metric, fmt2, signed } from '../ui.js'

export interface AffectProps {
  snapshot: PanelSnapshot
  cells: PanelCellView[]
  onSelect: (id: string) => void
  enabled: boolean
}

/** 折线：把 [-1,1] 的序列映射到画布高度 */
function polyline(values: number[], color: string, w: number, hgt: number, dash?: string): ReactNode {
  const n = Math.max(1, values.length - 1)
  const pts = values.map((v, i) => `${(i / n) * w},${hgt / 2 - (v * (hgt / 2 - 6))}`).join(' ')
  return h('polyline', { points: pts, fill: 'none', stroke: color, strokeWidth: 1.4, strokeDasharray: dash })
}

export function Affect(props: AffectProps): ReactNode {
  const a = props.snapshot.affect
  if (!a || !props.enabled) {
    return h(
      'div',
      { className: 'mnv-empty' },
      h('div', null, '情感内核未启用'),
      h('div', null, '记忆功能不受影响；检索不做情感门控，也不注入情感状态行。'),
      h('div', null, '在设置里打开 affectEnabled 即可恢复（下一轮生效）。'),
    )
  }

  const W = 340
  const H = 190
  const px = (v: number) => 20 + ((v + 1) / 2) * (W - 40)
  const py = (v: number) => H - 20 - ((v + 1) / 2) * (H - 40)
  const pts = props.cells.slice(0, 600)

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-grid', style: { marginBottom: 8 } },
      h(Metric, { label: '效价 V', value: signed(a.pad.v), hint: '核心情感 valence' }),
      h(Metric, { label: '唤起 A', value: fmt2(a.pad.a), hint: 'arousal，显式依赖 load' }),
      h(Metric, { label: '掌控 D', value: fmt2(a.pad.d), hint: 'dominance，依赖 uncert（负向）' }),
      h(Metric, { label: '心境 V', value: signed(a.mood.v), hint: `τ=20 轮积分，稳定性来源` }),
    ),
    a.stage
      ? h(
          'div',
          { className: 'mnv-card', style: { marginBottom: 8 } },
          h('h4', null, '关系阶段'),
          h(
            'div',
            { className: 'mnv-metric' },
            a.stage.label,
            h('small', null, `依恋 ${fmt2(a.attachment ?? 0)}`),
          ),
          h(Bar, { value: a.stage.progress, tone: 'var(--mnv-pos)' }),
          h('div', { className: 'mnv-note', style: { marginTop: 4 } }, '陌生 → 熟悉 → 亲密 → 依赖。依恋 = 熟悉 40% + 信任 30% + 共同情绪事件 30%，刷轮数涨不上来。'),
        )
      : null,

    h('div', { className: 'mnv-day' }, '情绪轨迹（每轮一个点，实线=效价，虚线=唤起）'),
    a.trajectory && a.trajectory.length > 1
      ? h(
          'svg',
          { className: 'mnv-affect-scatter', viewBox: '0 0 340 110', preserveAspectRatio: 'none', style: { height: 110 } },
          h('line', { x1: 0, y1: 55, x2: 340, y2: 55, stroke: 'var(--mnv-border)', strokeDasharray: '3 3' }),
          polyline(a.trajectory.map((t) => t.v), 'var(--mnv-pos)', 340, 110),
          polyline(a.trajectory.map((t) => t.a), 'var(--mnv-accent)', 340, 110, '4 3'),
        )
      : h('div', { className: 'mnv-note' }, '还没有足够的数据点'),

    a.episodes && a.episodes.length
      ? h(
          'div',
          null,
          h('div', { className: 'mnv-day' }, '未平复的情绪事件'),
          ...a.episodes.slice(0, 5).map((e, i) =>
            h(
              'div',
              { key: i, className: 'mnv-sub', style: { padding: '2px 0' } },
              h('span', { style: { color: e.v > 0 ? 'var(--mnv-pos)' : 'var(--mnv-neg)' } }, e.v > 0 ? '正向' : '负向'),
              h('span', null, `强度 ${fmt2(e.strength)}`),
              h('span', { style: { color: 'var(--mnv-fg-faint)' } }, e.trigger),
            ),
          ),
        )
      : null,

    h('div', { className: 'mnv-day' }, 'PAD 散点（记忆的效价 × 唤起，点大小=显著度）'),
    h(
      'svg',
      { className: 'mnv-affect-scatter', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' },
      h('line', { x1: 20, y1: H / 2, x2: W - 20, y2: H / 2, stroke: 'var(--mnv-border)', strokeDasharray: '3 3' }),
      h('line', { x1: W / 2, y1: 20, x2: W / 2, y2: H - 20, stroke: 'var(--mnv-border)', strokeDasharray: '3 3' }),
      ...pts.map((c) =>
        h('circle', {
          key: c.cellId,
          cx: px(c.valence),
          cy: py(c.arousal),
          r: 2 + c.salience * 5,
          fill: c.valence > 0 ? 'var(--mnv-pos)' : c.valence < 0 ? 'var(--mnv-neg)' : 'var(--mnv-fg-faint)',
          fillOpacity: 0.55,
          onClick: () => props.onSelect(c.cellId),
          style: { cursor: 'pointer' },
        }),
      ),
      h('circle', { cx: px(a.mood.v), cy: py(a.mood.a), r: 7, fill: 'none', stroke: 'var(--mnv-accent)', strokeWidth: 2 }),
      h('text', { x: px(a.mood.v) + 10, y: py(a.mood.a) - 8, fill: 'var(--mnv-accent)' }, 'mood'),
      h('text', { x: 22, y: 16 }, '高唤起'),
      h('text', { x: 22, y: H - 6 }, '低唤起'),
      h('text', { x: W - 66, y: H / 2 - 6 }, '效价 →'),
    ),
    h('div', { className: 'mnv-day' }, '内稳态六变量'),
    ...(
      [
        ['load', '任务负荷', a.intero.load],
        ['uncert', '不确定性', a.intero.uncert],
        ['conflict', '冲突度', a.intero.conflict],
        ['strain', '关系张力', a.intero.strain],
        ['progress', '目标进度', a.intero.progress],
        ['budget', '预算余量', a.intero.budget],
      ] as Array<[string, string, number]>
    ).map(([k, label, v]) =>
      h(
        'div',
        { key: k, style: { marginBottom: 6 } },
        h('div', { className: 'mnv-sub', style: { justifyContent: 'space-between' } }, h('span', null, `${label} ${k}`), h('span', { className: 'mnv-num' }, fmt2(v))),
        h(Bar, { value: v, tone: v > 0.7 ? 'var(--mnv-warn)' : undefined }),
      ),
    ),
    h('div', { className: 'mnv-day' }, '关系模型'),
    h(
      'div',
      { className: 'mnv-pillrow' },
      h('span', { className: 'mnv-chip' }, `trust ${fmt2(a.relational.trust)}`),
      h('span', { className: 'mnv-chip' }, `熟悉度 ${fmt2(a.relational.familiarity)}`),
      h('span', { className: 'mnv-chip' }, `合拍度 ${fmt2(a.relational.attunement)}`),
      h('span', { className: 'mnv-chip' }, `repairDebt ${a.relational.repairDebt}`),
    ),
    a.relational.boundaries.length
      ? h('div', { className: 'mnv-note' }, '边界（只增不减）：', ...a.relational.boundaries.map((b) => h('div', { key: b }, '· ' + b)))
      : null,
    a.persona
      ? h(
          'div',
          null,
          h('div', { className: 'mnv-day' }, `人格锚（rev ${a.persona.rev}，上限 ε=0.25）`),
          ...(['稳定', '亲和', '主动', '克制'] as const).map((label, i) => {
            const v = a.persona!.vector[i] ?? 0.5
            const base = a.persona!.baseline[i] ?? 0.5
            return h(
              'div',
              { key: label, style: { marginBottom: 5 } },
              h(
                'div',
                { className: 'mnv-sub', style: { justifyContent: 'space-between' } },
                h('span', null, label),
                h('span', { className: 'mnv-num' }, `${fmt2(v)}（基线 ${fmt2(base)}）`),
              ),
              h(Bar, { value: v, tone: Math.abs(v - base) > 0.15 ? 'var(--mnv-warn)' : undefined }),
            )
          }),
        )
      : null,
    h('div', { className: 'mnv-day' }, '用户图式（离线环产出）'),
    a.schema && a.schema.length > 0
      ? h(
          'div',
          { className: 'mnv-note' },
          ...a.schema.map((p, i) =>
            h('div', { key: i, style: { marginBottom: 4 } }, `· ${p.pattern}（support ${p.support}，置信 ${fmt2(p.confidence)}）`),
          ),
        )
      : h('div', { className: 'mnv-note' }, '· 样本还不够（每 40 轮抽一次，少于 12 个样本不产结论）'),

    h('div', { className: 'mnv-day' }, '本轮生效的策略'),
    a.policy.reasons.length
      ? h(
          'div',
          { className: 'mnv-note' },
          ...a.policy.reasons.map((r, i) => h('div', { key: i }, '· ' + r)),
        )
      : h('div', { className: 'mnv-note' }, '· 所有阈值都在安全范围内，无额外约束'),
    h(
      'div',
      { className: 'mnv-note', style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--mnv-border)' } },
      '这些是内部状态数值，不是主观体验，也不代表拥有情绪。情感只影响检索门控、语气与工具审批阈值，不影响事实判断。',
    ),
  )
}
