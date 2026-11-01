/**
 * 调控台（v0.6）
 *
 * ── 它解决的真实问题 ────────────────────────────────────────────
 * v0.5 的设置页是"配置项的镜子"：把 config 摊开，改完说"下一轮生效"。
 * 这有两个毛病：
 *   1. 用户不知道该改哪个——七个召回权重并列，没有先后
 *   2. 改完不知道变了什么——只有一行 toast
 *
 * 调控台的做法是**先算再改**：每个旋钮旁边实时显示它对"token/轮"与"成本"的影响，
 * 提交前还能 dry-run。这不是把设置页做花，是把"参数 → 后果"这条链显式化。
 *
 * ── 为什么只放 16 个旋钮 ────────────────────────────────────────
 * 只放"改了立刻能看出差别"的。`dbPath` / `embDim` / `sdrK` 这类要重启或重建的
 * 一律不进来——把需要 rebuild 的东西做成滑杆，就是在骗用户"拖一下就好了"。
 *
 * ── 引擎卡片为什么在这个页面 ────────────────────────────────────
 * 因为"调参"与"换模型"是同一个决策的两面：预算紧了可以少给记忆，
 * 也可以换个便宜的模型。把两者放在同一屏，用户才能比较。
 */

import { createElement as h, useMemo, useState, type ReactNode } from 'react'
import type { PanelAction, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'

export interface ConsoleProps {
  snapshot: PanelSnapshot
  onAct: (a: PanelAction) => void
  onCommand?: (line: string) => void
  busy?: boolean
}

type Value = number | string | boolean

interface KnobSpec {
  key: string
  label: string
  group: string
  min?: number
  max?: number
  step?: number
  /** 选项型旋钮 */
  options?: Array<{ value: string; label: string }>
  note: string
}

const KNOBS: KnobSpec[] = [
  { key: 'maxSlots', label: '竞争槽位', group: '召回', min: 3, max: 5, step: 1, note: '+1 槽约 +45 token/轮' },
  { key: 'maxEntriesPerTurn', label: '单轮条目上限', group: '召回', min: 2, max: 16, step: 1, note: '真正决定注入条数的上限' },
  { key: 'recall.ignition', label: '空槽阈值', group: '召回', min: 0.1, max: 0.9, step: 0.01, note: '↑ 更省 token，也更容易漏' },
  { key: 'recall.wSim', label: '相似度权重', group: '召回', min: 0, max: 2, step: 0.05, note: '主信号，一般不动' },
  { key: 'recall.wRecency', label: '近期优先', group: '召回', min: 0, max: 1, step: 0.05, note: '↑ 更偏向新记忆' },
  { key: 'recall.wFreq', label: '复述强化', group: '召回', min: 0, max: 1, step: 0.05, note: '被反复提到的更容易回来' },
  { key: 'recall.wAffect', label: '心境一致性', group: '情感', min: 0, max: 0.25, step: 0.01, note: '上限 0.25，防负向自强化' },
  { key: 'recall.wGoal', label: '任务相关', group: '召回', min: 0, max: 1, step: 0.05, note: '有目标时生效' },
  { key: 'recall.wCue', label: '情境依赖', group: '召回', min: 0, max: 1, step: 0.05, note: '同话题场景的加成' },
  { key: 'recall.wInterf', label: '冗余惩罚', group: '召回', min: 0, max: 1, step: 0.05, note: '↑ 更不容易给出重复条目' },
  { key: 'recall.graphHops', label: '联想跳数', group: '召回', min: 1, max: 3, step: 1, note: '↑ 更发散，也更慢' },
  { key: 'maxSurfaceTokens', label: '注入硬预算', group: '预算', min: 80, max: 800, step: 10, note: '超过就从尾部丢条目' },
  {
    key: 'surfaceMode',
    label: '渲染格式',
    group: '预算',
    options: [
      { value: 'rows', label: '行式（强模型）' },
      { value: 'compact', label: '列式（省 25%）' },
      { value: 'prose', label: '散文（弱模型）' },
    ],
    note: '弱模型看不懂行式，会白花 token',
  },
  { key: 'llm.maxPricePerTurn', label: '价格上限（元/轮）', group: '预算', min: 0, max: 0.01, step: 0.0001, note: '0 = 不限；超了会自动裁剪' },
  { key: 'affectEnabled', label: '情感内核', group: '情感', options: [{ value: 'true', label: '开' }, { value: 'false', label: '关' }], note: '关掉后不做情感门控、不注入情感行' },
  { key: 'consolidation.everyTurns', label: '巩固频率（轮）', group: '巩固', min: 5, max: 100, step: 1, note: '↑ 更省 CPU，抽象更慢' },
]

const GROUPS = ['召回', '预算', '情感', '巩固']

export function Console(props: ConsoleProps): ReactNode {
  const base = props.snapshot.tuning?.values ?? {}
  const [draft, setDraft] = useState<Record<string, Value>>({})
  const merged = useMemo(() => ({ ...base, ...draft }), [base, draft])
  const dirty = useMemo(() => Object.keys(draft).filter((k) => draft[k] !== base[k]), [draft, base])
  const engine = props.snapshot.engine ?? null

  const tokens = estimateTokens(merged)
  const price = engine?.model?.inputPricePerMTok ?? 0
  const cost = (tokens / 1_000_000) * price

  const set = (k: string, v: Value) => setDraft((d) => ({ ...d, [k]: v }))

  const apply = () => {
    if (dirty.length === 0) return
    const patch: Record<string, Value> = {}
    for (const k of dirty) patch[k] = draft[k]
    props.onAct({ kind: 'tune', patch })
    setDraft({})
  }

  return h(
    'div',
    { className: 'mnv-console' },
    h(
      'div',
      { className: 'mnv-console-grid' },

      // ── 引擎卡片 ──────────────────────────────────────────────
      h(
        'section',
        { className: 'mnv-card' },
        h('div', { className: 'mnv-card-head' }, h('b', null, '引擎'), h('span', { className: 'mnv-muted' }, engine ? engine.model?.label ?? '未知模型' : '未接入')),
        engine
          ? h(
              'div',
              { className: 'mnv-engine' },
              h(Row, { k: '模型', v: `${engine.model?.id ?? '—'} · 窗口 ${fmtK(engine.model?.contextWindow ?? 0)}` }),
              h(Row, {
                k: '语义路',
                v: engine.embedding.mode === 'provider' ? `${engine.embedding.name}` : '本地哈希（零依赖）',
                tone: engine.embedding.mode === 'provider' ? 'ok' : 'muted',
              }),
              h(Row, { k: '向量空间', v: `${engine.embedding.space}${engine.embedding.vaultSpace !== engine.embedding.space ? ` → 库 ${engine.embedding.vaultSpace}` : ''}` }),
              h(Row, {
                k: '抽取',
                v: engine.extractor.mode === 'provider' ? `${engine.extractor.name}（失败率 ${(engine.extractor.failRate * 100).toFixed(1)}%）` : '规则（零依赖）',
                tone: engine.extractor.failRate > 0.05 ? 'warn' : 'muted',
              }),
              h(Row, { k: '计数口径', v: engine.tokenizer }),
              engine.lastCompile
                ? h(Row, {
                    k: '最近编译',
                    v: `${engine.lastCompile.tokens} tok · ¥${engine.lastCompile.cost.toFixed(6)} · ${engine.lastCompile.mode}`,
                  })
                : null,
              h(
                'div',
                { className: 'mnv-engine-actions' },
                h('button', { className: 'mnv-btn', 'data-tone': 'ghost', disabled: props.busy, onClick: () => props.onAct({ kind: 'engine', action: 'probe' }) }, '连通性探测'),
                h('button', { className: 'mnv-btn', 'data-tone': 'ghost', disabled: props.busy, onClick: () => props.onAct({ kind: 'engine', action: 'reembed' }) }, '重算向量'),
                h('button', { className: 'mnv-btn', 'data-tone': 'ghost', disabled: props.busy, onClick: () => props.onAct({ kind: 'engine', action: 'compile' }) }, '重编上下文'),
              ),
              engine.limits.length
                ? h(
                    'ul',
                    { className: 'mnv-engine-limits' },
                    ...engine.limits.slice(0, 4).map((l, i) => h('li', { key: i }, l)),
                  )
                : null,
            )
          : h(
              'div',
              { className: 'mnv-empty' },
              h('div', null, '未安装 mnemo-llm'),
              h('div', null, '当前走哈希 embedding + 规则抽取，一切照常工作；装上它才有真模型与跨模型编译。'),
            ),
      ),

      // ── 旋钮 ──────────────────────────────────────────────────
      h(
        'section',
        { className: 'mnv-card' },
        h(
          'div',
          { className: 'mnv-card-head' },
          h('b', null, '旋钮'),
          h('span', { className: 'mnv-muted' }, dirty.length ? `${dirty.length} 项待应用` : '预设档覆盖中'),
        ),
        ...GROUPS.map((g) =>
          h(
            'div',
            { className: 'mnv-knob-group', key: g },
            h('div', { className: 'mnv-knob-group-title' }, g),
            ...KNOBS.filter((k) => k.group === g).map((k) => h(Knob, { key: k.key, spec: k, value: merged[k.key], onChange: (v) => set(k.key, v) })),
          ),
        ),
      ),

      // ── 影响预估 ──────────────────────────────────────────────
      h(
        'section',
        { className: 'mnv-card' },
        h('div', { className: 'mnv-card-head' }, h('b', null, '影响预估'), h('span', { className: 'mnv-muted' }, '改之前先看')),
        h(
          'div',
          { className: 'mnv-impact' },
          h('div', { className: 'mnv-impact-num' }, h('b', null, String(tokens)), h('span', null, 'token / 轮')),
          h('div', { className: 'mnv-impact-num' }, h('b', null, `¥${cost.toFixed(6)}`), h('span', null, '每轮注入成本')),
          h('div', { className: 'mnv-impact-num' }, h('b', null, String(merged.maxEntriesPerTurn ?? '—')), h('span', null, '条目上限')),
        ),
        engine?.across?.length
          ? h(
              'table',
              { className: 'mnv-table mnv-across' },
              h('thead', null, h('tr', null, h('th', null, '模型'), h('th', null, 'token'), h('th', null, '格式'), h('th', null, '成本'))),
              h(
                'tbody',
                null,
                ...engine.across.map((m) =>
                  h(
                    'tr',
                    { key: m.id, 'data-active': m.id === engine.model?.id },
                    h('td', null, m.label),
                    h('td', null, String(m.tokens)),
                    h('td', null, m.mode),
                    h('td', null, `¥${m.cost.toFixed(6)}`),
                  ),
                ),
              ),
            )
          : h('div', { className: 'mnv-note' }, '库里有记忆后，这里会显示同一批内容在 6 个常见模型下的 token 与成本。'),
        h(
          'div',
          { className: 'mnv-console-actions' },
          h('button', { className: 'mnv-btn', 'data-tone': 'primary', disabled: props.busy || dirty.length === 0, onClick: apply }, `应用${dirty.length ? ` (${dirty.length})` : ''}`),
          h('button', { className: 'mnv-btn', 'data-tone': 'ghost', disabled: dirty.length === 0, onClick: () => setDraft({}) }, '撤销'),
          h(
            'button',
            {
              className: 'mnv-btn',
              'data-tone': 'ghost',
              onClick: () => props.onCommand?.('/mnemo models'),
            },
            '看模型清单',
          ),
        ),
        h(
          'div',
          { className: 'mnv-note' },
          '改细项即视为 preset=custom（不会被预设档覆盖回去）。所有改动下一轮生效，不需要重启。',
        ),
      ),
    ),
  )
}

function Row(props: { k: string; v: string; tone?: 'ok' | 'warn' | 'muted' }): ReactNode {
  const color = props.tone === 'ok' ? 'var(--mnv-pos)' : props.tone === 'warn' ? 'var(--mnv-warn)' : props.tone === 'muted' ? 'var(--mnv-fg-soft)' : undefined
  return h('div', { className: 'mnv-kv' }, h('span', null, props.k), h('span', { style: { color }, title: props.v }, props.v))
}

function Knob(props: { spec: KnobSpec; value: Value | undefined; onChange: (v: Value) => void }): ReactNode {
  const { spec, value } = props
  if (spec.options) {
    return h(
      'label',
      { className: 'mnv-knob' },
      h('div', { className: 'mnv-knob-label' }, h('span', null, spec.label), h('span', { className: 'mnv-knob-val' }, labelOf(spec, value))),
      h(
        'select',
        { className: 'mnv-select', value: String(value ?? ''), onChange: (e: { target: { value: string } }) => props.onChange(e.target.value) },
        ...spec.options.map((o) => h('option', { key: o.value, value: o.value }, o.label)),
      ),
      h('div', { className: 'mnv-knob-note' }, spec.note),
    )
  }
  const num = typeof value === 'number' ? value : Number(value ?? 0)
  return h(
    'label',
    { className: 'mnv-knob' },
    h('div', { className: 'mnv-knob-label' }, h('span', null, spec.label), h('span', { className: 'mnv-knob-val' }, fmtNum(num, spec.step))),
    h('input', {
      type: 'range',
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value: num,
      onChange: (e: { target: { value: string } }) => props.onChange(Number(e.target.value)),
    }),
    h('div', { className: 'mnv-knob-note' }, spec.note),
  )
}

function labelOf(spec: KnobSpec, v: Value | undefined): string {
  const hit = spec.options?.find((o) => o.value === String(v))
  return hit?.label ?? String(v ?? '—')
}

function fmtNum(x: number, step?: number): string {
  if (!Number.isFinite(x)) return '—'
  if (step && step >= 1) return String(Math.round(x))
  if (step && step < 0.001) return x.toFixed(4)
  return (Math.round(x * 100) / 100).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/**
 * token/轮估算（与 core 的 `estimateTokensPerTurn` 同口径，但不 import 它）。
 *
 * 为什么复制而不是 import：这是 **client 代码**，浏览器里没有 core 的运行时
 * （面板只拿到快照）。为了让面板能"改之前先算"，只能带一份公式。
 * 两处口径若漂移，`test/v06-panel.test.mjs` 的对拍会抓住。
 */
export function estimateTokens(values: Record<string, Value>): number {
  const mode = String(values.surfaceMode ?? 'rows')
  const per = mode === 'compact' ? 14 : mode === 'prose' ? 58 : 23
  const slots = Number(values.maxSlots ?? 4)
  const entries = Math.min(Number(values.maxEntriesPerTurn ?? 8), slots * 2)
  const legend = mode === 'compact' ? 120 : 140
  const affect = values.affectEnabled === false || values.affectEnabled === 'false' ? 0 : 28
  return legend + entries * per + affect
}
