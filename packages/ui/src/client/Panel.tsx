/**
 * 记忆面板外壳（§12.1 / §12.4）
 *
 * 六页共用一条数据流：一次 load() → 一份 PanelSnapshot → 各页纯渲染。
 * 这样"收件箱里确认一条"与"总览页的待确认计数"永远同时更新，不会出现两个真相。
 *
 * 版式对齐 DSH 记忆插件的惯例：顶部一行是"库在哪 + 三个计数 + 刷新"，
 * 下面是分页签，内容区按页签各自组织。计数放在最外层，是因为它们是**决策依据**
 * （有几条在等我处理），不该埋在某一页里。
 *
 * 生命周期（§12.10 最后一条）：关闭即释放所有订阅——这是热重载与卸载的前提。
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PanelAction, PanelCellView, PanelSnapshot, Preset, SurfaceMode } from '@rain13sad/dsh-mnemo-core'
import type { MnemoDataSource } from './data.js'
import { formatBreakdownClient } from './explain.js'
import { CSS, STYLE_ID } from './style.js'
import { Overview } from './views/Overview.js'
import { Search } from './views/Search.js'
import { Organize } from './views/Organize.js'
import { Inbox } from './views/Inbox.js'
import { Retention } from './views/Retention.js'
import { Affect } from './views/Affect.js'
import { Settings } from './views/Settings.js'
import { Timeline } from './views/Timeline.js'
import { Status } from './ui.js'

export type TabKey = 'overview' | 'search' | 'organize' | 'retention' | 'inbox' | 'affect' | 'settings'

export interface PanelProps {
  source: MnemoDataSource
  pageSize?: number
  graphMaxNodes?: number
  affectEnabled?: boolean
  /** 初始选中（从对话流卡片跳进来时用） */
  initialCellId?: string
  /** 初始视图 */
  initialTab?: TabKey | 'timeline' | 'graph' | 'diagnostics'
  /** 阈值，用于解释器显示 */
  ignition?: number
  /** 命令桥：无 remote 时，面板上的按钮走这里（host 侧命令面） */
  runCommand?: (line: string) => Promise<string> | string
  onPresetChange?: (p: Preset) => void
  onSurfaceModeChange?: (m: SurfaceMode) => void
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '记忆总览' },
  { key: 'search', label: '记忆检索' },
  { key: 'organize', label: '记忆整理' },
  { key: 'retention', label: '保留度' },
  { key: 'inbox', label: '收件箱' },
  { key: 'affect', label: '情感状态' },
  { key: 'settings', label: '设置' },
]

/** 旧版页签名 → 新版（避免宿主里存的偏好直接失效） */
function normalizeTab(t?: PanelProps['initialTab']): TabKey {
  if (!t) return 'overview'
  if (t === 'timeline' || t === 'graph') return 'organize'
  if (t === 'diagnostics') return 'settings'
  return t as TabKey
}

export function MnemoPanel(props: PanelProps): ReactNode {
  const [snapshot, setSnapshot] = useState<PanelSnapshot | null>(null)
  const [tab, setTab] = useState<TabKey>(normalizeTab(props.initialTab))
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
        setTimeout(() => setToast(null), 2800)
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
        setToast(String(out).split('\n')[0] || '完成')
        await load()
      } catch (err) {
        setToast(String((err as Error)?.message ?? err))
      } finally {
        setBusy(false)
        setTimeout(() => setToast(null), 2800)
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
        text: `cell ${cellId.slice(-4)} 不在最近一次召回的候选池里。\n可能原因：本轮未触发注入、低于 ignition 阈值、或被 provenance 隔离。\n在总览页看「注入量」与「召回 p95」可以判断是哪一种。`,
      })
    },
    [explain, snapshot, props.ignition],
  )

  const openCell = useCallback((cellId: string, target: TabKey) => {
    setSelected(cellId)
    setTab(target)
    if (target === 'search') setQuery('')
  }, [])

  if (error) {
    return h(
      'div',
      { className: 'mnv-root' },
      h('div', { className: 'mnv-header' }, h('span', { className: 'mnv-title' }, '长期记忆')),
      h('div', { className: 'mnv-error' }, '加载失败：' + error),
      h('div', { className: 'mnv-actions' }, h('button', { className: 'mnv-btn', onClick: () => void load() }, '重试')),
    )
  }

  if (!snapshot) {
    return h(
      'div',
      { className: 'mnv-root' },
      h('div', { className: 'mnv-header' }, h('span', { className: 'mnv-title' }, '长期记忆')),
      h(
        'div',
        { className: 'mnv-body' },
        h('div', { className: 'mnv-loading' }, '正在读取记忆库…'),
        h('div', { className: 'mnv-skeleton', style: { width: '70%' } }),
        h('div', { className: 'mnv-skeleton', style: { width: '88%' } }),
        h('div', { className: 'mnv-skeleton', style: { width: '54%' } }),
      ),
    )
  }

  const s = snapshot.stats
  const rt = snapshot.runtime
  const pendingN = (snapshot.pending ?? []).length
  const conflicts = s.contradictions + s.disputed
  const lowRetention = snapshot.retention
    ? (snapshot.retention.byDisposition.P1 ?? 0) + (snapshot.retention.byDisposition.P2 ?? 0)
    : 0

  // 页签/导航的角标：只标"需要人处理"的计数，不给每个页签都挂数字
  const badgeOf = (key: TabKey): number | null => {
    if (key === 'inbox' && pendingN > 0) return pendingN
    if (key === 'retention' && lowRetention > 0) return lowRetention
    return null
  }

  return h(
    'div',
    { className: 'mnv-root' },
    h(
      'div',
      { className: 'mnv-shell' },

      // ── 左侧导航（≥760px 显示；窄宽度由 .mnv-tabs 接管） ──────────
      h(
        'aside',
        { className: 'mnv-rail', 'aria-label': '记忆面板导航' },
        h(
          'div',
          { className: 'mnv-brand' },
          h('b', null, '长期记忆'),
          h('span', { className: 'mnv-badge' }, sourceLabel(props.source.kind)),
        ),
        h(
          'nav',
          { className: 'mnv-nav', role: 'navigation' },
          ...TABS.map((t) => {
            const n = badgeOf(t.key)
            return h(
              'button',
              {
                key: t.key,
                className: 'mnv-nav-btn',
                'data-active': tab === t.key,
                'aria-current': tab === t.key ? 'page' : undefined,
                onClick: () => setTab(t.key),
              },
              t.label,
              n !== null
                ? h('span', { className: 'mnv-nav-count', style: t.key === 'inbox' ? { color: 'var(--mnv-warn)' } : undefined }, String(n))
                : null,
            )
          }),
        ),
        h(
          'div',
          { className: 'mnv-rail-foot' },
          h(Status, { ok: conflicts === 0, text: conflicts === 0 ? '运行正常' : `${conflicts} 处需处理` }),
          h('span', null, `${s.cells} 条记忆 · ${s.edges} 条边`),
          h('span', { title: rt?.dbPath }, rt?.storeKind === 'sqlite' ? 'SQLite 晶格' : '内存晶格'),
          h('span', null, `布局 v${rt?.layoutVersion ?? 3} · ${rt?.preset ?? 'balanced'}`),
        ),
      ),

      // ── 主内容区 ────────────────────────────────────────────────
      h(
        'div',
        { className: 'mnv-main' },

        // 顶栏：宽屏是一行（标题→路径→计数→刷新），窄屏仍是三行
        h(
          'div',
          { className: 'mnv-header' },
          h(
            'div',
            { className: 'mnv-header-row mnv-h-row1' },
            h('span', { className: 'mnv-title mnv-h-title' }, '长期记忆'),
            h('span', { className: 'mnv-badge', title: '当前数据源' }, sourceLabel(props.source.kind)),
            h('span', { className: 'mnv-spacer' }),
            h('button', { className: 'mnv-btn', 'data-tone': 'ghost', disabled: busy, onClick: () => void load() }, '刷新'),
          ),
          h(
            'div',
            { className: 'mnv-header-row mnv-h-row2' },
            h(
              'span',
              { className: 'mnv-muted', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: rt?.dbPath },
              rt?.storeKind === 'sqlite' ? 'SQLite 晶格 · ' : '内存晶格 · ',
              rt?.dbPath ?? '（未配置）',
            ),
          ),
          h(
            'div',
            { className: 'mnv-header-row mnv-h-row3', style: { flexWrap: 'wrap' } },
            h('span', { className: 'mnv-badge', title: '全部 cell' }, `记忆总数 ${s.cells}`),
            h(
              'span',
              { className: 'mnv-badge', title: 'support=1 且重要性不低，或存在争议', style: pendingN ? { color: 'var(--mnv-warn)' } : undefined },
              `待确认 ${pendingN}`,
            ),
            h(
              'span',
              { className: 'mnv-badge', title: '矛盾边 + 争议 cell', style: conflicts ? { color: 'var(--mnv-danger)' } : undefined },
              `冲突/异常 ${conflicts}`,
            ),
            h(Status, { ok: conflicts === 0, text: conflicts === 0 ? '正常' : '需处理' }),
          ),
        ),

        // 页签：只在窄容器里出现（宽屏由左侧栏承担导航）
        h(
          'div',
          { className: 'mnv-tabs', role: 'tablist', 'aria-label': '记忆面板页签' },
          ...TABS.map((t) => {
            const n = badgeOf(t.key)
            return h(
              'button',
              {
                key: t.key,
                className: 'mnv-tab',
                role: 'tab',
                'data-active': tab === t.key,
                'aria-selected': tab === t.key,
                onClick: () => setTab(t.key),
              },
              t.label,
              n !== null ? h('span', { className: 'mnv-flag' }, ` ${n}`) : null,
            )
          }),
        ),

        // 内容
        h(
          'div',
          { className: 'mnv-body' },
          tab === 'overview'
            ? h(Overview, {
                snapshot,
                onAct: (a) => void act(a),
                onCommand: (line) => void command(line),
                onOpen: (id, target) => openCell(id, target === 'inbox' ? 'inbox' : 'search'),
                busy,
              })
            : null,
          tab === 'search'
            ? h(
                'div',
                null,
                h(Search, {
                  snapshot,
                  cells,
                  query,
                  onQuery: setQuery,
                  kind,
                  onKind: setKind,
                  lens,
                  onLens: setLens,
                  selectedId: selected,
                  onSelect: setSelected,
                  onExplain,
                  onAct: (a) => void act(a),
                  onCommand: (line) => void command(line),
                  explain,
                  busy,
                }),
                // 无查询词时把时间线接在下面：检索页同时承担"翻一翻"的用途
                query.trim()
                  ? null
                  : h(
                      'div',
                      { style: { marginTop: 12 } },
                      h('div', { className: 'mnv-subhead' }, h('b', null, '全部记忆（时间线）')),
                      h(Timeline, {
                        cells,
                        pageSize: props.pageSize ?? 50,
                        selectedId: selected,
                        onSelect: setSelected,
                        onAct: (a) => void act(a),
                        onExplain,
                        explain,
                        busy,
                      }),
                    ),
              )
            : null,
          tab === 'organize'
            ? h(Organize, {
                snapshot,
                onAct: (a) => void act(a),
                onCommand: (line) => void command(line),
                onOpen: (id) => openCell(id, 'search'),
                busy,
                graphMaxNodes: props.graphMaxNodes ?? 200,
              })
            : null,
          tab === 'retention'
            ? h(Retention, { snapshot, onOpen: (id) => openCell(id, 'search'), onAct: (a) => void act(a) })
            : null,
          tab === 'inbox'
            ? h(Inbox, {
                snapshot,
                onAct: (a) => void act(a),
                onCommand: (line) => void command(line),
                onOpen: (id) => openCell(id, 'search'),
                busy,
              })
            : null,
          tab === 'affect'
            ? h(Affect, {
                snapshot,
                cells: snapshot.cells,
                onSelect: (id) => openCell(id, 'search'),
                enabled: props.affectEnabled ?? snapshot.affect?.enabled ?? false,
              })
            : null,
          tab === 'settings'
            ? h(Settings, {
                snapshot,
                onAct: (a) => void act(a),
                onCommand: (line) => void command(line),
                onPresetChange: props.onPresetChange,
                onSurfaceModeChange: props.onSurfaceModeChange,
                busy,
              })
            : null,
        ),
      ),
    ),

    // role=status + aria-live：屏幕阅读器会念出"已固定 / 已恢复"这类操作结果
    toast ? h('div', { className: 'mnv-toast', style: toastStyle, role: 'status', 'aria-live': 'polite' }, toast) : null,
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
