/** 面板用的小组件与格式化。刻意不引第三方 UI 库：面板要能在任意宿主里跑。 */
import { createElement as h, type ReactNode } from 'react'

export const KIND_LABEL: Record<number, string> = {
  0: '情景',
  1: '语义',
  2: '程序',
  3: '图式',
  4: '人格锚',
  5: '关系',
  6: '叙事',
}

export const TIER_LABEL: Record<number, string> = { 0: '热', 1: '温', 2: '冷', 3: '归档' }

export const PROV_LABEL: Record<number, string> = { 0: '用户', 1: '助手', 2: '工具', 3: '网络', 4: '推断' }

export const CHANNEL_LABEL: Record<string, string> = {
  semantic: '语义',
  symbolic: '符号',
  graph: '图',
  temporal: '时间',
  mixed: '混合',
}

export function fmt2(x: number): string {
  const v = Math.round((x || 0) * 100) / 100
  return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

export function signed(x: number): string {
  const s = fmt2(x)
  return s.startsWith('-') || s === '0' ? s : '+' + s
}

export function mmdd(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function relTime(ms: number): string {
  const diff = Date.now() - ms
  const d = Math.floor(diff / 86_400_000)
  if (d <= 0) return '今天'
  if (d === 1) return '昨天'
  if (d < 30) return `${d} 天前`
  if (d < 365) return `${Math.floor(d / 30)} 个月前`
  return `${Math.floor(d / 365)} 年前`
}

export function valenceColor(v: number): string {
  if (v > 0.15) return 'var(--mnv-pos)'
  if (v < -0.15) return 'var(--mnv-neg)'
  return 'var(--mnv-fg-faint)'
}

export function Bar(props: { value: number; tone?: string; max?: number }): ReactNode {
  const pct = Math.max(0, Math.min(100, (props.value / (props.max ?? 1)) * 100))
  return h('div', { className: 'mnv-bar' }, h('i', { style: { width: `${pct}%`, background: props.tone } }))
}

export function Metric(props: { label: string; value: ReactNode; unit?: string; hint?: string }): ReactNode {
  return h(
    'div',
    { className: 'mnv-card', title: props.hint },
    h('h4', null, props.label),
    h('div', { className: 'mnv-metric' }, props.value, props.unit ? h('small', null, props.unit) : null),
  )
}

export function Chip(props: { children: ReactNode; tone?: string; title?: string }): ReactNode {
  return h('span', { className: 'mnv-chip', title: props.title, style: props.tone ? { color: props.tone } : undefined }, props.children)
}

/** 极简 sparkline：不依赖图表库，单条 polyline 足够表达趋势。 */
export function Sparkline(props: { data: number[]; width?: number; height?: number; tone?: string }): ReactNode {
  const w = props.width ?? 220
  const hgt = props.height ?? 34
  const data = props.data.length > 1 ? props.data : [0, 0]
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const span = Math.max(1, max - min)
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${hgt - ((v - min) / span) * (hgt - 4) - 2}`)
    .join(' ')
  return h(
    'svg',
    { width: w, height: hgt, viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'none' },
    h('polyline', { points: pts, fill: 'none', stroke: props.tone ?? 'var(--mnv-accent)', strokeWidth: 1.5 }),
  )
}

export function Empty(props: { title: string; hint?: string }): ReactNode {
  return h('div', { className: 'mnv-empty' }, h('div', null, props.title), props.hint ? h('div', null, props.hint) : null)
}

/** 绝对时间（面板"索引构建时间"这类字段要的是可核对的时间点，不是"3 天前"）。 */
export function fmtTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function pct(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`
}

/** 小标题：`标题 ────────── 右侧说明` */
export function SubHead(props: { title: string; hint?: string; right?: ReactNode }): ReactNode {
  return h(
    'div',
    { className: 'mnv-subhead' },
    h('b', null, props.title),
    props.hint ? h('span', null, props.hint) : null,
    props.right ? h('span', { style: { marginLeft: 'auto' } }, props.right) : null,
  )
}

export function Status(props: { ok: boolean; text: string }): ReactNode {
  return h('span', { className: 'mnv-status', 'data-ok': props.ok }, props.text)
}

export function Stat(props: { label: string; value: ReactNode; tone?: 'warn' | 'danger' | 'accent'; title?: string }): ReactNode {
  return h(
    'div',
    { className: 'mnv-stat', 'data-tone': props.tone, title: props.title },
    h('b', null, props.value),
    h('span', null, props.label),
  )
}
