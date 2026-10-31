/**
 * @rain13sad/dsh-mnemo-ui —— host 侧入口（组合包里的那一行）
 *
 * ── 为什么 host 侧必须是一个真插件（v0.5.3）──────────────────────
 * v0.5.2 的这个文件只导出几个常量，没有 `apply`。后果有两层：
 *
 * ① **装不上。** 包声明了 `dsh.client` 却没声明 `dsh.bundle`，插件管理器判定
 *    "这个包没有声明组合包，不能作为插件管理"（DSH 的 `not-bundle`）——
 *    用户在管理器里点安装，装到最后一步被拒。
 * ② **面板永远不出现。** 面板是一行 client 插件，client 名单由 Loader 树扫描
 *    `dsh.client` 得到；没有行就没有名单，`lib/client.js` 一次也不会被请求。
 *    也就是说 v0.5.2 的面板只在 `npm run panel` 的预览里存在过。
 *
 * 现在 host 侧是一个**空转的 Cordis 插件**：它什么都不做，存在的意义是让这一行
 * 在 Loader 树里成立，从而让 client 名单扫到它。真正的逻辑全在 `./client`。
 *
 * ⚠ 这里**不要** import `./client/*`：那会把 react 与整个面板拖进 host 进程。
 * 面板只在浏览器里跑，host 只需要知道"我这一行叫什么"。
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'mnemo-ui'

/** 无宿主服务依赖：面板的数据面走 `ctx.get('mnemoRemote')`（可选）。 */
export const inject = []

export const PANEL_ID = 'mnemo'
export const clientEntry = '@rain13sad/dsh-mnemo-ui/client'
export const clientInject = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-api-remotes',
]

/**
 * host 侧空转。
 *
 * 只写一行 info：出问题时 `dsh` 的日志里能看出这一层确实装上了，
 * 而不是"面板没出来，到底是没装还是 client 名单没扫到"。
 */
export function apply(ctx: Context): void {
  const logger = (ctx as unknown as { logger(n: string): { info(m: string): void } }).logger?.('mnemo-ui')
  logger?.info(`panel row mounted (client entry: ${clientEntry})`)
}
