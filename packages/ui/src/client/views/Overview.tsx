/**
 * 记忆总览（参考 DSH 记忆插件的首屏结构）
 *
 * 这一页回答四个问题，顺序就是版式顺序：
 *   ① 库在哪、怎么维护（存储路径 + 三个动作）
 *   ② 现在有多少、有多少需要处理（指标格 + 分类统计）
 *   ③ 索引健康吗（索引状态 + 标签）
 *   ④ 最近发生了什么、有什么在等我（四列）
 * 最后是"后端能力"——把 L1 / ANN / 命令面 / remote 的真实形态摆出来，
 * 而不是让人去翻 README 猜。
 */
import { createElement as h, type ReactNode } from 'react'
import type { PanelAction, PanelCellView, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import { KIND_LABEL, Stat, Status, SubHead, fmt2, fmtTime, mmdd, relTime } from '../ui.js'

export interface OverviewProps {
  snapshot: PanelSnapshot
  onAct: (a: PanelAction) => void
  onCommand: (line: string) => void
  onOpen: (cellId: string, tab: 'timeline' | 'search' | 'inbox') => void
  busy?: boolean
}

export function Overview(props: OverviewProps): ReactNode {
  const s = props.snapshot.stats
  const rt = props.snapshot.runtime
  const idx = props.snapshot.index
  const tags = props.snapshot.tags ?? []
  const cats = props.snapshot.categories ?? []
  const pending = props.snapshot.pending ?? []
  const recentNew = props.snapshot.recentNew ?? []
  const recentUpd = props.snapshot.recentUpdated ?? []
  const conflicts = props.snapshot.edges.filter((e) => e.relName === 'CONTRADICTS')

  const archived = Object.entries(s.byTier).filter(([k]) => Number(k) >= 2).reduce((n, [, v]) => n + v, 0)
  const pinned = props.snapshot.cells.filter((c) => c.pinned).length
  const ignored = props.snapshot.evictions.filter((e) => e.mode === 'soft').length
  const pendingMerge = props.snapshot.cells.filter((c) => c.support <= 1 && !c.invalidated).length

  return h(
    'div',
    null,

    // ① 存储路径
    h(
      'div',
      { className: 'mnv-panel' },
      h(
        'div',
        { className: 'mnv-subhead', style: { marginTop: 0 } },
        h('b', null, '存储路径'),
        h('span', null, rt?.storeKind === 'sqlite' ? 'SQLite 晶格' : '内存晶格'),
      ),
      h('code', { className: 'mnv-code', title: rt?.dbPath ?? '' }, rt?.dbPath ?? '（未配置）'),
      h(
        'div',
        { className: 'mnv-actions', style: { marginTop: 8 } },
        h('button', { className: 'mnv-btn', disabled: props.busy, onClick: () => props.onAct({ kind: 'consolidate' }) }, '同步索引'),
        h('button', { className: 'mnv-btn', disabled: props.busy, onClick: () => props.onAct({ kind: 'rebuild', confirm: 'rebuild' }) }, '手动重建索引'),
        h('button', { className: 'mnv-btn', onClick: () => props.onCommand('export') }, '导出清单'),
      ),
      h(
        'div',
        { className: 'mnv-pillrow', style: { marginTop: 8, marginBottom: 0 } },
        h('span', { className: 'mnv-chip' }, `布局 v${rt?.layoutVersion ?? 3}`),
        h('span', { className: 'mnv-chip' }, `档位 ${rt?.preset ?? 'balanced'}`),
        h('span', { className: 'mnv-chip' }, `渲染 ${rt?.surfaceMode ?? 'rows'}`),
        h('span', { className: 'mnv-chip' }, `ignition ${fmt2(rt?.ignition ?? 0.42)}`),
        h('span', { className: 'mnv-chip' }, `向量 ${rt?.embStoreDim ?? 64}/${rt?.embDim ?? 256} 维`),
        h('span', { className: 'mnv-chip' }, rt?.ann.mode === 'hnsw' ? '语义路 HNSW' : '语义路 精确扫描'),
      ),
    ),

    // ② 指标格
    h(
      'div',
      { className: 'mnv-panel' },
      h('div', { className: 'mnv-subhead', style: { marginTop: 0 } }, h('b', null, '记忆总览')),
      h(
        'div',
        { className: 'mnv-stats' },
        h(Stat, { label: '记忆总数', value: s.cells }),
        h(Stat, { label: '待确认', value: pending.length, tone: pending.length ? 'warn' : undefined }),
        h(Stat, { label: '冲突/异常', value: s.contradictions + s.disputed, tone: s.contradictions ? 'danger' : undefined }),
        h(Stat, { label: '置顶', value: pinned }),
        h(Stat, { label: '已归档', value: archived }),
        h(Stat, { label: '已忽略', value: ignored }),
        h(Stat, { label: '单证据', value: pendingMerge, title: 'support=1 的记忆：还没被重复确认过' }),
        h(Stat, { label: '索引条目', value: idx?.entries ?? s.cells }),
      ),
    ),

    // ③ 分类统计
    cats.length > 0
      ? h(
          'div',
          { className: 'mnv-panel' },
          h('div', { className: 'mnv-subhead', style: { marginTop: 0 } }, h('b', null, '分类统计'), h('span', null, '一条记忆可以同时属于多类')),
          h('div', { className: 'mnv-stats' }, ...cats.map((c) => h(Stat, { key: c.key, label: c.label, value: c.count }))),
        )
      : null,

    // ④ 索引状态
    h(
      'div',
      { className: 'mnv-panel' },
      h('div', { className: 'mnv-subhead', style: { marginTop: 0 } }, h('b', null, '索引状态')),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '索引构建时间'),
        h('span', null, fmtTime(idx?.builtAt ?? props.snapshot.generatedAt)),
      ),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '索引状态'),
        h('span', null, h(Status, { ok: idx?.status === 'ok', text: idx?.status === 'ok' ? '正常' : idx?.status === 'stale' ? '需要整理' : '需要重建' })),
      ),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '索引文件'), h('span', null, h('code', null, idx?.path ?? '—'))),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '上次重建'),
        h('span', null, idx?.lastRebuildAt ? fmtTime(idx.lastRebuildAt) : '从未重建（首次写入即为全量）'),
      ),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '语义路'),
        h(
          'span',
          null,
          rt?.ann.mode === 'hnsw'
            ? `HNSW · ${rt.ann.size} 条向量（阈值 ${rt.ann.threshold}）`
            : `精确扫描（cell ${s.cells} < 阈值 ${rt?.ann.threshold ?? 2000}，无近似误差）`,
        ),
      ),
    ),

    // ⑤ 标签
    h(
      'div',
      { className: 'mnv-panel' },
      h('div', { className: 'mnv-subhead', style: { marginTop: 0 } }, h('b', null, '标签'), h('span', null, '从槽位与摘要里统计的实词')),
      tags.length === 0
        ? h('div', { className: 'mnv-muted' }, '暂无数据')
        : h('div', { className: 'mnv-tags' }, ...tags.map((t) => h('span', { key: t.tag, className: 'mnv-tag' }, t.tag, h('i', null, t.count)))),
    ),

    // ⑥ 四列最近
    h(
      'div',
      { className: 'mnv-panel' },
      h(
        'div',
        { className: 'mnv-cols' },
        column('最近新增', recentNew, props.onOpen, 'timeline'),
        column('最近更新', recentUpd, props.onOpen, 'timeline'),
        column('待确认的记忆', pending.slice(0, 6), props.onOpen, 'inbox'),
        column(
          '冲突与异常',
          conflicts.slice(0, 6).map((e) => ({
            cellId: e.src,
            shortId: e.src.slice(-4),
            digest: `${e.src.slice(-4)} ⇄ ${e.dst.slice(-4)}（权重 ${e.weight}）`,
            kind: 1,
            tFrom: props.snapshot.generatedAt,
          })) as PanelCellView[],
          props.onOpen,
          'inbox',
        ),
      ),
    ),

    // ⑦ 后端能力
    h(
      'div',
      { className: 'mnv-panel' },
      h('div', { className: 'mnv-subhead', style: { marginTop: 0 } }, h('b', null, '后端能力')),
      h('div', { className: 'mnv-pillrow' }, ...(rt?.capabilities ?? []).map((c) => h('span', { key: c, className: 'mnv-chip' }, c))),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, 'L1 切分'),
        h('span', null, rt?.l1.mode === 'port' ? `模型端口（${rt.l1.entry ?? '—'}）` : rt?.l1.enabled ? 'lite 规则切分（模型未就绪）' : '未启用'),
      ),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '命令面'), h('span', null, commandFaceLabel(rt?.commandFace))),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '数据面'), h('span', null, rt?.remoteFace ? 'remote 服务已注册（可读写）' : '只读事件源')),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '已注册工具'),
        h('span', null, h('code', null, (rt?.tools ?? []).join(', ') || '—')),
      ),
      (rt?.limits ?? []).length
        ? h(
            'div',
            { style: { marginTop: 8 } },
            ...(rt?.limits ?? []).map((x, i) => h('div', { key: i, className: 'mnv-note' }, `· ${x}`)),
          )
        : null,
    ),

    // ⑧ 成本
    h(
      'div',
      { className: 'mnv-panel' },
      h('div', { className: 'mnv-subhead', style: { marginTop: 0 } }, h('b', null, '成本')),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '注入量'),
        h('span', null, `${s.tokensPerTurn.toFixed(0)} token/轮 · 预算上限 ${rt?.preset === 'lean' ? 160 : rt?.preset === 'fidelity' ? 560 : 320}`),
      ),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '存储比'), h('span', null, `${fmt2(s.storageRatio)}× · 单条约 ${Math.round((s.bytes / Math.max(1, s.cells)))} B（含残差）`)),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '召回 p95'), h('span', null, `${s.recallP95Ms} ms`)),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '最近整理'),
        h(
          'span',
          null,
          props.snapshot.consolidation
            ? `${fmtTime(props.snapshot.consolidation.at)} · 合并 ${props.snapshot.consolidation.merged} · 抽象 ${props.snapshot.consolidation.abstracted}`
            : '还没有跑过巩固 pass',
        ),
      ),
    ),
  )
}

function column(
  title: string,
  cells: PanelCellView[],
  onOpen: (id: string, tab: 'timeline' | 'search' | 'inbox') => void,
  tab: 'timeline' | 'search' | 'inbox',
): ReactNode {
  return h(
    'div',
    { className: 'mnv-col' },
    h('h5', null, `${title}${cells.length ? ` · ${cells.length}` : ''}`),
    cells.length === 0
      ? h('div', { className: 'mnv-muted' }, '暂无数据')
      : cells.map((c) =>
          h(
            'div',
            { key: c.cellId, className: 'mnv-mini', onClick: () => onOpen(c.cellId, tab), title: c.digest },
            h('div', null, c.digest || c.shortId),
            h(
              'div',
              null,
              h('span', null, KIND_LABEL[c.kind] ?? '事实'),
              h('span', null, c.tFrom ? relTime(c.tFrom) : mmdd(c.tFrom)),
              c.disputed ? h('span', { style: { color: 'var(--mnv-warn)' } }, '争议') : null,
            ),
          ),
        ),
  )
}

function commandFaceLabel(face?: 'cmdline' | 'tool' | 'none'): string {
  if (face === 'cmdline') return '/mnemo 命令面已注册'
  if (face === 'tool') return '降级为 mnemo_command 工具（功能不丢）'
  return '不可用'
}
