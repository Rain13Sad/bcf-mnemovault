/**
 * 面板数据源（client 侧）
 *
 * 一条架构决策（对应文档 §20.2 的开放问题 7）：
 *   「把所有能力先做成命令与工具（host 侧稳定），UI 只做消费方——这样即使 UI 挂了，功能不丢。」
 *
 * 因此面板不直接持有 host 服务，而是面向 `MnemoDataSource` 编程，提供三个适配器：
 *   1. remote —— 宿主通过 `ctx.remote.mnemo` 暴露快照与动作（首选，能力最全）
 *   2. event  —— 从会话事件流推导（零额外 host 接线，只读，用于"至少能看到发生了什么"）
 *   3. demo   —— 内存 fixtures（独立预览与回归测试用）
 *
 * 三个适配器同一接口，切换不需要改任何视图代码。
 */

import type { PanelAction, PanelCellView, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'

export interface MnemoDataSource {
  readonly kind: 'remote' | 'event' | 'demo'
  readonly writable: boolean
  load(): Promise<PanelSnapshot>
  act(a: PanelAction): Promise<{ ok: boolean; message: string }>
  subscribe(fn: (s: PanelSnapshot) => void): () => void
  dispose(): void
}

/** 宿主 remote 面的形状（host 侧按此实现，见 docs/API-CONTRACT.md）。 */
export interface MnemoRemoteFace {
  snapshot(): Promise<PanelSnapshot>
  act(action: PanelAction): Promise<{ ok: boolean; message: string }>
  search?(q: string): Promise<PanelCellView[]>
  subscribe?(fn: (s: PanelSnapshot) => void): () => void
}

export function createRemoteSource(remote: MnemoRemoteFace): MnemoDataSource {
  let off: (() => void) | undefined
  return {
    kind: 'remote',
    writable: true,
    load: () => remote.snapshot(),
    act: (a) => remote.act(a),
    subscribe(fn) {
      off = remote.subscribe?.(fn)
      return () => off?.()
    },
    dispose() {
      off?.()
      off = undefined
    },
  }
}

/**
 * 事件源：只读。从当前会话已经收到的事件里拼一个"够看"的快照。
 * 它不会给你全库浏览（那需要 host 数据），但能回答"这一轮召回了什么、为什么"。
 */
export function createEventSource(opts: {
  getSnapshot: () => PanelSnapshot | null
  onChange: (fn: () => void) => () => void
}): MnemoDataSource {
  const empty: PanelSnapshot = {
    version: 2,
    generatedAt: Date.now(),
    stats: {
      cells: 0,
      edges: 0,
      bytes: 0,
      byKind: {},
      byTier: {},
      supportOne: 0,
      disputed: 0,
      invalidated: 0,
      contradictions: 0,
      hitRate: 0,
      tokensPerTurn: 0,
      tokenSeries: [],
      storageRatio: 0,
      recallP95Ms: 0,
      turns: 0,
      evictions: 0,
    },
    affect: null,
    cells: [],
    edges: [],
    lastRecall: null,
    evictions: [],
    proactive: null,
  }
  return {
    kind: 'event',
    writable: false,
    async load() {
      return opts.getSnapshot() ?? empty
    },
    async act(a) {
      if (a.kind === 'refresh') return { ok: true, message: '已刷新' }
      return { ok: false, message: '当前会话未连接宿主数据面，操作不可用（只读）' }
    },
    subscribe(fn) {
      return opts.onChange(() => {
        const s = opts.getSnapshot()
        if (s) fn(s)
      })
    },
    dispose() {},
  }
}

export function createDemoSource(initial: PanelSnapshot): MnemoDataSource {
  let snap = clone(initial)
  const listeners = new Set<(s: PanelSnapshot) => void>()
  const emit = () => {
    for (const fn of listeners) fn(snap)
  }
  return {
    kind: 'demo',
    writable: true,
    async load() {
      return clone(snap)
    },
    async act(a) {
      const cell = 'cellId' in a ? snap.cells.find((c) => c.cellId === a.cellId) : undefined
      switch (a.kind) {
        case 'pin':
          if (cell) {
            cell.pinned = a.pinned
            cell.importance = a.pinned ? Math.max(cell.importance, 0.8) : cell.importance
          }
          break
        case 'valence':
          if (cell) {
            cell.valence = a.valence
            if (a.salience !== undefined) cell.salience = a.salience
          }
          break
        case 'importance':
          if (cell) cell.importance = a.importance
          break
        case 'forget':
          snap.cells = snap.cells.filter((c) => c.cellId !== a.cellId)
          snap.evictions = [
            { cellId: a.cellId, mode: a.mode, reason: 'panel', actor: 'user', at: Date.now() },
            ...snap.evictions,
          ].slice(0, 50)
          break
        case 'preset':
        case 'surfaceMode':
        case 'config':
        case 'refresh':
          break
        default:
          return { ok: false, message: '演示数据源不支持该操作' }
      }
      emit()
      return { ok: true, message: '已应用（演示数据源，不落库）' }
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    dispose() {
      listeners.clear()
    },
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T
}
