/**
 * @rain13sad/dsh-mnemo-ui —— 侧栏面板（client 侧插件）
 *
 * 这里用的是 DSH 0.2.1-rc.3 **实际发布包**里的 client 插件契约（不是文档里的示意）：
 *   · 模块导出 `name` / `inject` / `apply(ctx)`（见 @deepseek-ai/dsh-client-ui-agent-preset 的 lib/client.js）
 *   · 面板本体注册进 `main` 槽（keyed, scope: root），侧栏图标注册进 `sidebar.panellist`（list, scope: root）
 *   · 注册返回 disposer，必须放进 ctx.effect，否则热重载后残留（§14.7）
 *   · 打开面板用 ctx.layout.selectPanel(id)
 *   · package.json 的 `dsh.client.inject` 声明需要哪些 client 服务
 *
 * 类型说明：本包刻意不把整套 client 依赖树装进 devDependencies（那会把 react 与十几个
 * ui-* 包一起拖进来）。因此用一个结构化的 `ClientContext` 描述我们真正用到的面，
 * 逐条对照 lib/types/client/index.d.ts 与 slots 的 register 重载。契约变更时这里会先炸，
 * 而不是等到运行时白屏——这是"窄接口 + 显式校验"优于宽泛 any 的地方。
 */

import { createElement as h, type ReactNode } from 'react'
import type { PanelAction, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import { MnemoPanel } from './Panel.js'
import { createDemoSource, createEventSource, createRemoteSource, type MnemoDataSource, type MnemoRemoteFace } from './data.js'

export const name = 'mnemo-ui'

/**
 * client 侧服务依赖。`slots` 与 `layout` 是硬依赖；`sessions`/`locale`/`remote` 可选。
 * 对应 package.json 的 `dsh.client.inject`。
 */
export const inject = ['slots', 'layout']

export const PANEL_ID = 'mnemo'

interface RegisterOptions {
  name: string
  key?: string
  id?: string
  order?: number
  label?: string | (() => string)
  locale?: string
  inject?: () => Record<string, unknown>
  registrant?: string
  priority?: number
}

interface ClientContext {
  effect(fn: () => () => void, label?: string): unknown
  slots: {
    register(options: RegisterOptions, component: (props: Record<string, unknown>) => ReactNode): () => void
    inject?(name: string, fn: () => () => void): () => void
  }
  layout?: { selectPanel(id: string): void }
  on?(name: string, listener: (...args: never[]) => void): () => void
  logger?(name: string): { info(msg: string): void; warn(msg: string): void }
  get?(name: string): unknown
}

export interface Config {
  pageSize: number
  graphMaxNodes: number
  /** 打开面板时默认停在哪个视图 */
  defaultTab: 'timeline' | 'graph' | 'affect' | 'diagnostics'
  /** 无 remote 时是否允许降级为只读事件源 */
  allowReadOnlyFallback: boolean
}

export const defaultConfig: Config = {
  pageSize: 50,
  graphMaxNodes: 200,
  defaultTab: 'timeline',
  allowReadOnlyFallback: true,
}

export function apply(ctx: ClientContext, config: Config = defaultConfig): void {
  const log = ctx.logger?.('mnemo-ui')

  const source = resolveSource(ctx, config)
  log?.info(`panel source = ${source.kind}`)

  const open = () => {
    try {
      ctx.layout?.selectPanel(PANEL_ID)
    } catch (err) {
      log?.warn(`selectPanel failed: ${String(err)}`)
    }
  }

  // 面板本体：`main` 是 keyed/root 槽，key 即 MainPanelId。
  ctx.effect(() => {
    const dispose = ctx.slots.register(
      { name: 'main', key: PANEL_ID, registrant: '@rain13sad/dsh-mnemmo-ui' },
      () =>
        h(MnemoPanel, {
          source,
          pageSize: config.pageSize,
          graphMaxNodes: config.graphMaxNodes,
          initialTab: config.defaultTab,
          affectEnabled: true,
          runCommand: buildCommandBridge(ctx),
        }),
    )
    return () => dispose()
  }, 'mnemo-ui: main panel')

  // 侧栏入口：`sidebar.panellist` 是 list/root 槽，id 与 main key 对齐，
  // 侧栏据此渲染图标按钮，并自动把它列进「更多」菜单（§12.1 的入口位置）。
  ctx.effect(() => {
    const dispose = ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 60, label: () => '记忆', registrant: '@rain13sad/dsh-mnemo-ui' },
      (props) => h(PanelIcon, { size: Number(props.size ?? 16), active: Boolean(props.active) }),
    )
    return () => dispose()
  }, 'mnemo-ui: sidebar launcher')

  // 命令面 `mnemo open-panel` 由 host 侧 tools 发出，这里接住
  ctx.effect(() => {
    const off = ctx.on?.('mnemo/open-panel' as never, (() => open()) as never)
    return () => off?.()
  }, 'mnemo-ui: open-panel event')
}

/**
 * 数据源选择：remote > host 注入的快照 > 只读事件源 > 演示数据。
 * 这条链的每一级都是"功能变少但不变错"，没有一级会假装有数据。
 */
function resolveSource(ctx: ClientContext, config: Config): MnemoDataSource {
  const remote = (ctx.get?.('remote') as Record<string, unknown> | undefined)?.['mnemo'] as MnemoRemoteFace | undefined
  if (remote?.snapshot) return createRemoteSource(remote)

  const injected = ctx.get?.('mnemoSnapshot') as { get(): PanelSnapshot | null; subscribe(fn: () => void): () => void } | undefined
  if (injected && config.allowReadOnlyFallback) {
    return createEventSource({
      getSnapshot: () => injected.get(),
      onChange: (fn) => injected.subscribe(fn),
    })
  }

  if (config.allowReadOnlyFallback) {
    return createEventSource({ getSnapshot: () => null, onChange: () => () => {} })
  }

  return createDemoSource(emptySnapshot())
}

/** 命令桥：面板按钮 → host 命令面。没有就明确告知，而不是静默失败。 */
function buildCommandBridge(ctx: ClientContext): ((line: string) => Promise<string>) | undefined {
  const cmd = ctx.get?.('mnemoCommands') as { run(line: string): Promise<string> | string } | undefined
  if (!cmd?.run) return undefined
  return async (line: string) => String(await cmd.run(line))
}

function PanelIcon(props: { size: number; active: boolean }): ReactNode {
  const s = props.size
  return h(
    'svg',
    { width: s, height: s, viewBox: '0 0 16 16', 'aria-hidden': 'true', style: { display: 'block' } },
    h('path', {
      d: 'M3 3.2h10a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H7.4L4.6 13.6v-2.2H3a1 1 0 0 1-1-1V4.2a1 1 0 0 1 1-1z',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinejoin: 'round',
      opacity: props.active ? 1 : 0.72,
    }),
    h('circle', { cx: 5.6, cy: 7.2, r: 0.9, fill: 'currentColor', opacity: 0.9 }),
    h('circle', { cx: 8, cy: 7.2, r: 0.9, fill: 'currentColor', opacity: 0.9 }),
    h('circle', { cx: 10.4, cy: 7.2, r: 0.9, fill: 'currentColor', opacity: 0.9 }),
  )
}

function emptySnapshot(): PanelSnapshot {
  return {
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
}

export { MnemoPanel } from './Panel.js'
export { formatBreakdownClient } from './explain.js'
export { CSS } from './style.js'
export type { MnemoDataSource, MnemoRemoteFace } from './data.js'
export type { PanelAction, PanelSnapshot }
