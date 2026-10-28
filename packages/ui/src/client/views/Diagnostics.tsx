/**
 * 诊断视图（§12.4 / §12.6 / §12.9）
 *
 * 这一页回答"为什么"，不回答"改成什么"——所以它是只读的，
 * 唯一的写操作是三个按钮：体检、导出报告、清锁。
 *
 * 指标口径与 /mnemo stats 完全一致（同一个 memory.stats()），
 * 避免"面板显示的和命令显示的不一样"这类最难查的 bug。
 */
import { createElement as h, type ReactNode } from 'react'
import type { PanelAction, PanelSnapshot } from '@bcf/dsh-mnemo-core'
import { Bar, Metric, Sparkline, fmt2 } from '../ui.js'

export interface DiagnosticsProps {
  snapshot: PanelSnapshot
  onAct: (a: PanelAction) => void
  onCommand: (line: string) => void
  busy?: boolean
}

/**
 * 调参向导（§13.1 的症状 → 参数索引）。
 * 每条都给出"先看什么 / 建议怎么改 / 不要动什么"，并把改动做成一键动作——
 * 只告诉用户"去改 w_i"而不给按钮，等于没做可操作性。
 */
const TUNING: Array<{
  symptom: string
  first: string
  action?: { label: string; patch?: Record<string, number | string>; preset?: string }
  avoid: string
}> = [
  {
    symptom: 'token 太贵',
    first: '看上面的 tokens/轮',
    action: { label: '切 lean 档', preset: 'lean' },
    avoid: '不要先降 ignition（会更贵）',
  },
  {
    symptom: '记不住事',
    first: '看 support=1 占比',
    action: { label: 'ignition → 0.36', patch: { 'recall.ignition': 0.36 } },
    avoid: '不要调 w_i',
  },
  {
    symptom: '召回不准（找到但不对）',
    first: '用「为什么」看 sim 分量',
    action: { label: 'wSim → 1.3', patch: { 'recall.wSim': 1.3 } },
    avoid: '不要加大 maxSlots',
  },
  {
    symptom: '召回太少（该有却没有）',
    first: '看是否已降到冷层',
    action: { label: '遗忘档 → procedure', patch: { forgettingProfile: 'procedure' } },
    avoid: '不要重建库',
  },
  {
    symptom: '答旧版本 / 前后矛盾',
    first: '看 ↑ 与矛盾边数量',
    action: { label: 'wRecency → 0.5', patch: { 'recall.wRecency': 0.5 } },
    avoid: '不要删旧 cell（版本链是信息）',
  },
  {
    symptom: '语气不对',
    first: '看情感页的 mood',
    action: { label: 'moodTau → 30', patch: {} },
    avoid: '不要动 personaDriftEpsilon',
  },
]

export function Diagnostics(props: DiagnosticsProps): ReactNode {
  const s = props.snapshot.stats
  const tokens = s.tokenSeries.map((x) => x.tokens)
  const kindEntries = Object.entries(s.byKind)
  const totalKind = kindEntries.reduce((n, [, v]) => n + v, 0) || 1
  const contradictions = props.snapshot.edges.filter((e) => e.relName === 'CONTRADICTS')

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-grid', style: { marginBottom: 8 } },
      h(Metric, { label: '记忆条数', value: s.cells, hint: '含所有分层' }),
      h(Metric, { label: '命中率', value: `${(s.hitRate * 100).toFixed(0)}%`, hint: '召回返回 ≥1 条的比例' }),
      h(Metric, { label: 'tokens/轮', value: s.tokensPerTurn.toFixed(0), unit: 'tok', hint: 'surface 注入，不含编码折合' }),
      h(Metric, { label: '召回 p95', value: s.recallP95Ms, unit: 'ms', hint: '设计目标 ≤40ms @100 万 cell' }),
      h(Metric, { label: '存储', value: (s.bytes / 1024).toFixed(1), unit: 'KB', hint: '仅结构化基底，不含残差正文' }),
      h(Metric, { label: '存储比', value: fmt2(s.storageRatio), unit: '×', hint: '目标 0.45–0.60×（假设每轮 1 条 cell）' }),
    ),
    h('div', { className: 'mnv-day' }, 'token 曲线（最近 40 轮）'),
    tokens.length > 1 ? h(Sparkline, { data: tokens, width: 320, height: 40 }) : h('div', { className: 'mnv-note' }, '还没有足够的数据点'),

    h('div', { className: 'mnv-day' }, '类型分布'),
    ...kindEntries.map(([k, v]) =>
      h(
        'div',
        { key: k, style: { marginBottom: 5 } },
        h('div', { className: 'mnv-sub', style: { justifyContent: 'space-between' } }, h('span', null, k), h('span', { className: 'mnv-num' }, v)),
        h(Bar, { value: v / totalKind }),
      ),
    ),

    h('div', { className: 'mnv-day' }, '健康度'),
    h(
      'div',
      { className: 'mnv-pillrow' },
      h('span', { className: 'mnv-chip' }, `support=1 占比 ${((s.supportOne / Math.max(1, s.cells)) * 100).toFixed(0)}%`),
      h('span', { className: 'mnv-chip' }, `争议 ${s.disputed}`),
      h('span', { className: 'mnv-chip' }, `矛盾边 ${s.contradictions}`),
      h('span', { className: 'mnv-chip' }, `已失效版本 ${s.invalidated}`),
      h('span', { className: 'mnv-chip' }, `边 ${s.edges}`),
      h('span', { className: 'mnv-chip' }, `遗忘操作 ${s.evictions}`),
    ),
    s.supportOne / Math.max(1, s.cells) > 0.7
      ? h('div', { className: 'mnv-note' }, '· support=1 占比偏高：说明记忆还没被反复确认，抽象会偏慢。这是正常早期状态，不是故障。')
      : null,

    h('div', { className: 'mnv-day' }, '调参向导（症状 → 参数）'),
    h(
      'div',
      null,
      ...TUNING.map((t, i) =>
        h(
          'div',
          { key: i, className: 'mnv-row' },
          h('div', { className: 'mnv-row-head' }, h('span', { className: 'mnv-kv' }, t.symptom), h('span', { className: 'mnv-num' }, t.first)),
          h('div', { className: 'mnv-sub' }, h('span', null, `不要动：${t.avoid}`)),
          t.action
            ? h(
                'div',
                { className: 'mnv-actions' },
                h(
                  'button',
                  {
                    className: 'mnv-btn',
                    disabled: props.busy,
                    onClick: () =>
                      props.onAct(
                        t.action!.preset
                          ? ({ kind: 'preset', preset: t.action!.preset } as PanelAction)
                          : ({ kind: 'config', patch: t.action!.patch ?? {} } as PanelAction),
                      ),
                  },
                  t.action.label,
                ),
              )
            : null,
        ),
      ),
    ),

    h('div', { className: 'mnv-day' }, '矛盾列表（需要裁决）'),
    contradictions.length === 0
      ? h('div', { className: 'mnv-note' }, '· 没有检测到矛盾')
      : h(
          'div',
          null,
          ...contradictions.slice(0, 20).map((e, i) =>
            h(
              'div',
              { key: i, className: 'mnv-row' },
              h(
                'div',
                { className: 'mnv-sub' },
                h('span', null, `${e.src.slice(-4)} ⇄ ${e.dst.slice(-4)}`),
                h('span', null, `权重 ${e.weight}`),
              ),
              h(
                'div',
                { className: 'mnv-actions' },
                h('button', { className: 'mnv-btn', onClick: () => props.onCommand(`why ${e.src.slice(-4)}`) }, '看理由'),
              ),
            ),
          ),
        ),

    h('div', { className: 'mnv-day' }, '最近遗忘操作（审计）'),
    props.snapshot.evictions.length === 0
      ? h('div', { className: 'mnv-note' }, '· 无')
      : h(
          'div',
          null,
          ...props.snapshot.evictions.slice(0, 10).map((e, i) =>
            h(
              'div',
              { key: i, className: 'mnv-sub', style: { padding: '3px 0' } },
              h('span', null, new Date(e.at).toLocaleTimeString()),
              h('span', null, `${e.cellId.slice(-4)} ${e.mode} ${e.actor}`),
              h('span', { style: { color: 'var(--mnv-fg-faint)' } }, e.reason),
            ),
          ),
        ),

    h(
      'div',
      { className: 'mnv-actions', style: { marginTop: 10 } },
      h('button', { className: 'mnv-btn', disabled: props.busy, onClick: () => props.onAct({ kind: 'refresh' }) }, '刷新'),
      h('button', { className: 'mnv-btn', onClick: () => props.onCommand('doctor') }, '体检'),
      h('button', { className: 'mnv-btn', onClick: () => props.onCommand('doctor --fix') }, '修复孤儿边'),
      h('button', { className: 'mnv-btn', onClick: () => props.onCommand('doctor --unlock') }, '清遗留锁'),
      h('button', { className: 'mnv-btn', onClick: () => props.onCommand('export') }, '导出清单'),
      h('button', { className: 'mnv-btn', onClick: () => props.onCommand('stats') }, '打印统计'),
    ),
    h(
      'div',
      { className: 'mnv-note', style: { marginTop: 10 } },
      '面板首屏 ≤200ms、单页 ≤50 条、图谱 ≤200 节点、内存 ≤30MB、关闭后释放所有订阅（§12.10）。',
    ),
  )
}
