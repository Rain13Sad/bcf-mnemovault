/**
 * 设置（§12.2 / §12.8）
 *
 * 两条规则：
 *   1. **每一项都标注生效时机**（下一轮 / 下次 pass / 需重建 / 需重启）。
 *      不标的话，用户改完不知道要不要重启，就会怀疑"是不是没生效"。
 *   2. 危险操作要二次确认，并且写清楚"会发生什么"。重建不是"刷新"。
 */
import { createElement as h, useState, type ReactNode } from 'react'
import type { PanelAction, PanelSnapshot, Preset, SurfaceMode } from '@rain13sad/dsh-mnemo-core'
import { SubHead, Status, fmt2 } from '../ui.js'

export interface SettingsProps {
  snapshot: PanelSnapshot
  onAct: (a: PanelAction) => void
  onCommand: (line: string) => void
  onPresetChange?: (p: Preset) => void
  onSurfaceModeChange?: (m: SurfaceMode) => void
  busy?: boolean
}

const PRESETS: Array<{ key: Preset; label: string; hint: string }> = [
  { key: 'lean', label: '精简', hint: '3 槽 · 160 token · 最省上下文' },
  { key: 'balanced', label: '均衡', hint: '4 槽 · 320 token · 默认' },
  { key: 'fidelity', label: '高保真', hint: '5 槽 · 560 token · 细节优先' },
]

const MODES: Array<{ key: SurfaceMode; label: string; hint: string }> = [
  { key: 'rows', label: '行式', hint: 'MRS 行，信息密度最高' },
  { key: 'compact', label: '紧凑', hint: '省约 25% token' },
  { key: 'prose', label: '散文', hint: '兼容弱模型' },
]

export function Settings(props: SettingsProps): ReactNode {
  const rt = props.snapshot.runtime
  const s = props.snapshot.stats
  const [confirm, setConfirm] = useState<string | null>(null)
  const preset = (rt?.preset ?? 'balanced') as Preset
  const mode = (rt?.surfaceMode ?? 'rows') as SurfaceMode

  return h(
    'div',
    null,

    h(SubHead, { title: '检索档位', hint: '下一轮生效' }),
    h(
      'div',
      { className: 'mnv-panel' },
      ...PRESETS.map((p) =>
        h(
          'div',
          { key: p.key, className: 'mnv-setting' },
          h('div', null, h('b', null, p.label), h('small', null, p.hint)),
          h(
            'div',
            { className: 'mnv-seg' },
            h(
              'button',
              {
                'data-active': preset === p.key,
                disabled: props.busy,
                onClick: () => {
                  props.onAct({ kind: 'preset', preset: p.key })
                  props.onPresetChange?.(p.key)
                },
              },
              preset === p.key ? '当前' : '切换',
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mnv-setting' },
        h('div', null, h('b', null, '渲染格式'), h('small', null, MODES.find((m) => m.key === mode)?.hint ?? '')),
        h(
          'div',
          { className: 'mnv-seg' },
          ...MODES.map((m) =>
            h(
              'button',
              {
                key: m.key,
                'data-active': mode === m.key,
                disabled: props.busy,
                onClick: () => {
                  props.onAct({ kind: 'surfaceMode', mode: m.key })
                  props.onSurfaceModeChange?.(m.key)
                },
              },
              m.label,
            ),
          ),
        ),
      ),
      h(
        'div',
        { className: 'mnv-setting' },
        h('div', null, h('b', null, '空槽阈值 ignition'), h('small', null, `当前 ${fmt2(rt?.ignition ?? 0.42)} · 调高省 token，调低召回更多但更贵`)),
        h('input', {
          type: 'range',
          min: 0.2,
          max: 0.8,
          step: 0.02,
          defaultValue: rt?.ignition ?? 0.42,
          style: { width: 120, accentColor: 'var(--mnv-accent)' },
          onMouseUp: (e: { currentTarget: HTMLInputElement }) => props.onAct({ kind: 'config', patch: { 'recall.ignition': Number(e.currentTarget.value) } }),
        }),
      ),
    ),

    h(SubHead, { title: '编码与索引', hint: '需重建的项已标注' }),
    h(
      'div',
      { className: 'mnv-panel' },
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, 'L1 切分'),
        h(
          'span',
          null,
          h(Status, { ok: rt?.l1.mode === 'port', text: rt?.l1.mode === 'port' ? `端口 ${rt?.l1.entry ?? ''}` : rt?.l1.enabled ? 'lite 规则切分' : '未启用' }),
          rt?.l1.note ? h('div', { className: 'mnv-muted', style: { marginTop: 2 } }, rt.l1.note) : null,
        ),
      ),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '语义索引'),
        h(
          'span',
          null,
          rt?.ann.mode === 'hnsw' ? `HNSW（${rt.ann.size} 条）` : '精确扫描（小库更快且无误差）',
          h('div', { className: 'mnv-muted', style: { marginTop: 2 } }, `阈值 ${rt?.ann.threshold ?? 2000} cell · 关掉后一律全扫`),
        ),
      ),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '向量维度'),
        h('span', null, `落盘 ${rt?.embStoreDim ?? 64} 维 / 计算 ${rt?.embDim ?? 256} 维（改它需重建）`),
      ),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '存储布局'),
        h('span', null, `MC03 v${rt?.layoutVersion ?? 3} · 每条 cell 约 ${Math.round(s.bytes / Math.max(1, s.cells))} B（含残差）`),
      ),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '数据面'),
        h('span', null, rt?.remoteFace ? 'remote 服务已注册（面板可读写）' : '只读事件源（面板只能看）'),
      ),
      h(
        'div',
        { className: 'mnv-kvrow' },
        h('span', null, '命令面'),
        h('span', null, rt?.commandFace === 'cmdline' ? '/mnemo 已注册' : rt?.commandFace === 'tool' ? '降级为 mnemo_command 工具' : '不可用'),
      ),
    ),

    h(SubHead, { title: '维护', hint: '危险操作需二次确认' }),
    h(
      'div',
      { className: 'mnv-panel' },
      h(
        'div',
        { className: 'mnv-setting' },
        h('div', null, h('b', null, '体检'), h('small', null, '检查孤儿边、悬空槽位、遗留锁、布局版本')),
        h(
          'div',
          { className: 'mnv-actions', style: { marginTop: 0 } },
          h('button', { className: 'mnv-btn', onClick: () => props.onCommand('doctor') }, '运行'),
          h('button', { className: 'mnv-btn', onClick: () => props.onAct({ kind: 'doctor', fix: true }) }, '修复'),
        ),
      ),
      h(
        'div',
        { className: 'mnv-setting' },
        h('div', null, h('b', null, '导出清单'), h('small', null, '脱敏后导出为 JSON，不含原文残差')),
        h('button', { className: 'mnv-btn', onClick: () => props.onCommand('export') }, '导出'),
      ),
      h(
        'div',
        { className: 'mnv-setting' },
        h('div', null, h('b', null, '从日志重建'), h('small', null, '清空派生层（保留图式/人格锚/关系）后按会话日志重放。不删原始日志与残差。')),
        confirm === 'rebuild'
          ? h(
              'div',
              { className: 'mnv-actions', style: { marginTop: 0 } },
              h(
                'button',
                {
                  className: 'mnv-btn',
                  'data-tone': 'danger',
                  onClick: () => {
                    props.onAct({ kind: 'rebuild', confirm: 'rebuild' })
                    props.onCommand('rebuild --from-log --yes')
                    setConfirm(null)
                  },
                },
                '确认重建',
              ),
              h('button', { className: 'mnv-btn', 'data-tone': 'ghost', onClick: () => setConfirm(null) }, '取消'),
            )
          : h('button', { className: 'mnv-btn', 'data-tone': 'danger', onClick: () => setConfirm('rebuild') }, '重建'),
      ),
    ),

    h(SubHead, { title: '关于' }),
    h(
      'div',
      { className: 'mnv-panel' },
      h('div', { className: 'mnv-kvrow' }, h('span', null, '面板数据源'), h('span', null, rt?.source === 'host' ? '宿主快照' : rt?.source === 'remote' ? 'remote' : '只读事件源')),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '库'), h('span', null, rt?.dbPath ?? '—')),
      h('div', { className: 'mnv-kvrow' }, h('span', null, '记忆 / 边'), h('span', null, `${s.cells} / ${s.edges}`)),
      h(
        'div',
        { className: 'mnv-note', style: { marginTop: 8 } },
        '所有改动都会写入 mnemo/settings 事件，便于审计谁在什么时候改了什么。',
      ),
    ),
  )
}
