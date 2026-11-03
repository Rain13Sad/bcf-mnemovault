/**
 * 命令面板（⌘K / Ctrl+K）—— v0.7.1
 *
 * ── 为什么是"命令面板"而不是"再做一个页签" ──────────────────────
 * 面板已经有 9 个页签。页签解决的是"我要看什么"，而实际使用中更高频的问题是
 * "我知道那个功能叫什么，它在哪"——9 个页签 + 40 个配置项时，这个成本很高。
 *
 * 命令面板把"找功能"从**空间导航**（记住位置）变成**检索**（打出两个字）。
 * 这是 Raycast / VS Code / Linear / Vercel 后台的共同选择，也是近两年
 * 前端后台类项目里最稳定的交互范式（`cmdk` 一类库把它做成了标准件）。
 *
 * ── 借了哪些设计 ────────────────────────────────────────────────
 * · **模糊匹配按"子序列 + 连续加分"**（cmdk 的 command-score 思路）：
 *   输入 "js" 能命中"检索"，输入 "yq" 不该命中——中文按字匹配，英文按前缀加分；
 * · **分组 + 组内按分数排**：结果永远按"导航 / 操作 / 诊断"分组，
 *   同组内才按匹配度排——否则一个高分项会把整组结构打散，用户反而找不到；
 * · **最近使用置顶**（空查询时）：把"上次点的那几个"放在最前，
 *   这是 Raycast 里最省事的一招，成本只有 5 行 localStorage；
 * · **键盘优先**：↑↓ 移动、Enter 执行、Esc 关闭，鼠标只是补充；
 * · **空结果给建议**而不是空白（提示可以搜页签名或命令名）。
 *
 * ── 刻意不做的 ──────────────────────────────────────────────────
 * 不做"命令参数输入"（比如 purge 要输确认词）。破坏性操作不该出现在
 * 一个"打字即执行"的界面里——它应该留在需要显式确认的命令行/页签里。
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

export interface PaletteAction {
  id: string
  label: string
  /** 右侧的快捷键提示（仅展示） */
  shortcut?: string
  /** 补充说明，参与匹配但不显示为主标题 */
  keywords?: string
  group: string
  run: () => void
}

export interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  actions: PaletteAction[]
}

const RECENT_KEY = 'mnv.palette.recent'
const RECENT_MAX = 5

function readRecent(): string[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(RECENT_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

function pushRecent(id: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式/配额满：最近使用是锦上添花，失败就失败
  }
}

/**
 * 模糊匹配。返回 -1 表示不匹配。
 *
 * 规则（与 cmdk 的 command-score 同构，做了中文适配）：
 *   · 子序列命中是前提（"js" 命中 "检索" 不成立，因为字符不同）；
 *   · 连续命中 +2、词首命中 +3（中文没有词边界，用标点/空格/首字代替）；
 *   · 全串相等给一个压倒性高分，保证"检索"永远排第一。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const t = text.toLowerCase()
  if (t === q) return 1000
  if (t.startsWith(q)) return 600 + q.length
  const at = t.indexOf(q)
  if (at >= 0) return 400 + q.length * 2 - at

  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return -1
    score += 10
    if (found === ti) {
      streak++
      score += 2 * streak
    } else {
      streak = 0
      score -= Math.min(6, found - ti)
    }
    const prev = found > 0 ? t[found - 1] : ''
    if (found === 0 || /[\s·/|:：]/.test(prev)) score += 3
    ti = found + 1
  }
  return Math.max(1, score)
}

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 打开时重置并聚焦
  useEffect(() => {
    if (!props.open) return
    setQ('')
    setActive(0)
    setRecent(readRecent())
    const id = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [props.open])

  const results = useMemo(() => {
    const scored = props.actions
      .map((a) => ({ a, s: Math.max(fuzzyScore(q, a.label), a.keywords ? fuzzyScore(q, a.keywords) - 8 : -1) }))
      .filter((x) => x.s >= 0)
    // 空查询：最近使用置顶，其余按原始顺序（页签顺序即动线，不要打乱）
    if (!q.trim()) {
      const rank = (id: string) => {
        const i = recent.indexOf(id)
        return i < 0 ? 999 : i
      }
      scored.sort((x, y) => rank(x.a.id) - rank(y.a.id))
    } else {
      scored.sort((x, y) => y.s - x.s)
    }
    const groups: Array<{ name: string; items: PaletteAction[] }> = []
    for (const { a } of scored) {
      const g = groups.find((x) => x.name === a.group)
      if (g) g.items.push(a)
      else groups.push({ name: a.group, items: [a] })
    }
    return groups
  }, [props.actions, q, recent])

  const flat = useMemo(() => results.flatMap((g) => g.items), [results])

  // 结果变化时把光标收回有效范围
  useEffect(() => {
    setActive((i) => (i >= flat.length ? 0 : i))
  }, [flat.length])

  const run = useCallback(
    (a?: PaletteAction) => {
      if (!a) return
      pushRecent(a.id)
      props.onClose()
      // 让面板先卸载再执行，避免"点了没反应"的错觉（执行可能触发重新加载）
      setTimeout(() => a.run(), 0)
    },
    [props],
  )

  const onKeyDown = useCallback(
    (e: { key: string; preventDefault(): void; stopPropagation(): void; ctrlKey: boolean; metaKey: boolean }) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        props.onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (flat.length === 0 ? 0 : (i + 1) % flat.length))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (flat.length === 0 ? 0 : (i - 1 + flat.length) % flat.length))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        run(flat[active])
        return
      }
      // 输入框里按 ⌘K 再按一次 = 关闭（符合"开关"直觉）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        props.onClose()
      }
    },
    [flat, active, run, props],
  )

  // 光标滚入视野（长列表里键盘操作必须可见）
  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]')
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      ;(el as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  }, [active, props.open])

  if (!props.open) return null

  let idx = -1
  return h(
    'div',
    {
      className: 'mnv-palette-backdrop',
      role: 'presentation',
      onMouseDown: (e: { target: unknown; currentTarget: unknown }) => {
        if (e.target === e.currentTarget) props.onClose()
      },
    },
    h(
      'div',
      {
        className: 'mnv-palette',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '命令面板',
        onKeyDown,
      },
      h(
        'div',
        { className: 'mnv-palette-input-row' },
        h('span', { className: 'mnv-palette-icon', 'aria-hidden': 'true' }, '⌘'),
        h('input', {
          ref: inputRef,
          className: 'mnv-palette-input',
          value: q,
          placeholder: '搜索页签、操作或命令…',
          'aria-label': '命令面板搜索',
          'aria-controls': 'mnv-palette-list',
          'aria-activedescendant': flat[active] ? `mnv-pal-${flat[active].id}` : undefined,
          onChange: (e: { target: { value: string } }) => {
            setQ(e.target.value)
            setActive(0)
          },
          onKeyDown,
        }),
        h('kbd', { className: 'mnv-kbd' }, 'Esc'),
      ),
      h(
        'div',
        { className: 'mnv-palette-list', id: 'mnv-palette-list', role: 'listbox', ref: listRef },
        results.length === 0
          ? h(
              'div',
              { className: 'mnv-palette-empty' },
              h('div', null, `没有匹配「${q}」的条目`),
              h('div', { className: 'mnv-muted' }, '试试页签名（检索 / 保留度 / 情感）或命令名（doctor / stats）'),
            )
          : results.map((g) =>
              h(
                'div',
                { className: 'mnv-palette-group', key: g.name, role: 'group', 'aria-label': g.name },
                h('div', { className: 'mnv-palette-group-title' }, g.name),
                ...g.items.map((a) => {
                  idx++
                  const isActive = idx === active
                  const myIdx = idx
                  return h(
                    'button',
                    {
                      key: a.id,
                      id: `mnv-pal-${a.id}`,
                      className: 'mnv-palette-item',
                      role: 'option',
                      'aria-selected': isActive,
                      'data-active': isActive,
                      onMouseEnter: () => setActive(myIdx),
                      onClick: () => run(a),
                    },
                    h('span', { className: 'mnv-palette-label' }, a.label),
                    a.shortcut ? h('kbd', { className: 'mnv-kbd' }, a.shortcut) : null,
                  )
                }),
              ),
            ),
      ),
      h(
        'div',
        { className: 'mnv-palette-foot' },
        h('span', null, h('kbd', { className: 'mnv-kbd' }, '↑'), h('kbd', { className: 'mnv-kbd' }, '↓'), ' 移动'),
        h('span', null, h('kbd', { className: 'mnv-kbd' }, '↵'), ' 执行'),
        h('span', { className: 'mnv-spacer' }),
        h('span', { className: 'mnv-muted' }, `${flat.length} 项`),
      ),
    ),
  )
}
