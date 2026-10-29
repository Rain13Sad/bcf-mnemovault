/**
 * 桥接层：把 host 侧能力暴露给 client 面板与命令面（§12.6 / §20.2）
 *
 * ── 这一层解决的是三个"接口就绪但没接线"的问题 ───────────────────
 *
 * 1. **`ctx.remote` 面**：面板的 remote 适配器早就按 docs/API-CONTRACT.md 写好了，
 *    但 host 侧从没注册过 contribution，于是面板永远走只读事件源。
 *    现在 host 主动 `ctx.provide('mnemoRemote', face)`，并尽力挂到宿主的 remote 注册表
 *    （形状在 rc 间不固定，所以逐个探测；认不出就只提供本地服务，面板照样能读写）。
 *
 * 2. **命令面**：原来只认 `cmdline.command(name).command(spec)…` 一种形状，
 *    宿主没有就整体降级成 `mnemo_command` 工具。现在探测 4 种已知形状，
 *    并把"最终落在哪一种"写进运行时状态——面板上"命令面：cmdline / 工具降级"是可见的。
 *
 * 3. **面板动作通道**：即使没有 remote，面板按钮也能通过 `mnemoCommands` 走命令面，
 *    不再出现"按钮点了没反应、也没提示"。
 *
 * 一条原则：**每一层都必须是"能力变少但不变错"**。任何探测失败都只是少一个入口，
 * 不会让已有功能失效，也不会假装成功。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryService, PanelAction, PanelCellView, PanelSnapshot, RuntimeStatus } from '@rain13sad/dsh-mnemo-core'

/** host 与 client 共享的 remote 面形状（docs/API-CONTRACT.md §3）。 */
export interface MnemoRemoteFace {
  snapshot(): Promise<PanelSnapshot>
  act(action: PanelAction): Promise<{ ok: boolean; message: string }>
  search?(q: string): Promise<PanelCellView[]>
  subscribe?(fn: (s: PanelSnapshot) => void): () => void
}

export interface BridgeResult {
  remote: boolean
  commandFace: 'cmdline' | 'tool' | 'none'
  notes: string[]
}

/**
 * 注册 remote 面。三件事：
 *   ① 提供 `mnemoRemote` 服务（面板用 ctx.get('mnemoRemote') 取）
 *   ② 尽力挂到宿主 remote 注册表（四种形状，认不出就跳过）
 *   ③ 记录状态，让面板显示"已连接宿主 / 只读"
 */
export function registerRemoteFace(ctx: Context, memory: MemoryService, runtime?: RuntimeStatus): { face: MnemoRemoteFace; notes: string[] } {
  const notes: string[] = []
  const face: MnemoRemoteFace = {
    snapshot: async () => memory.panelSnapshot(),
    act: async (a) => {
      try {
        return memory.applyAction(a)
      } catch (err) {
        return { ok: false, message: String((err as Error)?.message ?? err) }
      }
    },
    search: async (q: string) => memory.search(q, 50),
    subscribe: (fn) => memory.onPanelUpdate(fn),
  }

  try {
    ctx.provide('mnemoRemote', face)
    notes.push('mnemoRemote 已提供')
  } catch {
    notes.push('mnemoRemote 已存在（热重载复用）')
  }

  // 宿主的 remote 注册表：形状不稳定，逐个探测，全部失败也不算错误
  const remote = ctx.get('remote') as Record<string, unknown> | undefined
  let attached = false
  if (remote) {
    try {
      if (typeof remote.register === 'function') {
        ;(remote.register as (n: string, f: unknown) => unknown).call(remote, 'mnemo', face)
        attached = true
      } else if (typeof remote.contribute === 'function') {
        ;(remote.contribute as (c: unknown) => unknown).call(remote, { name: 'mnemo', ...face })
        attached = true
      } else if (typeof remote.define === 'function') {
        ;(remote.define as (n: string, f: unknown) => unknown).call(remote, 'mnemo', face)
        attached = true
      } else if (remote.contributions && typeof (remote.contributions as Map<string, unknown>).set === 'function') {
        ;(remote.contributions as Map<string, unknown>).set('mnemo', face)
        attached = true
      }
    } catch (err) {
      notes.push(`ctx.remote 注册失败：${String((err as Error)?.message ?? err)}`)
    }
  }
  if (!remote) notes.push('宿主未提供 ctx.remote，面板走本地 mnemoRemote 服务')
  else if (!attached) notes.push('ctx.remote 形状未识别，面板走本地 mnemoRemote 服务')

  if (runtime) {
    runtime.remoteFace = true
    runtime.capabilities = [...runtime.capabilities.filter((c) => !c.startsWith('remote')), attached ? 'remote · 已挂宿主注册表' : 'remote · 本地服务']
  }
  return { face, notes }
}

/**
 * 注册命令桥：面板按钮 → host 命令面。
 * 与 `mnemo_command` 工具共用同一个 runCommand，所以"面板上能点的"和"命令行能敲的"永远一致。
 */
export function registerCommandBridge(ctx: Context, run: (argv: string[]) => Promise<string>, runtime?: RuntimeStatus): void {
  const svc = {
    run: async (line: string) => {
      const argv = line.trim().split(/\s+/).filter(Boolean)
      return run(argv)
    },
    /** 面板上直接调用的便捷入口 */
    exec: async (line: string) => run(line.trim().split(/\s+/).filter(Boolean)),
  }
  try {
    ctx.provide('mnemoCommands', svc)
  } catch {
    /* 已存在 */
  }
  if (runtime) runtime.capabilities = [...runtime.capabilities.filter((c) => !c.startsWith('命令')), '命令面 · 已桥接']
}

/** 只读快照服务：没有 remote 的部署里，面板至少能显示"这一轮发生了什么"。 */
export function registerSnapshotBridge(ctx: Context, memory: MemoryService): void {
  try {
    ctx.provide('mnemoSnapshot', {
      get: () => {
        try {
          return memory.panelSnapshot()
        } catch {
          return null
        }
      },
      subscribe: (fn: () => void) => memory.onPanelUpdate(() => fn()),
    })
  } catch {
    /* 已存在 */
  }
}

export interface CmdlineLike {
  command?(name: string): unknown
  register?(def: unknown): unknown
  define?(name: string, spec: string, handler: unknown): unknown
}

/**
 * 命令面探测。返回最终落地的形态，调用方据此决定要不要注册 `mnemo_command` 工具。
 *
 * 四种形状（按出现频率排序）：
 *   A. cmdline.command('mnemo').command('<command> [args...]').description().action(fn)
 *   B. cmdline.register({ name, description, handler })
 *   C. cmdline.define('mnemo', '<command> [args...]', handler)
 *   D. commands.register(...)  —— 少数宿主把命令面挂在另一个服务名下
 */
export function attachCommandFace(
  ctx: Context,
  handler: (argv: string[]) => Promise<string>,
  runtime?: RuntimeStatus,
): 'cmdline' | 'none' {
  const tryChain = (svc: CmdlineLike): boolean => {
    if (typeof svc.command !== 'function') return false
    try {
      const root = svc.command('mnemo') as { command?: (s: string) => unknown }
      if (!root || typeof root.command !== 'function') return false
      const sub = root.command('<command> [args...]') as {
        description?: (d: string) => unknown
        action?: (fn: unknown) => unknown
      }
      const withDesc = typeof sub.description === 'function' ? (sub.description('记忆与情感管理（/mnemo help 查看全部）') as typeof sub) : sub
      if (typeof withDesc.action !== 'function') return false
      withDesc.action(((...a: unknown[]) => handler(a.map(String))) as never)
      return true
    } catch {
      return false
    }
  }

  const tryRegister = (svc: CmdlineLike): boolean => {
    if (typeof svc.register !== 'function') return false
    try {
      svc.register({
        name: 'mnemo',
        description: '记忆与情感管理（/mnemo help 查看全部）',
        usage: '/mnemo <command> [args...]',
        handler: (...a: unknown[]) => handler(a.map(String)),
      })
      return true
    } catch {
      return false
    }
  }

  const tryDefine = (svc: CmdlineLike): boolean => {
    if (typeof svc.define !== 'function') return false
    try {
      svc.define('mnemo', '<command> [args...]', (...a: unknown[]) => handler(a.map(String)))
      return true
    } catch {
      return false
    }
  }

  const holders = [ctx.get('cmdline'), ctx.get('commands')].filter(Boolean) as CmdlineLike[]
  for (const svc of holders) {
    if (tryChain(svc) || tryRegister(svc) || tryDefine(svc)) {
      if (runtime) {
        runtime.commandFace = 'cmdline'
        runtime.capabilities = [...runtime.capabilities.filter((c) => !c.startsWith('命令')), '命令面 · cmdline']
      }
      return 'cmdline'
    }
  }
  if (runtime) {
    runtime.commandFace = 'tool'
    runtime.capabilities = [...runtime.capabilities.filter((c) => !c.startsWith('命令')), '命令面 · 工具降级']
  }
  return 'none'
}
