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
import type { PanelAction, PanelCellView, PanelSnapshot, Preset, SurfaceMode } from '@rain13sad/llm-mnemo-core'
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
import { StarMap } from './views/StarMap.js'
import { Console } from './views/Console.js'
import { Timeline } from './views/Timeline.js'
import { Status } from './ui.js'
import { CommandPalette, type PaletteAction } from './CommandPalette.js'

export type TabKey = 'overview' | 'starmap' | 'search' | 'organize' | 'retention' | 'inbox' | 'affect' | 'console' | 'settings'

export interface PanelProps {
  source: MnemoDataSource
  pageSize?: number
  graphMaxNodes?: number
  affectEnabled?: boolean
  /** 初始选中（从对话流卡片跳进来时用） */
  initialCellId?: string
  /** 初始视图 */
  initialTab?: TabKey | 'timeline' | 'graph' | 'diagnostics'
  /** 初始展开命令面板（预览截图用，`#tab,palette`） */
  initialPaletteOpen?: boolean
  /** 阈值，用于解释器显示 */
  ignition?: number
  /** 命令桥：无 remote 时，面板上的按钮走这里（host 侧命令面） */
  runCommand?: (line: string) => Promise<string> | string
  onPresetChange?: (p: Preset) => void
  onSurfaceModeChange?: (m: SurfaceMode) => void
}

/**
 * 页签顺序即"使用动线"（v0.6 重排）：
 *   先看整体（总览 / 星图）→ 再找（检索）→ 再管（整理 / 保留度 / 收件箱）
 *   → 再看自己（情感）→ 最后调（调控台 / 设置）。
 * 星图与调控台放在两端，是因为它们一个是"读的入口"、一个是"写的入口"。
 */
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: '记忆总览' },
  { key: 'starmap', label: '记忆星图' },
  { key: 'search', label: '记忆检索' },
  { key: 'organize', label: '记忆整理' },
  { key: 'retention', label: '保留度' },
  { key: 'inbox', label: '收件箱' },
  { key: 'affect', label: '情感状态' },
  { key: 'console', label: '调控台' },
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
  const [paletteOpen, setPaletteOpen] = useState(props.initialPaletteOpen === true)
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

  /**
   * 全局快捷键（v0.7.1）。
   *
   * ⌘K 是命令面板的事实标准；⌘1–9 直接跳页签（VS Code / Linear 的同一套肌肉记忆）。
   * 两条都只在**输入框外**生效——否则在检索框里打字会触发导航。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      const n = Number(key)
      if (Number.isInteger(n) && n >= 1 && n <= TABS.length) {
        e.preventDefault()
        setTab(TABS[n - 1].key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  /**
   * 命令面板的条目集（v0.7.1）。
   *
   * 三组：导航（9 个页签）/ 操作（刷新、检索、待确认）/ 诊断（doctor、stats、why）。
   * 刻意**不放**破坏性命令（purge / forget）："打字即执行"的界面里
   * 不该出现需要二次确认的动作——那类操作留在页签与命令行里。
   */
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const nav: PaletteAction[] = TABS.map((t, i) => ({
      id: `tab:${t.key}`,
      label: `打开「${t.label}」`,
      group: '导航',
      keywords: `${t.key} tab 页签`,
      shortcut: `⌘${i + 1}`,
      run: () => setTab(t.key),
    }))
    const ops: PaletteAction[] = [
      { id: 'op:refresh', label: '刷新快照', group: '操作', keywords: 'reload load 重新读取', run: () => void load() },
      {
        id: 'op:search',
        label: '检索记忆',
        group: '操作',
        keywords: 'find query 搜索 查找',
        run: () => {
          setTab('search')
          setQuery('')
        },
      },
      { id: 'op:inbox', label: '处理待确认记忆', group: '操作', keywords: 'pending 收件箱 确认', run: () => setTab('inbox') },
      { id: 'op:retention', label: '看哪些记忆快被清掉', group: '操作', keywords: 'retention 保留度 遗忘', run: () => setTab('retention') },
    ]
    const diag: PaletteAction[] = props.runCommand
      ? [
          { id: 'cmd:doctor', label: '运行诊断 doctor', group: '诊断', keywords: 'doctor 自检 健康 检查', run: () => void command('/mnemo doctor') },
          { id: 'cmd:stats', label: '查看统计 stats', group: '诊断', keywords: 'stats 指标 统计', run: () => void command('/mnemo stats') },
          { id: 'cmd:why', label: '解释最近一次召回', group: '诊断', keywords: 'why explain 解释 分数', run: () => void command('/mnemo why') },
        ]
      : []
    return [...nav, ...ops, ...diag]
  }, [load, command, props.runCommand])

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
            h(
              'button',
              {
                className: 'mnv-btn',
                'data-tone': 'ghost',
                title: '命令面板（⌘K / Ctrl+K）',
                'aria-label': '打开命令面板',
                onClick: () => setPaletteOpen(true),
              },
              '⌘K',
            ),
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
          tab === 'starmap'
            ? h(StarMap, {
                snapshot,
                onOpen: (id) => openCell(id, 'search'),
                // v0.6.2：不再写死 380px——大屏上那是把星图压成一条缝。
                // 交给 StarMap 自己的 `clamp(360px, 62vh, 920px)` 随视口伸缩。
              })
            : null,
          tab === 'console'
            ? h(Console, {
                snapshot,
                onAct: (a) => void act(a),
                onCommand: (line) => void command(line),
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

    h(CommandPalette, { open: paletteOpen, onClose: () => setPaletteOpen(false), actions: paletteActions }),

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
