/**
 * 图谱视图（§12.4）
 *
 * 以选中 cell 为中心的 2 跳邻域，边按 rel 着色。
 * 布局不用力导向（每次渲染位置会变，用户找不到东西），改用**确定性同心圆**：
 * 中心 → 第一跳均匀分布 → 第二跳外圈。节点上限 graphMaxNodes，超过截断并标注。
 */
import { createElement as h, useMemo, type ReactNode } from 'react'
import type { PanelCellView, PanelEdgeView } from '@bcf/dsh-mnemo-core'
import { KIND_LABEL, fmt2, signed, valenceColor } from '../ui.js'

export interface GraphProps {
  cells: PanelCellView[]
  edges: PanelEdgeView[]
  selectedId?: string
  maxNodes: number
  onSelect: (id: string) => void
}

const REL_COLOR: Record<string, string> = {
  CONTRADICTS: 'var(--mnv-danger)',
  SUPERSEDES: 'var(--mnv-warn)',
  PART_OF: 'var(--mnv-accent)',
  SAME_AS: 'var(--mnv-accent)',
  ASSOC: 'var(--mnv-fg-faint)',
  IS_A: 'var(--mnv-neg)',
  CAUSES: 'var(--mnv-pos)',
  BEFORE: 'var(--mnv-fg-soft)',
  EVIDENCE: 'var(--mnv-neg)',
}

export function Graph(props: GraphProps): ReactNode {
  const model = useMemo(() => layout(props), [props.cells, props.edges, props.selectedId, props.maxNodes])

  if (!props.selectedId) {
    return h('div', { className: 'mnv-empty' }, h('div', null, '先在时间线里选一条记忆'), h('div', null, '图谱会以它为中心展开 2 跳邻域'))
  }
  if (model.nodes.length <= 1) {
    return h('div', { className: 'mnv-empty' }, h('div', null, '这条记忆还没有关联'), h('div', null, '关联由写入时的 SAME_AS / PART_OF 与 REM 巩固的 ASSOC 产生'))
  }

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-legend' },
      ...Object.entries(REL_COLOR)
        .slice(0, 5)
        .map(([k, v]) => h('span', { key: k }, h('span', { className: 'mnv-swatch', style: { background: v } }), ' ' + k)),
      model.truncated ? h('span', { style: { color: 'var(--mnv-warn)' } }, `已截断到 ${props.maxNodes} 个节点`) : null,
    ),
    h(
      'svg',
      { className: 'mnv-graph', viewBox: '0 0 360 320', preserveAspectRatio: 'xMidYMid meet' },
      ...model.edges.map((e, i) =>
        h('line', {
          key: 'e' + i,
          x1: e.x1,
          y1: e.y1,
          x2: e.x2,
          y2: e.y2,
          stroke: REL_COLOR[e.relName] ?? 'var(--mnv-border)',
          strokeWidth: Math.max(0.6, Math.min(2.4, e.weight / 48)),
          strokeOpacity: 0.7,
        }),
      ),
      ...model.nodes.map((n) =>
        h(
          'g',
          { key: n.id, onClick: () => props.onSelect(n.id), style: { cursor: 'pointer' } },
          h('circle', {
            cx: n.x,
            cy: n.y,
            r: n.r,
            fill: valenceColor(n.valence),
            fillOpacity: n.hop === 0 ? 0.95 : 0.55,
            stroke: n.id === props.selectedId ? 'var(--mnv-accent)' : 'var(--mnv-bg)',
            strokeWidth: n.id === props.selectedId ? 2 : 1,
          }),
          h('text', { x: n.x, y: n.y + n.r + 11, textAnchor: 'middle' }, n.label),
        ),
      ),
    ),
    h(
      'div',
      { className: 'mnv-note' },
      `中心 ${model.center?.shortId ?? ''} · ${model.nodes.length} 个节点 · ${model.edges.length} 条边。点节点切换中心。`,
    ),
  )
}

interface LayoutNode {
  id: string
  x: number
  y: number
  r: number
  hop: number
  label: string
  valence: number
  shortId: string
}
interface LayoutEdge {
  x1: number
  y1: number
  x2: number
  y2: number
  relName: string
  weight: number
}

export function layout(props: GraphProps): {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  center?: PanelCellView
  truncated: boolean
} {
  const byId = new Map(props.cells.map((c) => [c.cellId, c]))
  const center = props.selectedId ? byId.get(props.selectedId) : undefined
  if (!center) return { nodes: [], edges: [], truncated: false }

  const adj = new Map<string, PanelEdgeView[]>()
  for (const e of props.edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue
    if (!adj.has(e.src)) adj.set(e.src, [])
    if (!adj.has(e.dst)) adj.set(e.dst, [])
    adj.get(e.src)!.push(e)
    adj.get(e.dst)!.push(e)
  }

  const hop1 = (adj.get(center.cellId) ?? []).map((e) => (e.src === center.cellId ? e.dst : e.src))
  const hop1Set = new Set(hop1)
  const hop2: string[] = []
  for (const id of hop1) {
    for (const e of adj.get(id) ?? []) {
      const other = e.src === id ? e.dst : e.src
      if (other === center.cellId || hop1Set.has(other)) continue
      if (!hop2.includes(other)) hop2.push(other)
    }
  }

  const cap = Math.max(10, props.maxNodes)
  const truncated = 1 + hop1.length + hop2.length > cap
  const ring1 = hop1.slice(0, Math.max(4, Math.floor(cap * 0.45)))
  const ring2 = hop2.slice(0, Math.max(4, cap - 1 - ring1.length))

  const cx = 180
  const cy = 158
  const nodes: LayoutNode[] = [
    { id: center.cellId, x: cx, y: cy, r: 9, hop: 0, label: center.shortId, valence: center.valence, shortId: center.shortId },
  ]
  ring1.forEach((id, i) => {
    const c = byId.get(id)!
    const a = (i / Math.max(1, ring1.length)) * Math.PI * 2 - Math.PI / 2
    nodes.push({
      id,
      x: cx + Math.cos(a) * 78,
      y: cy + Math.sin(a) * 66,
      r: 6,
      hop: 1,
      label: c.shortId,
      valence: c.valence,
      shortId: c.shortId,
    })
  })
  ring2.forEach((id, i) => {
    const c = byId.get(id)!
    const a = (i / Math.max(1, ring2.length)) * Math.PI * 2 - Math.PI / 2 + 0.2
    nodes.push({
      id,
      x: cx + Math.cos(a) * 145,
      y: cy + Math.sin(a) * 122,
      r: 4.5,
      hop: 2,
      label: '',
      valence: c.valence,
      shortId: c.shortId,
    })
  })

  const pos = new Map(nodes.map((n) => [n.id, n]))
  const edges: LayoutEdge[] = []
  for (const e of props.edges) {
    const a = pos.get(e.src)
    const b = pos.get(e.dst)
    if (!a || !b) continue
    edges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, relName: e.relName, weight: e.weight })
  }
  return { nodes, edges, center, truncated }
}

export { KIND_LABEL, fmt2, signed }
