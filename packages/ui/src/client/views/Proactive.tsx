/**
 * 主动开口面板（§12 扩展）
 *
 * 这一页的核心不是"让它多说"，而是**让人敢打开它**：
 * 频率、静默时段、今日用量、为什么没说——四件事都摆在明面上，
 * 用户才敢把"主动"开关打开。参考产品里把主动消息做成一键开关的，用户第一反应是关掉。
 */
import { createElement as h, type ReactNode } from 'react'
import type { PanelAction, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import { Metric, fmt2 } from '../ui.js'

export interface ProactiveProps {
  snapshot: PanelSnapshot
  onAct: (a: PanelAction) => void
  busy?: boolean
}

const KIND_LABEL: Record<string, string> = {
  emotion: '未平复的情绪',
  milestone: '关系里程碑',
  associate: '联想',
  memory: '旧事重提',
  silence: '单纯问候',
}

export function Proactive(props: ProactiveProps): ReactNode {
  const p = props.snapshot.proactive
  if (!p) {
    return h(
      'div',
      { className: 'mnv-empty' },
      h('div', null, '主动开口未启用'),
      h('div', null, '安装 @rain13sad/dsh-mnemo-proactive 后，这里会出现频率、静默时段与候选预览。'),
    )
  }

  const canSpeak = !p.blocked
  const next = p.nextEligibleAt ? new Date(p.nextEligibleAt) : null
  const set = (patch: Record<string, number | boolean>) => props.onAct({ kind: 'proactive', action: 'config', patch })

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-grid', style: { marginBottom: 8 } },
      h(Metric, { label: '今日已主动', value: `${p.todayCount}/${p.maxPerDay}`, hint: '超过上限当天不再开口' }),
      h(Metric, { label: '最小间隔', value: p.minIntervalMin, unit: '分', hint: '两次主动之间至少隔这么久' }),
      h(Metric, { label: '静默时段', value: `${p.quietStart}–${p.quietEnd}`, unit: '点', hint: '跨夜用 start > end 表示' }),
      h(Metric, { label: '空闲阈值', value: p.idleMin, unit: '分', hint: '用户刚说过话就不打扰' }),
    ),

    h(
      'div',
      { className: 'mnv-pillrow' },
      h('span', { className: 'mnv-chip', style: { color: canSpeak ? 'var(--mnv-neg)' : 'var(--mnv-warn)' } }, canSpeak ? '当前可以开口' : `当前不会开口：${p.blocked}`),
      next ? h('span', { className: 'mnv-chip' }, `下次最早 ${next.toLocaleTimeString()}`) : null,
      p.lastAt ? h('span', { className: 'mnv-chip' }, `上次 ${new Date(p.lastAt).toLocaleString()}`) : null,
    ),

    h('div', { className: 'mnv-day' }, '频率与时段'),
    row('最小间隔', `${p.minIntervalMin} 分钟`, [
      [15, '15 分'],
      [45, '45 分'],
      [120, '2 小时'],
      [360, '6 小时'],
    ].map(([v, label]) => ({ label: String(label), on: () => set({ minIntervalMin: Number(v) }), active: p.minIntervalMin === v }))),
    row('每日上限', `${p.maxPerDay} 次`, [1, 2, 3, 5].map((v) => ({ label: `${v} 次`, on: () => set({ maxPerDay: v }), active: p.maxPerDay === v }))),
    row('静默开始', `${p.quietStart} 点`, [21, 22, 23, 0].map((v) => ({ label: `${v} 点`, on: () => set({ quietStart: v }), active: p.quietStart === v }))),
    row('静默结束', `${p.quietEnd} 点`, [6, 7, 8, 9].map((v) => ({ label: `${v} 点`, on: () => set({ quietEnd: v }), active: p.quietEnd === v }))),
    row('必须有由头', p.enabled ? '开启' : '关闭', [
      { label: '开（只在有具体的事时说话）', on: () => set({ requireReason: true }), active: true },
      { label: '关（允许单纯打招呼）', on: () => set({ requireReason: false }), active: false },
    ]),

    h('div', { className: 'mnv-day' }, '它想说的一句（候选）'),
    p.lastCandidate
      ? h(
          'div',
          { className: 'mnv-row' },
          h(
            'div',
            { className: 'mnv-row-head' },
            h('span', { className: 'mnv-kind' }, KIND_LABEL[p.lastCandidate.kind] ?? p.lastCandidate.kind),
            h('span', { className: 'mnv-kv' }, p.lastCandidate.reason),
            h('span', { className: 'mnv-num' }, `紧迫 ${fmt2(p.lastCandidate.urgency)}`),
          ),
          h('div', { className: 'mnv-explain', style: { marginTop: 6 } }, p.lastCandidate.text),
          p.lastCandidate.cellIds.length
            ? h('div', { className: 'mnv-sub' }, h('span', null, '相关记忆 ' + p.lastCandidate.cellIds.map((x) => x.slice(-4)).join(' ')))
            : null,
        )
      : h('div', { className: 'mnv-note' }, '还没有候选。它只在"有具体由头"时才会开口。'),

    h(
      'div',
      { className: 'mnv-actions', style: { marginTop: 8 } },
      h('button', { className: 'mnv-btn', disabled: props.busy, onClick: () => props.onAct({ kind: 'proactive', action: 'now' }) }, '现在试一次'),
      h('button', { className: 'mnv-btn', onClick: () => props.onAct({ kind: 'proactive', action: 'mute', minutes: 120 }) }, '静音 2 小时'),
      h('button', { className: 'mnv-btn', onClick: () => props.onAct({ kind: 'proactive', action: 'unmute' }) }, '解除静音'),
    ),

    h('div', { className: 'mnv-day' }, '最近为什么没说'),
    p.skipped.length === 0
      ? h('div', { className: 'mnv-note' }, '· 无记录')
      : h(
          'div',
          null,
          ...p.skipped.slice().reverse().map((s, i) =>
            h(
              'div',
              { key: i, className: 'mnv-sub', style: { padding: '2px 0' } },
              h('span', null, new Date(s.at).toLocaleTimeString()),
              h('span', { style: { color: 'var(--mnv-fg-faint)' } }, s.reason),
            ),
          ),
        ),

    h(
      'div',
      { className: 'mnv-note', style: { marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--mnv-border)' } },
      '主动发言只是"给模型的提示"，台词由模型自己说——插件不替它写话，否则每句话都会是同一个模板。',
      h('br'),
      '⚠ 真正"先开口"需要宿主提供 steering 通道；没有时，候选会在你下次说话时作为提示注入。',
    ),
  )
}

function row(
  label: string,
  value: string,
  options: Array<{ label: string; on: () => void; active: boolean }>,
): ReactNode {
  return h(
    'div',
    { style: { marginBottom: 6 } },
    h('div', { className: 'mnv-sub', style: { justifyContent: 'space-between' } }, h('span', null, label), h('span', { className: 'mnv-num' }, value)),
    h(
      'div',
      { className: 'mnv-actions', style: { marginTop: 3 } },
      ...options.map((o, i) =>
        h(
          'button',
          { key: i, className: 'mnv-btn', 'data-tone': o.active ? undefined : 'ghost', onClick: o.on, style: o.active ? { borderColor: 'var(--mnv-accent)' } : undefined },
          o.label,
        ),
      ),
    ),
  )
}
