/**
 * 记忆面板外壳（§12.1 / §12.4）
 *
 * 四个视图共用一条数据流：一次 load() → 一份 PanelSnapshot → 各视图纯渲染。
 * 这样"时间线里删掉一条"与"诊断页的数字"永远同时更新，不会出现两个真相。
 *
 * 生命周期（§12.10 最后一条）：关闭即释放所有订阅——这是热重载与卸载的前提。
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PanelAction, PanelCellView, PanelSnapshot, Preset, SurfaceMode } from '@bcf/dsh-mnemo-core'
import type { MnemoDataSource } from './data.js'
import { formatBreakdownClient } from './explain.js'
import { CSS, STYLE_ID } from './style.js'
import { Timeline } from './views/Timeline.js'
import { Graph } from './views/Graph.js'
import { Affect } from './views/Affect.js'
import { Diagnostics } from './views/Diagnostics.js'
import { Proactive } from './views/Proactive.js'
import { Empty } from './ui.js'

export type TabKey = 'timeline' | 'graph' | 'affect' | 'proactive' | 'diagnostics'

export interface PanelProps {
  source: MnemoDataSource
  pageSize?: number
  graphMaxNodes?: number
  affectEnabled?: boolean
  /** 初始选中（从对话流卡片跳进来时用） */
  initialCellId?: string
  /** 初始视图 */
  initialTab?: TabKey
  /** 阈值，用于解释器显示 */
  ignition?: number
  /** 命令桥：无 remote 时，面板上的按钮走这里（host 侧命令面） */
  runCommand?: (line: string) => Promise<string> | string
  onPresetChange?: (p: Preset) => void
  onSurfaceModeChange?: (m: SurfaceMode) => void
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'timeline', label: '时间线' },
  { key: 'graph', label: '图谱' },
  { key: 'affect', label: '情感' },
  { key: 'proactive', label: '主动' },
  { key: 'diagnostics', label: '诊断' },
]

export function MnemoPanel(props: PanelProps): ReactNode {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null)
  const [tab, setTab] = useState<TabKey>(props.initialTab ?? 'timeline')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<string>('all')
  const [lens, setLens] = useState<string>('all')
  const [selected, setSelected] = useState<string | undefined>(props.initialCellId)
  const [explain, setExplain] = useState<{ cellId: string; text: string } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  // 样式注入一次（幂等）
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = CSS
    document.head.appendChild(el)
  }, [])

  const load = useCallback(async () => {
    try {
      const s = await props.source.load()
      if (!alive.current) return
      setSnapshot(s)
      setError(null)
    } catch (err) {
      if (alive.current) setError(String((err as Error)?.message ?? err))
    }
  }, [props.source])

  useEffect(() => {
    alive.current = true
    void load()
    const off = props.source.subscribe(() => void load())
    // 兜底轮询：事件源可能漏事件，3s 一次足够便宜
    const timer = setInterval(() => void load(), 3000)
    return () => {
      alive.current = false
      clearInterval(timer)
      off()
      props.source.dispose()
    }
  }, [props.source, load])

  const act = useCallback(
    async (a: PanelAction) => {
      setBusy(true)
      try {
        const r = await props.source.act(a)
        setToast(r.message)
        if (r.ok) await load()
      } catch (err) {
        setToast(String((err as Error)?.message ?? err))
      } finally {
        setBusy(false)
        setTimeout(() => setToast(null), 2600)
      }
    },
    [props.source, load],
  )

  const command = useCallback(
    async (line: string) => {
      if (!props.runCommand) {
        setToast('当前部署未提供命令桥（见 docs/API-CONTRACT.md）')
        return
      }
      setBusy(true)
      try {
        const out = await props.runCommand(line)
        setToast(out.split('\n')[0] || '完成')
        await load()
      } catch (err) {
        setToast(String((err as Error)?.message ?? err))
      } finally {
        setBusy(false)
      }
    },
    [props.runCommand, load],
  )

  const cells = useMemo(() => filterCells(snapshot?.cells ?? [], query, kind, lens), [snapshot, query, kind, lens])

  const onExplain = useCallback(
    (cellId: string) => {
      if (explain?.cellId === cellId) {
        setExplain(null)
        return
      }
      const b = snapshot?.lastRecall?.breakdowns.find((x) => x.cellId === cellId || x.cellId.endsWith(cellId.slice(-4)))
      if (b) {
        setExplain({ cellId, text: formatBreakdownClient(b, props.ignition ?? 0.42) })
        return
      }
      setExplain({
        cellId,
        text: `cell ${cellId.slice(-4)} 不在最近一次召回的候选池里。\n可能原因：本轮未触发注入、低于 ignition 阈值、或被 provenance 隔离。\n在诊断页看「命中率」与「tokens/轮」可以判断是哪一种。`,
      })
    },
    [explain, snapshot, props.ignition],
  )

  if (error) {
    return h('div', { className: 'mnv-root' }, h('div', { className: 'mnv-header' }, h('span', { className: 'mnv-title' }, '记忆')), h('div', { className: 'mnv-error' }, '加载失败：' + error))
  }

  if (!snapshot) {
    return h('div', { className: 'mnv-root' }, h('div', { className: 'mnv-header' }, h('span', { className: 'mnv-title' }, '记忆')), h(Empty, { title: '正在读取记忆库…' }))
  }

  const total = snapshot.stats.cells
  const tokens = Math.round(snapshot.stats.tokensPerTurn)

  return h(
    'div',
    { className: 'mnv-root' },
    h(
      'div',
      { className: 'mnv-header' },
      h('span', { className: 'mnv-title' }, '记忆'),
      h('span', { className: 'mnv-badge' }, `${total} 条`),
      h('span', { className: 'mnv-badge', title: '最近一轮 surface 注入量' }, `${tokens} tok/轮`),
      h('span', { className: 'mnv-spacer' }),
      h('span', { className: 'mnv-badge', title: props.source.kind }, sourceLabel(props.source.kind)),
      h('button', { className: 'mnv-btn', 'data-tone': 'ghost', disabled: busy, onClick: () => void load() }, '刷新'),
    ),
    h(
      'div',
      { className: 'mnv-tabs' },
      ...TABS.map((t) =>
        h(
          'button',
          { key: t.key, className: 'mnv-tab', 'data-active': tab === t.key, onClick: () => setTab(t.key) },
          t.label,
          t.key === 'diagnostics' && snapshot.stats.disputed > 0 ? h('span', { className: 'mnv-flag' }, ` ${snapshot.stats.disputed}`) : null,
        ),
      ),
    ),
    tab === 'timeline' || tab === 'graph'
      ? h(
          'div',
          { className: 'mnv-toolbar' },
          h('input', {
            className: 'mnv-input',
            placeholder: '搜索记忆（实体、键值、原文片段）',
            value: query,
            onInput: (e: { currentTarget: HTMLInputElement }) => setQuery(e.currentTarget.value),
          }),
          h(
            'select',
            { className: 'mnv-select', value: kind, onChange: (e: { currentTarget: HTMLSelectElement }) => setKind(e.currentTarget.value) },
            h('option', { value: 'all' }, '全部类型'),
            h('option', { value: '1' }, '语义'),
            h('option', { value: '0' }, '情景'),
            h('option', { value: '2' }, '程序'),
            h('option', { value: '3' }, '图式'),
            h('option', { value: '5' }, '关系'),
            h('option', { value: '6' }, '叙事'),
          ),
          h(
            'select',
            { className: 'mnv-select', value: lens, onChange: (e: { currentTarget: HTMLSelectElement }) => setLens(e.currentTarget.value) },
            h('option', { value: 'all' }, '全部视角'),
            h('option', { value: 'fact' }, '事实'),
            h('option', { value: 'feeling' }, '感受'),
            h('option', { value: 'bond' }, '关系'),
            h('option', { value: 'story' }, '故事'),
          ),
        )
      : null,
    h(
      'div',
      { className: 'mnv-body' },
      tab === 'timeline'
        ? h(Timeline, {
            cells,
            pageSize: props.pageSize ?? 50,
            selectedId: selected,
            onSelect: (id) => setSelected(id),
            onAct: (a) => void act(a),
            onExplain,
            explain,
            busy,
          })
        : null,
      tab === 'graph'
        ? h(Graph, {
            cells: snapshot.cells,
            edges: snapshot.edges,
            selectedId: selected,
            maxNodes: props.graphMaxNodes ?? 200,
            onSelect: (id) => {
              setSelected(id)
              setExplain(null)
            },
          })
        : null,
      tab === 'affect'
        ? h(Affect, {
            snapshot,
            cells: snapshot.cells,
            onSelect: (id) => {
              setSelected(id)
              setTab('timeline')
            },
            enabled: props.affectEnabled ?? snapshot.affect?.enabled ?? false,
          })
        : null,
      tab === 'proactive'
        ? h(Proactive, { snapshot, onAct: (a) => void act(a), busy })
        : null,
      tab === 'diagnostics'
        ? h(Diagnostics, { snapshot, onAct: (a) => void act(a), onCommand: (line) => void command(line), busy })
        : null,
    ),
    toast ? h('div', { className: 'mnv-toast', style: toastStyle }, toast) : null,
  )
}

function sourceLabel(kind: MnemoDataSource['kind']): string {
  if (kind === 'remote') return '已连接宿主'
  if (kind === 'event') return '只读（事件流）'
  return '演示数据'
}

const toastStyle = {
  position: 'absolute' as const,
  left: 12,
  right: 12,
  bottom: 12,
  background: 'var(--mnv-bg-sunken)',
  border: '1px solid var(--mnv-border)',
  borderRadius: 8,
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--mnv-fg)',
}

export function filterCells(cells: PanelCellView[], query: string, kind: string, lens = 'all'): PanelCellView[] {
  const q = query.trim().toLowerCase()
  return cells.filter((c) => {
    if (kind !== 'all' && String(c.kind) !== kind) return false
    if (lens !== 'all' && (c.lens ?? 'fact') !== lens) return false
    if (!q) return true
    const hay = [c.digest, c.shortId, c.kindName, ...c.kv.map(([k, v]) => `${k}=${v}`), ...c.slots.map((s) => s.value)].join(' ').toLowerCase()
    return hay.includes(q)
  })
}
