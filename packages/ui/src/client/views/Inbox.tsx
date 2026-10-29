/**
 * 收件箱（"需要我决定的事"）
 *
 * 三类东西进这里：
 *   ① 待确认 —— support=1 且重要性不低：只被说过一次，但可能很重要
 *   ② 争议   —— 被新版本取代或与既有记忆冲突
 *   ③ 矛盾边 —— 需要人来裁决"哪个才算现在为真"
 *
 * 设计上刻意**不自动裁决**：自动选"更新的那个"在事实层面通常对，
 * 在偏好层面经常错（"我上次说喜欢，但那是客套"）。所以这里只提供按钮。
 */
import { createElement as h, type ReactNode } from 'react'
import type { PanelAction, PanelCellView, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import { KIND_LABEL, SubHead, fmt2, relTime, signed } from '../ui.js'

export interface InboxProps {
  snapshot: PanelSnapshot
  onAct: (a: PanelAction) => void
  onCommand: (line: string) => void
  onOpen: (cellId: string) => void
  busy?: boolean
}

export function Inbox(props: InboxProps): ReactNode {
  const pendingAll = props.snapshot.pending ?? []
  const pending = pendingAll.slice(0, 30)
  const disputed = props.snapshot.cells.filter((c) => c.disputed)
  const conflicts = props.snapshot.edges.filter((e) => e.relName === 'CONTRADICTS')
  const cellById = new Map(props.snapshot.cells.map((c) => [c.cellId, c]))

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-panel', 'data-tone': 'sunken' },
      h(
        'div',
        { className: 'mnv-sub', style: { marginTop: 0 } },
        h('span', null, `待确认 ${pendingAll.length}${pendingAll.length > pending.length ? `（显示前 ${pending.length}）` : ''}`),
        h('span', null, `争议 ${disputed.length}`),
        h('span', null, `矛盾边 ${conflicts.length}`),
        h('span', { className: 'mnv-spacer' }),
        h('span', { className: 'mnv-muted' }, '确认会把 support +1（算一条独立证据），忽略只降重要性不删除'),
      ),
    ),

    h(SubHead, { title: '待确认', hint: '只被说过一次，但重要性不低' }),
    pending.length === 0
      ? h('div', { className: 'mnv-muted' }, '没有待确认的记忆')
      : pending.map((c) =>
          h(
            'div',
            { key: c.cellId, className: 'mnv-row' },
            h(
              'div',
              { className: 'mnv-row-head' },
              h('span', { className: 'mnv-kind' }, KIND_LABEL[c.kind] ?? '事实'),
              h('span', { className: 'mnv-kv', title: c.digest }, c.digest || c.kv.map(([k, v]) => `${k}=${v}`).join(' ')),
              c.disputed ? h('span', { className: 'mnv-flag' }, '争议') : null,
            ),
            h(
              'div',
              { className: 'mnv-sub' },
              h('span', null, `#${c.shortId}`),
              h('span', null, relTime(c.tFrom)),
              h('span', null, `support ${c.support}`),
              h('span', null, `重要性 ${fmt2(c.importance)}`),
              h('span', null, `V${signed(c.valence)}`),
            ),
            h(
              'div',
              { className: 'mnv-actions' },
              h('button', { className: 'mnv-btn', disabled: props.busy, onClick: () => props.onAct({ kind: 'confirm', cellId: c.cellId }) }, '确认'),
              h('button', { className: 'mnv-btn', 'data-tone': 'ghost', disabled: props.busy, onClick: () => props.onAct({ kind: 'dismiss', cellId: c.cellId }) }, '忽略'),
              h('button', { className: 'mnv-btn', onClick: () => props.onOpen(c.cellId) }, '看详情'),
            ),
          ),
        ),

    h(SubHead, { title: '冲突与异常', hint: '同 (施事, 谓词) 但客体或极性冲突' }),
    conflicts.length === 0
      ? h('div', { className: 'mnv-muted' }, '没有检测到矛盾')
      : conflicts.slice(0, 12).map((e, i) => {
          const a = cellById.get(e.src)
          const b = cellById.get(e.dst)
          return h(
            'div',
            { key: i, className: 'mnv-row' },
            h(
              'div',
              { className: 'mnv-row-head' },
              h('span', { className: 'mnv-kind' }, '矛盾'),
              h('span', { className: 'mnv-kv' }, `${a?.digest ?? e.src.slice(-4)}  ⇄  ${b?.digest ?? e.dst.slice(-4)}`),
              h('span', { className: 'mnv-num' }, `权重 ${e.weight}`),
            ),
            h(
              'div',
              { className: 'mnv-actions' },
              h('button', { className: 'mnv-btn', onClick: () => props.onAct({ kind: 'resolve', a: e.src, b: e.dst }) }, `以 ${e.src.slice(-4)} 为准`),
              h('button', { className: 'mnv-btn', onClick: () => props.onAct({ kind: 'resolve', a: e.dst, b: e.src }) }, `以 ${e.dst.slice(-4)} 为准`),
              h('button', { className: 'mnv-btn', onClick: () => props.onCommand(`why ${e.src.slice(-4)}`) }, '看理由'),
            ),
          )
        }),
  )
}
