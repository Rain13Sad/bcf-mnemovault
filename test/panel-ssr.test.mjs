/**
 * 面板渲染冒烟：用 react-dom/server 把四个视图各渲染一遍。
 *
 * 这一步抓的是"视图里引用了不存在的字段""hooks 用错""undefined 参与运算"这类
 * 只有渲染时才炸的问题——它在 CI 里比截图便宜，也比人眼可靠。
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { Timeline } from '../packages/ui/lib/client/views/Timeline.js'
import { Graph } from '../packages/ui/lib/client/views/Graph.js'
import { Affect } from '../packages/ui/lib/client/views/Affect.js'
import { Diagnostics } from '../packages/ui/lib/client/views/Diagnostics.js'
import { Overview } from '../packages/ui/lib/client/views/Overview.js'
import { Search } from '../packages/ui/lib/client/views/Search.js'
import { Organize } from '../packages/ui/lib/client/views/Organize.js'
import { Inbox } from '../packages/ui/lib/client/views/Inbox.js'
import { Settings } from '../packages/ui/lib/client/views/Settings.js'
import { filterCells } from '../packages/ui/lib/client/Panel.js'

const snap = JSON.parse(readFileSync('artifacts/panel-snapshot.json', 'utf8'))
let failed = 0
const check = (name, fn) => {
  try {
    const html = fn()
    if (!html || html.length < 40) throw new Error('输出过短，可能是空渲染')
    console.log(`  ok    ${name} (${html.length} chars)`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}: ${err.message}`)
  }
}

check('Timeline', () =>
  renderToStaticMarkup(
    h(Timeline, {
      cells: snap.cells,
      pageSize: 50,
      onSelect: () => {},
      onAct: () => {},
      onExplain: () => {},
      explain: null,
    }),
  ),
)

check('Timeline + explain', () =>
  renderToStaticMarkup(
    h(Timeline, {
      cells: snap.cells.slice(0, 3),
      pageSize: 50,
      selectedId: snap.cells[0]?.cellId,
      onSelect: () => {},
      onAct: () => {},
      onExplain: () => {},
      explain: { cellId: snap.cells[0]?.cellId, text: 'cell 0000  总分 0.71\n  sim 0.62 × 1.00 = 0.62' },
    }),
  ),
)

check('Graph', () =>
  renderToStaticMarkup(
    h(Graph, {
      cells: snap.cells,
      edges: snap.edges,
      selectedId: snap.cells[0]?.cellId,
      maxNodes: 200,
      onSelect: () => {},
    }),
  ),
)

check('Affect', () =>
  renderToStaticMarkup(
    h(Affect, { snapshot: snap, cells: snap.cells, onSelect: () => {}, enabled: true }),
  ),
)

check('Affect (disabled)', () =>
  renderToStaticMarkup(h(Affect, { snapshot: { ...snap, affect: null }, cells: [], onSelect: () => {}, enabled: false })),
)

check('Diagnostics', () =>
  renderToStaticMarkup(h(Diagnostics, { snapshot: snap, onAct: () => {}, onCommand: () => {} })),
)

check('Overview', () =>
  renderToStaticMarkup(
    h(Overview, {
      snapshot: snap,
      onAct: () => {},
      onCommand: () => {},
      onOpen: () => {},
    }),
  ),
)

check('Search', () =>
  renderToStaticMarkup(
    h(Search, {
      snapshot: snap,
      cells: snap.cells.slice(0, 5),
      query: '',
      onQuery: () => {},
      kind: 'all',
      onKind: () => {},
      lens: 'all',
      onLens: () => {},
      onSelect: () => {},
      onExplain: () => {},
      onAct: () => {},
      explain: null,
    }),
  ),
)

check('Search + explain', () =>
  renderToStaticMarkup(
    h(Search, {
      snapshot: snap,
      cells: snap.cells.slice(0, 2),
      query: '深色',
      onQuery: () => {},
      kind: 'all',
      onKind: () => {},
      lens: 'all',
      onLens: () => {},
      selectedId: snap.cells[0]?.cellId,
      onSelect: () => {},
      onExplain: () => {},
      onAct: () => {},
      explain: { cellId: snap.cells[0]?.cellId, text: 'cell 0000  总分 0.71' },
    }),
  ),
)

check('Organize', () =>
  renderToStaticMarkup(
    h(Organize, {
      snapshot: snap,
      onAct: () => {},
      onCommand: () => {},
      onOpen: () => {},
      graphMaxNodes: 120,
    }),
  ),
)

check('Inbox', () =>
  renderToStaticMarkup(h(Inbox, { snapshot: snap, onAct: () => {}, onCommand: () => {}, onOpen: () => {} })),
)

check('Settings', () =>
  renderToStaticMarkup(h(Settings, { snapshot: snap, onAct: () => {}, onCommand: () => {} })),
)

check('Settings（无 runtime 字段的旧快照也能渲染）', () =>
  renderToStaticMarkup(
    h(Settings, {
      snapshot: { ...snap, runtime: undefined, index: undefined, tags: undefined, categories: undefined, pending: undefined },
      onAct: () => {},
      onCommand: () => {},
    }),
  ),
)

check('filterCells', () => {
  const hit = filterCells(snap.cells, '深色', 'all')
  if (hit.length === 0) throw new Error('搜索"深色"没有命中，过滤逻辑或 demo 数据有问题')
  return 'x'.repeat(40 + hit.length)
})

if (failed) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\npanel ssr smoke passed')
