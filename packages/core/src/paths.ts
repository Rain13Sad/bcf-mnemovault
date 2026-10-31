/**
 * 库路径解析（v0.5.3）
 *
 * ── 这个文件为什么存在 ────────────────────────────────────────────
 * v0.5.2 及以前，`cordis.patch.yml` 里写的是：
 *
 *     dbPath: !!js `${ctx.baseDir}/mnemo/vault.db`
 *
 * 这里有**两个**各自致命的问题，v0.5.3 才被真实安装流程暴露出来：
 *
 * ① **`!!js` 标签在安装期解析不了。** DSH 的组合包校验（`dsh plugin add` /
 *    插件管理器的安装流程）用不带自定义标签的 YAML 解析器读 patch，遇到
 *    `!!js` 直接抛 `YAMLException: cannot resolve a node with
 *    !<tag:yaml.org,2002:js> explicit tag`，整个安装被回滚。也就是说：
 *    任何用 `!!js` 写配置的组合包**根本装不上**。
 *
 * ② **`ctx.baseDir` 不存在。** 它是 HMR 服务自己的属性，不是 Loader 的。
 *    Loader 上叫 `baseUrl`（profile 目录的 file: URL）。所以就算 `!!js` 能求值，
 *    拿到的也是 `undefined/mnemo/vault.db`——会在当前工作目录建一个叫
 *    `undefined` 的文件夹。
 *
 * 结论：**依赖宿主运行时的路径不能烘进 patch**。patch 只写普通字面量，
 * 需要宿主上下文的默认值在 `apply()` 里解析——那里拿得到真正的 `ctx.baseUrl`。
 *
 * 解析顺序（`resolveVaultPath`）：
 *   1. `:memory:` 等非路径标记 → 原样返回
 *   2. `~` / `~/x` → 用户主目录（schema 默认值就是这个形态，此前从未展开）
 *   3. 绝对路径 → 原样
 *   4. 相对路径 → 相对 profile 目录（`ctx.baseUrl`），没有就相对 cwd
 */

import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `:memory:` / `file::memory:` 这类不是文件路径的标记。 */
const NON_PATH = /^(?::memory:|file::memory:)/

/**
 * 展开 `~`。只认 `~` 与 `~/x`（以及 Windows 上的 `~\x`）——
 * `~user/x` 这种形态在 Windows 上无意义，原样返回比猜错好。
 */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(home, p.slice(2))
  return p
}

/**
 * 把配置里的一个路径字符串解析成绝对路径。
 *
 * @param p 配置值。空串表示"未设置"，原样返回（调用方据此判断功能关闭）。
 * @param baseUrl profile 目录的 file: URL（Loader 的 `ctx.baseUrl`），可缺省。
 * @param home 主目录，测试可注入。
 */
export function resolveVaultPath(p: string, baseUrl?: string, home: string = homedir()): string {
  if (!p) return p
  if (NON_PATH.test(p)) return p
  const expanded = expandHome(p, home)
  if (isAbsolute(expanded)) return expanded
  const base = baseUrl ? dirOfBaseUrl(baseUrl) : undefined
  return base ? resolve(base, expanded) : resolve(expanded)
}

/** 从 `file:///.../profiles/desktop/` 拿到目录；不是 file: URL 就返回 undefined。 */
function dirOfBaseUrl(baseUrl: string): string | undefined {
  if (!baseUrl.startsWith('file:')) return undefined
  try {
    const path = fileURLToPath(baseUrl)
    // 目录 URL 带尾斜杠时 fileURLToPath 会保留分隔符，resolve 自己会处理
    return path
  } catch {
    return undefined
  }
}

/** 只取 `ctx.baseUrl`，不做任何断言——宿主换成别的实现时安静降级。 */
export function baseUrlOf(ctx: unknown): string | undefined {
  const v = (ctx as { baseUrl?: unknown } | undefined)?.baseUrl
  return typeof v === 'string' && v.length > 0 ? v : undefined
}
