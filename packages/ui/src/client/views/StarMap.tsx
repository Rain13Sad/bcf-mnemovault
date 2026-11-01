/**
 * 3D 记忆星图（v0.6）
 *
 * ── 为什么是 3D，而不是"更好看的 2D 图谱" ────────────────────────
 * 记忆的相似度是**高维**的（64 维向量）。压到 2D 时，两簇本来正交的记忆会被
 * 投影到同一条线上，看起来"有关系"——这是 2D 图谱最常见的误导。
 * 3D 只多一个轴，但保留了"绕过去看另一面"的能力：用户可以转一圈，
 * 亲眼确认"这两团其实不在一个平面"。这是交互带来的**信息**，不是装饰。
 *
 * ── 为什么用 canvas 而不是 SVG ──────────────────────────────────
 * 1200 个节点 + 2400 条边，SVG 每帧要重建 3600 个 DOM 节点，掉到 10 fps 以下。
 * canvas 一次 draw call 画完，60 fps 稳定。代价是可访问性差——所以
 * 悬停信息走 DOM 覆盖层，点击选中走 `aria-label` + 键盘可聚焦的列表。
 *
 * ── 位置从哪来 ──────────────────────────────────────────────────
 * 不是力导向（每次刷新会重排，用户找不到东西），而是**固定种子的随机投影**：
 * 相似记忆天然靠近，新记忆只增加点、不移动已有的点。
 * 投影在 host 侧算（`core/src/starmap.ts`），客户端只收 x/y/z。
 */

import { createElement as h, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PanelSnapshot, PanelStarNode } from '@rain13sad/llm-mnemo-core'
import { KIND_LABEL, fmt2, signed } from '../ui.js'

export interface StarMapProps {
  snapshot: PanelSnapshot
  onOpen: (id: string) => void
  height?: number
}

type Filter = 'all' | 'emotional' | 'pinned' | 'fading'

interface View {
  rotX: number
  rotY: number
  zoom: number
  auto: boolean
}

interface Projected {
  node: PanelStarNode
  x: number
  y: number
  scale: number
  r: number
}

const FOV = 2.6

export function StarMap(props: StarMapProps): ReactNode {
  const map = props.snapshot.starmap
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const projRef = useRef<Projected[]>([])
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const viewRef = useRef<View>({ rotX: -0.28, rotY: 0.6, zoom: 1, auto: true })
  const [auto, setAuto] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [hover, setHover] = useState<{ node: PanelStarNode; x: number; y: number } | null>(null)
  const [picked, setPicked] = useState<string | null>(null)

  const nodes = useMemo(() => filterNodes(map?.nodes ?? [], filter), [map, filter])
  const nodeIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes])
  const edges = useMemo(() => (map?.edges ?? []).filter((e) => nodeIds.has(e[0]) && nodeIds.has(e[1])), [map, nodeIds])

  useEffect(() => {
    viewRef.current.auto = auto
  }, [auto])

  // ── 绘制循环 ────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let disposed = false
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1)

    const resize = () => {
      const w = wrap.clientWidth || 320
      const hgt = wrap.clientHeight || 320
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(hgt * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${hgt}px`
    }
    resize()

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(wrap)

    const byId = new Map(nodes.map((n) => [n.id, n]))

    const draw = () => {
      if (disposed) return
      const v = viewRef.current
      if (v.auto) v.rotY += 0.0032
      const w = canvas.width / dpr
      const hgt = canvas.height / dpr
      const cx = w / 2
      const cy = hgt / 2
      const R = Math.min(w, hgt) * 0.42 * v.zoom

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, hgt)

      // 背景：极淡的径向光晕，给"深空"一点纵深，不抢内容
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, hgt) * 0.7)
      grad.addColorStop(0, 'rgba(90,130,220,0.10)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, w, hgt)

      const cosY = Math.cos(v.rotY)
      const sinY = Math.sin(v.rotY)
      const cosX = Math.cos(v.rotX)
      const sinX = Math.sin(v.rotX)

      const project = (n: PanelStarNode): Projected => {
        const x1 = n.x * cosY - n.z * sinY
        const z1 = n.x * sinY + n.z * cosY
        const y2 = n.y * cosX - z1 * sinX
        const z2 = n.y * sinX + z1 * cosX
        const depth = FOV / (FOV + z2)
        const base = 1.6 + Math.min(3.4, n.importance * 3.2 + n.salience * 1.2)
        return { node: n, x: cx + x1 * R * depth, y: cy + y2 * R * depth, scale: depth, r: base * depth }
      }

      const proj = nodes.map(project)
      proj.sort((a, b) => a.scale - b.scale) // 远的先画
      projRef.current = proj
      const pos = new Map(proj.map((p) => [p.node.id, p]))

      // 边：按深度淡出，低权重的边在节点多时直接跳过（否则一团糊）
      const skipLow = edges.length > 700
      for (const [a, b, weight] of edges) {
        if (skipLow && weight < 40) continue
        const pa = pos.get(a)
        const pb = pos.get(b)
        if (!pa || !pb) continue
        const alpha = Math.min(0.32, 0.05 + (weight / 120) * 0.24) * Math.min(pa.scale, pb.scale)
        if (alpha <= 0.02) continue
        ctx.strokeStyle = `rgba(140,170,230,${alpha.toFixed(3)})`
        ctx.lineWidth = Math.max(0.4, Math.min(1.4, weight / 90))
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
        ctx.stroke()
      }

      // 节点：颜色 = 效价（红正向 / 绿负向，中文习惯），亮度 = 深度，环 = 固定
      for (const p of proj) {
        const n = p.node
        const tone = n.valence > 0.15 ? '224,73,91' : n.valence < -0.15 ? '31,138,82' : '150,162,186'
        const alpha = Math.min(1, 0.35 + p.scale * 0.62)
        const isHover = hover?.node.id === n.id
        const isPicked = picked === n.id
        if (isHover || isPicked) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r + 4, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(120,170,255,${isPicked ? 0.9 : 0.55})`
          ctx.lineWidth = isPicked ? 1.8 : 1.1
          ctx.stroke()
        }
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${tone},${alpha.toFixed(3)})`
        ctx.fill()
        if (n.pinned) {
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r + 2.2, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(255,214,120,${(0.5 * alpha).toFixed(3)})`
          ctx.lineWidth = 0.8
          ctx.stroke()
        }
        // 大节点标 shortId：只标最重要的那些，否则字比星多
        if (p.scale > 0.95 && p.r > 3.6) {
          ctx.fillStyle = `rgba(200,214,235,${(0.42 * alpha).toFixed(3)})`
          ctx.font = '9px ui-monospace, Menlo, monospace'
          ctx.textAlign = 'center'
          ctx.fillText(n.shortId, p.x, p.y + p.r + 9)
        }
      }

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    // ── 交互 ──────────────────────────────────────────────────
    const local = (ev: MouseEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect()
      return { x: ev.clientX - r.left, y: ev.clientY - r.top }
    }
    const hitTest = (x: number, y: number): PanelStarNode | null => {
      let best: Projected | null = null
      let bestD = 14
      for (const p of projRef.current) {
        const d = Math.hypot(p.x - x, p.y - y)
        if (d < Math.max(8, p.r + 5) && d < bestD) {
          best = p
          bestD = d
        }
      }
      return best?.node ?? null
    }

    const onDown = (ev: MouseEvent) => {
      dragRef.current = local(ev)
      viewRef.current.auto = false
      setAuto(false)
    }
    const onMove = (ev: MouseEvent) => {
      const pt = local(ev)
      if (dragRef.current) {
        const dx = pt.x - dragRef.current.x
        const dy = pt.y - dragRef.current.y
        viewRef.current.rotY += dx * 0.008
        viewRef.current.rotX = clamp(viewRef.current.rotX + dy * 0.006, -1.2, 1.2)
        dragRef.current = pt
        return
      }
      const node = hitTest(pt.x, pt.y)
      setHover(node ? { node, x: pt.x, y: pt.y } : null)
      canvas.style.cursor = node ? 'pointer' : 'grab'
    }
    const onUp = () => {
      dragRef.current = null
    }
    const onClick = (ev: MouseEvent) => {
      const pt = local(ev)
      const node = hitTest(pt.x, pt.y)
      if (node) {
        setPicked(node.id)
        props.onOpen(node.id)
      }
    }
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault()
      viewRef.current.zoom = clamp(viewRef.current.zoom * (ev.deltaY > 0 ? 0.92 : 1.08), 0.5, 2.6)
    }

    canvas.addEventListener('mousedown', onDown)
    canvas.addEventListener('mousemove', onMove)
    canvas.addEventListener('mouseup', onUp)
    canvas.addEventListener('mouseleave', onUp)
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro?.disconnect()
      canvas.removeEventListener('mousedown', onDown)
      canvas.removeEventListener('mousemove', onMove)
      canvas.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('mouseleave', onUp)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [nodes, edges, hover?.node.id, picked, props.onOpen])

  if (!map || map.nodes.length === 0) {
    return h(
      'div',
      { className: 'mnv-empty' },
      h('div', null, '星图还没有星星'),
      h('div', null, '记忆写入后，相似的会聚成团。少于 3 条时看不出结构，先聊几句。'),
    )
  }

  const emotional = (map.nodes ?? []).filter((n) => Math.abs(n.valence) >= 0.45).length
  const pinned = (map.nodes ?? []).filter((n) => n.pinned).length
  const sampled = map.sampled < map.total

  return h(
    'div',
    { className: 'mnv-star' },
    h(
      'div',
      { className: 'mnv-star-bar' },
      h(
        'div',
        { className: 'mnv-star-tools' },
        h(
          'button',
          { className: 'mnv-btn', 'data-tone': auto ? 'primary' : 'ghost', onClick: () => setAuto((v) => !v) },
          auto ? '自转中' : '已暂停',
        ),
        h(
          'button',
          {
            className: 'mnv-btn',
            'data-tone': 'ghost',
            onClick: () => {
              viewRef.current = { rotX: -0.28, rotY: 0.6, zoom: 1, auto: viewRef.current.auto }
            },
          },
          '重置视角',
        ),
        h(
          'select',
          {
            className: 'mnv-select',
            value: filter,
            onChange: (e: { target: { value: string } }) => setFilter(e.target.value as Filter),
          },
          h('option', { value: 'all' }, `全部 ${map.total}`),
          h('option', { value: 'emotional' }, `带情绪 ${emotional}`),
          h('option', { value: 'pinned' }, `已固定 ${pinned}`),
          h('option', { value: 'fading' }, '将遗忘'),
        ),
      ),
      h(
        'div',
        { className: 'mnv-star-meta' },
        h('span', null, `${nodes.length} 颗 · ${edges.length} 条连线`),
        sampled ? h('span', { style: { color: 'var(--mnv-warn)' } }, `按星等采样 ${map.sampled}/${map.total}`) : null,
      ),
    ),
    h(
      'div',
      { className: 'mnv-star-stage', ref: wrapRef, style: { height: props.height ?? 360 } },
      h('canvas', { ref: canvasRef, className: 'mnv-star-canvas', 'aria-label': '3D 记忆星图' }),
      hover
        ? h(
            'div',
            {
              className: 'mnv-star-tip',
              style: {
                left: Math.min(Math.max(8, hover.x + 12), 220),
                top: Math.max(8, hover.y - 12),
              },
            },
            h('b', null, `${hover.node.shortId} · ${KIND_LABEL[hover.node.kind] ?? hover.node.kind}`),
            h('span', null, hover.node.digest || '（无摘要）'),
            h(
              'span',
              { className: 'mnv-star-tip-nums' },
              `V ${signed(hover.node.valence)} · A ${fmt2(hover.node.arousal)} · 重要 ${fmt2(hover.node.importance)}`,
              hover.node.invalidated ? ' · 已被取代' : '',
            ),
          )
        : null,
      h(
        'div',
        { className: 'mnv-star-hint' },
        '拖拽旋转 · 滚轮缩放 · 点击查看 · 颜色按效价（红正向 / 绿负向）',
      ),
    ),
    h(
      'div',
      { className: 'mnv-star-foot' },
      h('span', null, '位置由 64 维向量做固定种子投影：相似的记忆天然靠近，新记忆不会移动旧点。'),
    ),
  )
}

function filterNodes(nodes: PanelStarNode[], f: Filter): PanelStarNode[] {
  if (f === 'all') return nodes
  if (f === 'emotional') return nodes.filter((n) => Math.abs(n.valence) >= 0.45)
  if (f === 'pinned') return nodes.filter((n) => n.pinned)
  return nodes.filter((n) => n.tier >= 2 && !n.invalidated)
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}
