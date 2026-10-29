/**
 * 记忆检索（§12.4 的"查得到"）
 *
 * 与"时间线"的区别：时间线回答"最近记了什么"，检索回答"我要找的那条在不在、
 * 为什么它排第一"。所以每条结果都要带**通道与分数**，并且能就地展开解释器输出——
 * 只给一个列表而不给理由，用户没法判断是"没记住"还是"没找到"。
 */
import { createElement as h, type ReactNode } from 'react'
import type { PanelAction, PanelCellView, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import { CHANNEL_LABEL, KIND_LABEL, TIER_LABEL, fmt2, relTime, signed, valenceColor } from '../ui.js'

export interface SearchProps {
  snapshot: PanelSnapshot
  cells: PanelCellView[]
  query: string
  onQuery: (q: string) => void
  kind: string
  onKind: (k: string) => void
  lens: string
  onLens: (l: string) => void
  selectedId?: string
  onSelect: (id: string) => void
  onExplain: (id: string) => void
  onAct: (a: PanelAction) => void
  onCommand?: (line: string) => void
  explain?: { cellId: string; text: string } | null
  busy?: boolean
}

const KINDS: Array<[string, string]> = [
  ['all', '全部类型'],
  ['1', '语义'],
  ['0', '情景'],
  ['2', '程序'],
  ['3', '图式'],
  ['4', '人格锚'],
  ['5', '关系'],
  ['6', '叙事'],
]

const LENSES: Array<[string, string]> = [
  ['all', '全部视角'],
  ['fact', '事实'],
  ['feeling', '感受'],
  ['bond', '关系'],
  ['story', '故事'],
]

export function Search(props: SearchProps): ReactNode {
  const recall = props.snapshot.lastRecall
  const hitById = new Map((recall?.hits ?? []).map((x) => [x.cellId, x]))
  const bdById = new Map((recall?.breakdowns ?? []).map((x) => [x.cellId, x]))

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-panel', style: { marginBottom: 8 } },
      h('input', {
        className: 'mnv-input',
        placeholder: '检索记忆：实体、键值、原文片段，或一句自然语言',
        value: props.query,
        onInput: (e: { currentTarget: HTMLInputElement }) => props.onQuery(e.currentTarget.value),
        autoFocus: true,
      }),
      h(
        'div',
        { className: 'mnv-pillrow', style: { marginTop: 8, marginBottom: 0 } },
        h(
          'select',
          { className: 'mnv-select', value: props.kind, onChange: (e: { currentTarget: HTMLSelectElement }) => props.onKind(e.currentTarget.value) },
          ...KINDS.map(([v, l]) => h('option', { key: v, value: v }, l)),
        ),
        h(
          'select',
          { className: 'mnv-select', value: props.lens, onChange: (e: { currentTarget: HTMLSelectElement }) => props.onLens(e.currentTarget.value) },
          ...LENSES.map(([v, l]) => h('option', { key: v, value: v }, l)),
        ),
        h('button', { className: 'mnv-btn', onClick: () => props.onQuery('') }, '清空'),
        h('span', { className: 'mnv-spacer' }),
        h('span', { className: 'mnv-muted' }, `${props.cells.length} 条`),
      ),
    ),

    recall
      ? h(
          'div',
          { className: 'mnv-panel', 'data-tone': 'sunken' },
          h(
            'div',
            { className: 'mnv-sub',
              style: { marginTop: 0 } },
            h('span', null, `最近一次注入 · ${relTime(recall.at)}`),
            h('span', null, `策略 ${recall.hits.length ? recall.hits[0].channel : '—'}`),
            h('span', null, `${recall.tokens} token`),
            h('span', null, `命中 ${recall.hits.length}`),
          ),
        )
      : null,

    props.cells.length === 0
      ? h('div', { className: 'mnv-empty' }, h('div', null, props.query ? '没有匹配的记忆' : '还没有记忆'), h('div', null, props.query ? '换个说法，或把类型/视角放宽' : '说点什么，或让模型调用 memory_assert'))
      : props.cells.map((c) => {
          const hit = hitById.get(c.cellId)
          const bd = bdById.get(c.cellId)
          const selected = props.selectedId === c.cellId
          const open = props.explain?.cellId === c.cellId
          return h(
            'div',
            { key: c.cellId, className: 'mnv-row', 'data-selected': selected },
            h(
              'div',
              { className: 'mnv-row-head', style: { cursor: 'pointer' }, onClick: () => props.onSelect(c.cellId) },
              h('span', { className: 'mnv-dot', style: { background: valenceColor(c.valence) } }),
              h('span', { className: 'mnv-kind' }, KIND_LABEL[c.kind] ?? '事实'),
              h('span', { className: 'mnv-kv', title: c.digest }, c.digest || c.kv.map(([k, v]) => `${k}=${v}`).join(' ')),
              hit ? h('span', { className: 'mnv-chip' }, CHANNEL_LABEL[hit.channel] ?? hit.channel) : null,
              hit ? h('span', { className: 'mnv-score' }, fmt2(hit.score)) : null,
            ),
            h(
              'div',
              { className: 'mnv-sub' },
              h('span', null, `#${c.shortId}`),
              h('span', null, `${TIER_LABEL[c.tier] ?? '温'}层`),
              h('span', null, relTime(c.tFrom)),
              h('span', null, `support ${c.support}`),
              h('span', null, `V${signed(c.valence)} C${fmt2(c.confidence)}`),
              c.invalidated ? h('span', { style: { color: 'var(--mnv-warn)' } }, '已失效版本') : null,
              c.pinned ? h('span', { style: { color: 'var(--mnv-warn)' } }, '已固定') : null,
            ),
            h(
              'div',
              { className: 'mnv-actions' },
              h('button', { className: 'mnv-btn', onClick: () => props.onExplain(c.cellId) }, open ? '收起理由' : '为什么'),
              h('button', { className: 'mnv-btn', onClick: () => props.onAct({ kind: 'pin', cellId: c.cellId, pinned: !c.pinned }) }, c.pinned ? '取消固定' : '固定'),
              // 不再放「命令解释」：三个按钮挤在一行会让列表变吵，
              // 「为什么」已经给出同一份 breakdown，命令面留给需要精确复现的人。
            ),
            open && props.explain
              ? h(
                  'div',
                  { className: 'mnv-explain' },
                  h('div', { style: { whiteSpace: 'pre-wrap' } }, props.explain.text),
                  bd
                    ? h(
                        'div',
                        { style: { marginTop: 6, color: 'var(--mnv-fg-faint)' } },
                        `通道 ${CHANNEL_LABEL[bd.channel] ?? bd.channel} · 原始分 ${fmt2(bd.rawSum)} / Σw ${fmt2(bd.activeW)}`,
                      )
                    : null,
                )
              : null,
          )
        }),
  )
}
