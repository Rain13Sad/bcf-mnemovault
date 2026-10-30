/**
 * 保留度视图（v0.4 新增）
 *
 * 这一页存在的理由：v0.3 的"遗忘"对用户是不可见的——记忆要么在，要么没了。
 * 而 v0.4 的降档判据换成了七因子保留度之后，**必须能回答"为什么它还在"**，
 * 否则用户没法相信"重要的事不会被冲掉"这句话。
 *
 * 版式顺序 = 阅读顺序：
 *   ① 口径（算的是哪一批、阈值是多少）
 *   ② 六档分布（一眼看出库里有多少在墓碑区）
 *   ③ 神经调制四信号（当前是编码模式还是检索模式）
 *   ④ 逐条分解（七因子柱 + 一句话解释）
 *   ⑤ 再巩固日志（最近哪条记忆被改写过）
 */
import { createElement as h, useState, type ReactNode } from 'react'
import type { PanelAction, PanelSnapshot } from '@rain13sad/dsh-mnemo-core'
import { SubHead, fmt2, relTime } from '../ui.js'

export interface RetentionProps {
  snapshot: PanelSnapshot
  onOpen: (cellId: string) => void
  /** v0.5：墓碑可以复活（原文已释放，只能看到摘要） */
  onAct?: (a: PanelAction) => void
}

const DISPOSITIONS = ['P5', 'P4', 'P3', 'P2', 'P1'] as const
const DISPOSITION_LABEL: Record<string, string> = { P5: '保持', P4: '压缩', P3: '摘要化', P2: '归档', P1: '墓碑' }
// 用"强调色 → 灰 → 警示"的序列，而不是红绿：保留度是"留多少"，不是涨跌。
const DISPOSITION_COLOR: Record<string, string> = {
  P5: 'var(--mnv-accent)',
  P4: 'color-mix(in srgb, var(--mnv-accent) 55%, var(--mnv-bg-sunken))',
  P3: 'var(--mnv-fg-faint)',
  P2: 'var(--mnv-warn)',
  P1: 'var(--mnv-danger)',
}
const FACTOR_LABEL: Record<string, string> = {
  activation: '频率近因',
  importance: '重要度',
  affectIntensity: '情绪',
  connectivity: '关联',
  narrativeRole: '叙事',
  userAffinity: '锚定',
  spacing: '间隔',
  redundancy: '冗余',
}
const WEIGHT_LABEL: Record<string, string> = {
  activation: '频率近因',
  importance: '重要度',
  affect: '情绪',
  connectivity: '关联',
  narrative: '叙事',
  affinity: '锚定',
  spacing: '间隔',
  redundancy: '冗余',
}
const FACTOR_ORDER = ['activation', 'importance', 'affectIntensity', 'connectivity', 'narrativeRole', 'userAffinity', 'spacing', 'redundancy']

export function Retention(props: RetentionProps): ReactNode {
  // 筛选状态必须放在早退之前（hooks 顺序不能变）
  const [q, setQ] = useState('')
  const [only, setOnly] = useState<'all' | 'P5' | 'P4' | 'P3' | 'P2' | 'P1'>('all')
  const [sort, setSort] = useState<'score' | 'tier'>('score')

  const r = props.snapshot.retention
  if (!r) {
    return h(
      'div',
      { className: 'mnv-empty' },
      h('div', null, '这个部署没有提供保留度数据'),
      h('div', null, '宿主版本低于 0.4.0，或记忆库还没跑过降档 pass。'),
      h('div', null, '升级宿主后刷新即可；旧数据会自动按新公式重算，不需要 rebuild。'),
    )
  }

  const needle = q.trim().toLowerCase()
  const shown = r.entries
    .filter((e) => only === 'all' || e.disposition === only)
    .filter((e) => !needle || `${e.digest} ${e.shortId} ${e.why}`.toLowerCase().includes(needle))
    .sort((a, b) => (sort === 'score' ? b.score - a.score : b.tier - a.tier || b.score - a.score))

  const total = DISPOSITIONS.reduce((n, d) => n + (r.byDisposition[d] ?? 0), 0) || 1
  const p5share = (r.byDisposition.P5 ?? 0) / total
  const nm = r.neuromod

  return h(
    'div',
    null,

    // ① 口径
    h(
      'div',
      { className: 'mnv-panel' },
      h(SubHead, { title: '保留度口径', hint: '最近 120 条记忆 · 六档处置' }),
      h(
        'div',
        { className: 'mnv-note' },
        '保留度 = ACT-R 激活（频率+近因）+ 重要度 + 情绪强度 + 关联度 + 叙事角色 + 用户锚定 + 间隔效应 − 冗余。',
      ),
      h(
        'div',
        { className: 'mnv-note' },
        '六档阈值：P5 ≥ 0.75 · P4 ≥ 0.55 · P3 ≥ 0.35 · P2 ≥ 0.18 · 其余 P1。物理删除永不自动执行，只有用户显式发起。',
      ),
      h(
        'div',
        { className: 'mnv-pillrow', style: { marginTop: 8, marginBottom: 0 } },
        h('span', { className: 'mnv-chip' }, `P5 ≥ ${fmt2(r.floors.P5)}`),
        h('span', { className: 'mnv-chip' }, `P4 ≥ ${fmt2(r.floors.P4)}`),
        h('span', { className: 'mnv-chip' }, `P3 ≥ ${fmt2(r.floors.P3)}`),
        h('span', { className: 'mnv-chip' }, `P2 ≥ ${fmt2(r.floors.P2)}`),
      ),
    ),

    // ② 六档分布
    h(
      'div',
      { className: 'mnv-panel' },
      h(SubHead, { title: '六档分布', hint: `${total} 条样本` }),
      h(
        'div',
        { className: 'mnv-tierbar' },
        ...DISPOSITIONS.map((d) => {
          const n = r.byDisposition[d] ?? 0
          return h('i', {
            key: d,
            style: { width: `${(n / total) * 100}%`, background: DISPOSITION_COLOR[d] },
            title: `${d} ${DISPOSITION_LABEL[d]} · ${n} 条`,
          })
        }),
      ),
      p5share > 0.9
        ? h(
            'div',
            { className: 'mnv-note', style: { marginTop: 2 } },
            `样本里 ${Math.round(p5share * 100)}% 是近期新写入的记忆——保留度分化需要时间，跑几周、或把访问时间推旧之后才会看到 P3/P2。`,
          )
        : null,
      h(
        'div',
        { className: 'mnv-pillrow', style: { marginBottom: 0 } },
        ...DISPOSITIONS.map((d) =>
          h(
            'span',
            { key: d, className: 'mnv-chip', title: `${DISPOSITION_LABEL[d]}` },
            h('i', { className: 'mnv-swatch', style: { background: DISPOSITION_COLOR[d] } }),
            `${d} ${DISPOSITION_LABEL[d]}`,
            h('b', { style: { marginLeft: 4, fontWeight: 600 } }, String(r.byDisposition[d] ?? 0)),
          ),
        ),
      ),
    ),

    // ②b 库增长（v0.5）：库必须有"出"，否则迟早变成只增不减的日志
    h(
      'div',
      { className: 'mnv-panel' },
      h(SubHead, { title: '库增长', hint: '墓碑已压实' }),
      h(
        'div',
        { className: 'mnv-gauge' },
        h('div', null, h('b', null, String(props.snapshot.stats.cells)), h('span', null, '总条数')),
        h('div', null, h('b', null, String(tierCount(props.snapshot, 3))), h('span', null, '归档')),
        h('div', null, h('b', null, String(tierCount(props.snapshot, 4))), h('span', null, '墓碑')),
        h('div', null, h('b', null, `${Math.round(props.snapshot.stats.bytes / 1024)}`), h('span', null, 'KB')),
      ),
      h(
        'div',
        { className: 'mnv-note', style: { marginTop: 6 } },
        '墓碑 = 已压实的记忆：残差（原文）与向量都已释放，只剩 id + 摘要 + 槽位，且不参与召回。',
        ' 它不删行——版本链与引用还在；想找回来点某条的「复活」。',
      ),
    ),

    // ③ 神经调制
    h(
      'div',
      { className: 'mnv-panel' },
      h(SubHead, { title: '神经调制四信号', hint: r.mode === 'encode' ? '编码模式' : '检索模式' }),
      h(
        'div',
        { className: 'mnv-gauge' },
        h('div', { title: '多巴胺：预测误差 / 新颖性 → 编码增益' }, h('b', null, fmt2(nm.da)), h('span', null, 'DA δ')),
        h('div', { title: '乙酰胆碱：新信息密度 → 高则抑制联想扩散' }, h('b', null, fmt2(nm.ach)), h('span', null, 'ACh')),
        h('div', { title: '去甲肾上腺素：唤醒 → 检索锐度' }, h('b', null, fmt2(nm.ne)), h('span', null, 'NE')),
        h('div', { title: '皮质醇：负荷+冲突 → 收窄为 exploit' }, h('b', null, fmt2(nm.cort)), h('span', null, 'CORT')),
      ),
      h(
        'div',
        { className: 'mnv-note', style: { marginTop: 8 } },
        `检索温度 ${fmt2(r.temperature)}（高唤醒时降低 → 只取最强通道；应激时升高 → 更保守）。`,
      ),
    ),

    // ④ 权重
    h(
      'div',
      { className: 'mnv-panel' },
      h(SubHead, { title: '当前档位的权重', hint: '改 preset 会改这一组' }),
      h(
        'div',
        { className: 'mnv-pillrow', style: { marginBottom: 0 } },
        ...Object.entries(r.weights)
          .filter(([k]) => k !== 'bias' && k !== 'gain')
          .map(([k, v]) => h('span', { key: k, className: 'mnv-chip' }, `${WEIGHT_LABEL[k] ?? k} ${fmt2(v)}`)),
      ),
    ),

    // ⑤ 逐条分解
    h(
      'div',
      { className: 'mnv-panel' },
      h(SubHead, { title: '逐条分解', hint: '点一条跳到检索页' }),
      h(
        'div',
        { className: 'mnv-filter' },
        h('input', {
          className: 'mnv-input',
          placeholder: '按摘要过滤…',
          value: q,
          'aria-label': '按摘要过滤记忆',
          onChange: (ev: { target: { value: string } }) => setQ(ev.target.value),
        }),
        h(
          'div',
          { className: 'mnv-seg', role: 'group', 'aria-label': '按档位筛选' },
          ...(['all', ...DISPOSITIONS] as const).map((d) =>
            h(
              'button',
              {
                key: d,
                'data-active': only === d,
                'aria-pressed': only === d,
                onClick: () => setOnly(d as typeof only),
              },
              d === 'all' ? '全部' : d,
            ),
          ),
        ),
        h(
          'button',
          {
            className: 'mnv-btn',
            onClick: () => setSort(sort === 'score' ? 'tier' : 'score'),
            title: '切换排序',
          },
          sort === 'score' ? '按分数' : '按档位',
        ),
      ),
      r.entries.length === 0
        ? h('div', { className: 'mnv-muted' }, '库里还没有记忆')
        : shown.length === 0
        ? h('div', { className: 'mnv-empty-sm' }, '没有匹配的记忆——换个词，或把档位筛选切回「全部」')
        : h(
            'div',
            null,
            ...shown.slice(0, 30).map((e) =>
              h(
                'div',
                { key: e.cellId, className: 'mnv-row', style: { cursor: 'pointer' }, onClick: () => props.onOpen(e.cellId) },
                h(
                  'div',
                  { className: 'mnv-row-head' },
                  h('span', { className: 'mnv-rbadge', 'data-d': e.disposition }, `${e.disposition} ${DISPOSITION_LABEL[e.disposition]}`),
                  h('span', { className: 'mnv-kv', title: e.digest }, e.digest || e.shortId),
                  h('span', { className: 'mnv-num' }, fmt2(e.score)),
                ),
                h(
                  'div',
                  { className: 'mnv-sub' },
                  h('span', null, e.why),
                  e.tier >= 4 && props.onAct
                    ? h(
                        'button',
                        {
                          className: 'mnv-btn',
                          style: { marginLeft: 'auto' },
                          onClick: (ev: { stopPropagation(): void }) => {
                            ev.stopPropagation()
                            props.onAct?.({ kind: 'restore', cellId: e.cellId })
                          },
                        },
                        '复活',
                      )
                    : null,
                ),
                h(
                  'div',
                  { className: 'mnv-factors' },
                  ...FACTOR_ORDER.map((k) => {
                    const v = Math.max(0, Math.min(1, e.parts[k] ?? 0))
                    return h('i', {
                      key: k,
                      'data-neg': k === 'redundancy',
                      style: { height: `${Math.max(8, v * 100)}%` },
                      title: `${FACTOR_LABEL[k]} ${fmt2(v)}（贡献 ${fmt2(e.contributions[k] ?? 0)}）`,
                    })
                  }),
                ),
              ),
            ),
          ),
    ),

    // ⑥ 再巩固日志
    h(
      'div',
      { className: 'mnv-panel' },
      h(SubHead, { title: '最近的再巩固', hint: '提取时记忆被改写的记录' }),
      r.reconsolidation.length === 0
        ? h('div', { className: 'mnv-muted' }, '还没有被改写的记忆。被召回且效价/置信度有变化的才会记在这里。')
        : h(
            'div',
            null,
            ...r.reconsolidation.map((x, i) =>
              h(
                'div',
                { key: i, className: 'mnv-sub', style: { padding: '3px 0', justifyContent: 'space-between' } },
                h('span', { className: 'mnv-mono', style: { fontSize: 11 } }, x.cellId.slice(-4)),
                h('span', null, `S ${x.dStability >= 0 ? '+' : ''}${fmt2(x.dStability)}`),
                h('span', null, `C ${x.dConfidence >= 0 ? '+' : ''}${fmt2(x.dConfidence)}`),
                h('span', null, `V ${x.dValence >= 0 ? '+' : ''}${fmt2(x.dValence)}`),
                x.plastic ? h('span', { style: { color: 'var(--mnv-warn)' } }, '可塑') : null,
                h('span', { style: { color: 'var(--mnv-fg-faint)' } }, relTime(x.at)),
              ),
            ),
          ),
    ),
  )
}

function tierCount(snapshot: PanelSnapshot, tier: number): number {
  const byTier = snapshot.stats.byTier ?? {}
  return Number(byTier[tier] ?? byTier[String(tier)] ?? 0)
}

/** 供面板顶部用的极简摘要（一行字），避免把整套视图塞进 header。 */
export function retentionSummary(snapshot: PanelSnapshot): string | null {
  const r = snapshot.retention
  if (!r) return null
  const at = (r.byDisposition.P1 ?? 0) + (r.byDisposition.P2 ?? 0)
  return `P5 ${r.byDisposition.P5 ?? 0} · 低档 ${at}`
}
