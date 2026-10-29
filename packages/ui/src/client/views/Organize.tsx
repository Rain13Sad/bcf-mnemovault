/**
 * 记忆整理（§12.4 的"整理得动"）
 *
 * 这一页把"巩固"从后台黑盒变成可操作的动作：
 *   · 立即跑一次双相巩固（NREM 合并 / REM 情绪衰减）
 *   · 看版本链（被取代但保留的旧版本，不是垃圾，是信息）
 *   · 看图谱（联想边是共激活长出来的，不是随机连的）
 *   · 看遗忘审计（谁在什么时候删了什么、为什么）
 */
import { createElement as h, type ReactNode } from 'react'
import type { PanelAction, PanelCellView, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import { KIND_LABEL, SubHead, fmt2, fmtTime, relTime } from '../ui.js'
import { Graph } from './Graph.js'

export interface OrganizeProps {
  snapshot: PanelSnapshot
  selectedId?: string
  onAct: (a: PanelAction) => void
  onCommand: (line: string) => void
  onOpen: (cellId: string) => void
  busy?: boolean
  graphMaxNodes: number
}

export function Organize(props: OrganizeProps): ReactNode {
  const s = props.snapshot.stats
  const chain = props.snapshot.cells.filter((c) => c.invalidated).sort((a, b) => b.tFrom - a.tFrom)
  const weak = props.snapshot.cells.filter((c) => c.support <= 1 && !c.invalidated)
  const assoc = props.snapshot.edges.filter((e) => e.relName === 'ASSOC').length
  const supersedes = props.snapshot.edges.filter((e) => e.relName === 'SUPERSEDES').length
  const c = props.snapshot.consolidation

  return h(
    'div',
    null,
    h(
      'div',
      { className: 'mnv-panel' },
      h('div', { className: 'mnv-subhead', style: { marginTop: 0 } }, h('b', null, '双相巩固'), h('span', null, 'NREM 合并 + REM 情绪衰减')),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '最近一次'),
        h('span', null, c ? `${fmtTime(c.at)} · 合并 ${c.merged} · 抽象 ${c.abstracted} · 剪枝 ${c.pruned} · ${c.elapsedMs}ms` : '还没有跑过'),
      ),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '联想边'), h('span', null, `${assoc} 条（共激活长出来的，不是随机连的）`)),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '版本链'), h('span', null, `${supersedes} 条 SUPERSEDES · ${chain.length} 条已失效版本`)),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '单证据记忆'), h('span', null, `${weak.length} 条 support=1（抽象会偏慢，属正常早期状态）`)),
      h(
        'div',
        { className: 'mnv-actions' },
        h('button', { className: 'mnv-btn', disabled: props.busy, onClick: () => props.onAct({ kind: 'consolidate' }) }, '立即整理'),
        h('button', { className: 'mnv-btn', onClick: () => props.onCommand('doctor') }, '体检'),
        h('button', { className: 'mnv-btn', onClick: () => props.onCommand('doctor --fix') }, '修孤儿边'),
        h('button', { className: 'mnv-btn', onClick: () => props.onCommand('rebuild --from-log --yes') }, '从日志重建'),
      ),
    ),

    h(SubHead, { title: '图谱', hint: `${props.snapshot.edges.length} 条边 · 节点上限 ${props.graphMaxNodes}` }),
    h(
      'div',
      { className: 'mnv-panel', style: { padding: 4 } },
      h(Graph, {
        cells: props.snapshot.cells,
        edges: props.snapshot.edges,
        // 没选节点时默认以"连接最多"的那条为中心：空图比"随便给个中心"更糟——
        // 用户看到空白会以为图谱坏了，其实只是没选中。
        selectedId: props.selectedId ?? mostConnected(props.snapshot),
        maxNodes: props.graphMaxNodes,
        onSelect: (id: string) => props.onOpen(id),
      }),
    ),

    h(SubHead, { title: '版本链', hint: '被取代的旧版本不删——"以前是这么定的"本身是信息' }),
    chain.length === 0
      ? h('div', { className: 'mnv-muted' }, '没有失效版本')
      : chain.slice(0, 20).map((cell) => h(Row, { key: cell.cellId, cell, onOpen: props.onOpen, onAct: props.onAct })),

    h(SubHead, { title: '遗忘审计', hint: '软删可唤醒，硬删不可撤销' }),
    props.snapshot.evictions.length === 0
      ? h('div', { className: 'mnv-muted' }, '没有遗忘操作')
      : h(
          'div',
          { className: 'mnv-panel' },
          ...props.snapshot.evictions.slice(0, 12).map((e, i) =>
            h(
              'div',
              { key: i, className: 'mnv-kvrow' },
              h('span', null, fmtTime(e.at)),
              h('span', null, `${e.cellId.slice(-4)} · ${e.mode === 'hard' ? '物理删除' : '软删除'} · ${e.actor} · ${e.reason}`),
            ),
          ),
        ),
  )
}

/** 度数最高的 cell：图谱默认以它为中心展开。 */
function mostConnected(snap: PanelSnapshot): string | undefined {
  if (snap.edges.length === 0) return snap.cells[0]?.cellId
  const deg = new Map<string, number>()
  for (const e of snap.edges) {
    deg.set(e.src, (deg.get(e.src) ?? 0) + 1)
    deg.set(e.dst, (deg.get(e.dst) ?? 0) + 1)
  }
  let best: string | undefined
  let max = -1
  for (const [id, n] of deg) {
    if (n > max) {
      max = n
      best = id
    }
  }
  return best ?? snap.cells[0]?.cellId
}

function Row(props: { cell: PanelCellView; onOpen: (id: string) => void; onAct: (a: PanelAction) => void }): ReactNode {
  const c = props.cell
  return h(
    'div',
    { className: 'mnv-row', 'data-dim': true },
    h(
      'div',
      { className: 'mnv-row-head' },
      h('span', { className: 'mnv-kind' }, KIND_LABEL[c.kind] ?? '事实'),
      h('span', { className: 'mnv-kv', title: c.digest }, c.digest || c.kv.map(([k, v]) => `${k}=${v}`).join(' ')),
      h('span', { className: 'mnv-num' }, c.tInvalid ? `失效于 ${relTime(c.tInvalid)}` : '—'),
    ),
    h(
      'div',
      { className: 'mnv-sub' },
      h('span', null, `#${c.shortId}`),
      h('span', null, `写入 ${relTime(c.tFrom)}`),
      h('span', null, `重要性 ${fmt2(c.importance)}`),
    ),
    h(
      'div',
      { className: 'mnv-actions' },
      h('button', { className: 'mnv-btn', onClick: () => props.onOpen(c.cellId) }, '在检索里看'),
      h('button', { className: 'mnv-btn', 'data-tone': 'danger', onClick: () => props.onAct({ kind: 'forget', cellId: c.cellId, mode: 'soft' }) }, '归档'),
    ),
  )
}
