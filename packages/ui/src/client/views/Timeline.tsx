/**
 * 时间线视图（§12.4）
 *
 * 按 t_from 倒序、按天分组。点击展开槽位；行内可 pin / 改效价 / 改重要性 / 遗忘。
 * 性能约束（§12.10）：单页 ≤ pageSize 条 + 哨兵增量加载，万级 cell 不全量渲染。
 */
import { createElement as h, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PanelAction, PanelCellView } from '@rain13sad/dsh-mnemo-core'
import { Chip, KIND_LABEL, PROV_LABEL, TIER_LABEL, dayKey, fmt2, mmdd, relTime, signed, valenceColor } from '../ui.js'

const LENS_LABEL: Record<string, string> = { fact: '事实', feeling: '感受', bond: '关系', story: '故事' }

export interface TimelineProps {
  cells: PanelCellView[]
  pageSize: number
  selectedId?: string
  onSelect: (id: string) => void
  onAct: (a: PanelAction) => void
  onExplain: (id: string) => void
  explain?: { cellId: string; text: string } | null
  busy?: boolean
}

export function Timeline(props: TimelineProps): ReactNode {
  const [limit, setLimit] = useState(props.pageSize)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [confirmHard, setConfirmHard] = useState<string | null>(null)
  const sentinel = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setLimit(props.pageSize)
  }, [props.pageSize, props.cells.length])

  useEffect(() => {
    const el = sentinel.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((n) => Math.min(props.cells.length, n + props.pageSize))
    })
    io.observe(el)
    return () => io.disconnect()
  }, [props.cells.length, props.pageSize])

  const groups = useMemo(() => {
    const out: Array<{ day: string; items: PanelCellView[] }> = []
    for (const c of props.cells.slice(0, limit)) {
      const k = dayKey(c.tFrom)
      const last = out[out.length - 1]
      if (last && last.day === k) last.items.push(c)
      else out.push({ day: k, items: [c] })
    }
    return out
  }, [props.cells, limit])

  if (props.cells.length === 0) {
    return h('div', { className: 'mnv-empty' }, h('div', null, '还没有记忆'), h('div', null, '说点什么，或换个关键词再搜'))
  }

  const toggle = (id: string) => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
  }

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-legend' },
      h('span', null, `${props.cells.length} 条`),
      h('span', null, 'V 效价 · S 显著度 · C 置信度'),
      h('span', null, '↑ 有过变更'),
    ),
    ...groups.map((g) =>
      h(
        'div',
        { key: g.day },
        h('div', { className: 'mnv-day' }, g.day),
        ...g.items.map((c) => row(c, props, expanded.has(c.cellId), toggle, confirmHard, setConfirmHard)),
      ),
    ),
    h('div', { ref: sentinel, className: 'mnv-scroll-sentinel' }),
    limit < props.cells.length
      ? h('div', { style: { textAlign: 'center', padding: 8 } }, h('button', { className: 'mnv-btn', onClick: () => setLimit((n) => n + props.pageSize) }, `加载更多（${props.cells.length - limit}）`))
      : null,
  )
}

function row(
  c: PanelCellView,
  props: TimelineProps,
  isOpen: boolean,
  toggle: (id: string) => void,
  confirmHard: string | null,
  setConfirmHard: (id: string | null) => void,
): ReactNode {
  const kv = c.kv.map(([k, v]) => `${k}=${v}`).join(' ') || c.digest || '（无键值）'
  const selected = props.selectedId === c.cellId
  return h(
    'div',
    { key: c.cellId, className: 'mnv-row', 'data-selected': selected, 'data-dim': c.tier >= 3 },
    h(
      'div',
      { className: 'mnv-row-head', onClick: () => props.onSelect(c.cellId), style: { cursor: 'pointer' } },
      h('span', { className: 'mnv-dot', style: { background: valenceColor(c.valence) } }),
      h('span', { className: 'mnv-kind' }, KIND_LABEL[c.kind] ?? '事实'),
      h('span', { className: 'mnv-kv', title: kv }, kv),
      c.emotional ? h('span', { className: 'mnv-flag', title: '情感记忆：不参与情绪衰减', style: { color: 'var(--mnv-pos)' } }, '♥') : null,
      c.changed ? h('span', { className: 'mnv-flag', title: '存在 SUPERSEDES 或争议' }, '↑') : null,
      c.invalidated
        ? h('span', { className: 'mnv-kind', title: '已被更新的版本取代（仍保留，可回溯）', style: { color: 'var(--mnv-warn)' } }, '已失效')
        : null,
      h('span', { className: 'mnv-num' }, `V${signed(c.valence)} S${fmt2(c.salience)} C${fmt2(c.confidence)}`),
    ),
    h(
      'div',
      { className: 'mnv-sub' },
      h('span', null, mmdd(c.tFrom)),
      h('span', null, `${TIER_LABEL[c.tier] ?? '温'}层`),
      h('span', null, LENS_LABEL[c.lens ?? 'fact'] ?? '事实'),
      h('span', null, PROV_LABEL[c.provenance] ?? '用户'),
      h('span', null, `support ${c.support}`),
      h('span', null, `访问 ${c.accessCount}`),
      c.invalidated ? h('span', { style: { color: 'var(--mnv-warn)' } }, `失效于 ${mmdd(c.tInvalid)}`) : null,
      c.pinned ? h('span', { style: { color: 'var(--mnv-warn)' } }, '已固定') : null,
      c.residualChars ? h('span', null, `残差 ${c.residualChars}B`) : null,
    ),
    h(
      'div',
      { className: 'mnv-actions' },
      h('button', { className: 'mnv-btn', onClick: () => toggle(c.cellId) }, isOpen ? '收起' : '展开'),
      h('button', { className: 'mnv-btn', onClick: () => props.onExplain(c.cellId) }, '为什么'),
      h('button', { className: 'mnv-btn', onClick: () => props.onAct({ kind: 'pin', cellId: c.cellId, pinned: !c.pinned }) }, c.pinned ? '取消固定' : '固定'),
      h(
        'button',
        {
          className: 'mnv-btn',
          'data-tone': 'danger',
          onClick: () => {
            if (confirmHard === c.cellId) {
              props.onAct({ kind: 'forget', cellId: c.cellId, mode: 'hard', confirm: 'delete' })
              setConfirmHard(null)
            } else {
              setConfirmHard(c.cellId)
            }
          },
        },
        confirmHard === c.cellId ? '确认物理删除（不可恢复）' : '删除',
      ),
      confirmHard === c.cellId
        ? h(
            'button',
            {
              className: 'mnv-btn',
              'data-tone': 'ghost',
              onClick: () => {
                props.onAct({ kind: 'forget', cellId: c.cellId, mode: 'soft' })
                setConfirmHard(null)
              },
            },
            '改为软删',
          )
        : null,
    ),
    isOpen
      ? h(
          'div',
          { style: { marginTop: 8, borderTop: '1px solid var(--mnv-border)', paddingTop: 8 } },
          h(
            'div',
            { className: 'mnv-sub', style: { marginBottom: 6 } },
            h('span', null, `cell ${c.shortId}`),
            h('span', null, `稳定性 S=${fmt2(c.stability)} 天`),
            h('span', null, `重要性 ${fmt2(c.importance)}`),
            h('span', null, c.disputed ? '有争议' : '无争议'),
          ),
          h(
            'div',
            { style: { display: 'grid', gap: 4, marginBottom: 8 } },
            ...c.slots.map((s, i) =>
              h(
                'div',
                { key: i, className: 'mnv-sub' },
                h('span', { style: { minWidth: 70, color: 'var(--mnv-fg-faint)' } }, roleName(s.role)),
                h('span', null, s.type === 'UNK' ? 'UNK（未提及）' : s.value),
              ),
            ),
          ),
          h(
            'div',
            { className: 'mnv-actions' },
            h(
              'label',
              { className: 'mnv-slider' },
              '效价',
              h('input', {
                type: 'range',
                min: -1,
                max: 1,
                step: 0.05,
                defaultValue: c.valence,
                onMouseUp: (e: { currentTarget: HTMLInputElement }) =>
                  props.onAct({ kind: 'valence', cellId: c.cellId, valence: Number(e.currentTarget.value) }),
              }),
              h('span', { className: 'mnv-num' }, signed(c.valence)),
            ),
            h(
              'label',
              { className: 'mnv-slider' },
              '重要性',
              h('input', {
                type: 'range',
                min: 0,
                max: 1,
                step: 0.05,
                defaultValue: c.importance,
                onMouseUp: (e: { currentTarget: HTMLInputElement }) =>
                  props.onAct({ kind: 'importance', cellId: c.cellId, importance: Number(e.currentTarget.value) }),
              }),
              h('span', { className: 'mnv-num' }, fmt2(c.importance)),
            ),
          ),
          h(
            'div',
            { className: 'mnv-note', style: { marginTop: 6 } },
            'support 不可手改——它是证据计数，能手改双置信度机制就失效了。想提升权重请用「固定」或「重要性」。',
          ),
        )
      : null,
    props.explain && props.explain.cellId === c.cellId
      ? h('div', { className: 'mnv-explain', dangerouslySetInnerHTML: { __html: highlight(props.explain.text) } })
      : null,
  )
}

function roleName(role: number): string {
  const names: Record<number, string> = {
    1: 'AGENT',
    2: 'PATIENT',
    3: 'PRED',
    4: 'TIME',
    5: 'PLACE',
    6: 'MANNER',
    7: 'GOAL',
    8: 'QTY',
    9: 'POLARITY',
  }
  return names[role] ?? String(role)
}

function highlight(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/(总分 [\d.]+)/g, '<b>$1</b>')
}

export { Chip }
