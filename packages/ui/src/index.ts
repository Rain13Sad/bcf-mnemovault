/**
 * @bcf/dsh-mnemo-ui 的 host 侧入口。
 *
 * 面板本身跑在 client（`./client` 子路径），host 侧只需要知道三件事：
 * 它叫什么、面板 id 是什么、需要哪些 client 服务。这样 host 的 manifest
 * 与 client 的 apply 不会各自写一份互相漂移的常量。
 */

export const name = 'mnemo-ui'
export const PANEL_ID = 'mnemo'
export const clientEntry = '@bcf/dsh-mnemo-ui/client'
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

export { MnemoPanel, type PanelProps } from './client/Panel.js'
export { defaultConfig, type Config } from './client/index.js'
