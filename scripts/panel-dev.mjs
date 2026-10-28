/**
 * 面板独立预览服务器（不依赖 bundler）
 *
 * 构建逻辑在 `scripts/panel-build.mjs`（`npm run panel:build`），这里只负责
 * 把 `artifacts/panel/` 起成静态站点——因为 `npm test` 也要用同一份产物，
 * 而测试不能拉起一个不退出的服务器。
 *
 *   node scripts/panel-dev.mjs [port]
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { buildPanel } from './panel-build.mjs'

const root = process.cwd()
const port = Number(process.argv[2] ?? 5178)

let outDir
try {
  outDir = buildPanel(root)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]
  const path = normalize(join(outDir, url === '/' ? 'index.html' : url))
  if (!path.startsWith(outDir)) {
    res.writeHead(403).end('forbidden')
    return
  }
  try {
    const body = readFileSync(path)
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`panel preview → http://127.0.0.1:${port}/`)
})
