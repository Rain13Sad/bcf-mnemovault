/**
 * 预设档与生效矩阵（对应 §12.3 / §12.8 / §16）
 *
 * 一条硬规则：`preset` 与细项**不并列生效**。选 lean/balanced/fidelity 时细项被覆盖，
 * 只有 custom 才逐项可改。这避免了"我改了但被预设覆盖"的经典困惑。
 */

import type { MnemoConfig, Preset } from './types.js'

export type PresetName = Exclude<Preset, 'custom'>

export interface PresetSpec {
  maxSlots: number
  maxEntriesPerTurn: number
  surfaceMode: MnemoConfig['surfaceMode']
  maxSurfaceTokens: number
  ignition: number
  graphHops: number
  everyTurns: number
  remLinkBudget: number
  forgettingProfile: MnemoConfig['forgettingProfile']
  /** 典型 token/轮（设计目标，实测回填见 §18） */
  typicalTokens: number
}

export const PRESETS: Record<PresetName, PresetSpec> = {
  lean: {
    maxSlots: 3,
    maxEntriesPerTurn: 4,
    surfaceMode: 'compact',
    maxSurfaceTokens: 160,
    ignition: 0.52,
    graphHops: 1,
    everyTurns: 40,
    remLinkBudget: 60,
    forgettingProfile: 'semantic',
    typicalTokens: 105,
  },
  balanced: {
    maxSlots: 4,
    maxEntriesPerTurn: 8,
    surfaceMode: 'rows',
    maxSurfaceTokens: 320,
    ignition: 0.42,
    graphHops: 2,
    everyTurns: 20,
    remLinkBudget: 200,
    forgettingProfile: 'semantic',
    typicalTokens: 184,
  },
  fidelity: {
    maxSlots: 5,
    maxEntriesPerTurn: 12,
    surfaceMode: 'rows',
    maxSurfaceTokens: 560,
    ignition: 0.32,
    graphHops: 3,
    everyTurns: 10,
    remLinkBudget: 400,
    forgettingProfile: 'procedure',
    typicalTokens: 320,
  },
}

/** preset ≠ custom 时覆盖细项；custom 原样返回。 */
export function applyPreset(cfg: MnemoConfig): MnemoConfig {
  if (cfg.preset === 'custom') return cfg
  const p = PRESETS[cfg.preset as PresetName]
  if (!p) return cfg
  return {
    ...cfg,
    maxSlots: p.maxSlots,
    maxEntriesPerTurn: p.maxEntriesPerTurn,
    surfaceMode: p.surfaceMode,
    maxSurfaceTokens: p.maxSurfaceTokens,
    forgettingProfile: p.forgettingProfile,
    recall: { ...cfg.recall, ignition: p.ignition, graphHops: p.graphHops },
    consolidation: { ...cfg.consolidation, everyTurns: p.everyTurns, remLinkBudget: p.remLinkBudget },
  }
}

/** 该预设档下细项的实际取值，供设置面板在置灰时显示。 */
export function presetValues(name: PresetName): PresetSpec {
  return PRESETS[name]
}

export type EffectTiming = 'next-turn' | 'next-pass' | 'rebuild' | 'restart' | 'immediate'

export interface EffectRow {
  group: string
  key: string
  timing: EffectTiming
  note: string
}

/** 生效矩阵（§12.8）。设置面板据此标黄并给出按钮，而不是只留一个"保存"。 */
export const EFFECT_MATRIX: EffectRow[] = [
  { group: '档位', key: 'maxSlots', timing: 'next-turn', note: '纯读侧，无需重载' },
  { group: '档位', key: 'surfaceMode', timing: 'next-turn', note: '纯读侧' },
  { group: '档位', key: 'maxSurfaceTokens', timing: 'next-turn', note: '硬预算' },
  { group: '档位', key: 'maxEntriesPerTurn', timing: 'rebuild', note: '渲染条目上限，改后建议 rebuild 保持一致' },
  { group: '检索', key: 'recall.ignition', timing: 'next-turn', note: '空槽阈值，↑ 省 token' },
  { group: '检索', key: 'recall.*', timing: 'next-turn', note: '各权重即时生效' },
  { group: '记忆', key: 'forgettingProfile', timing: 'next-turn', note: 'R(t) 查询时计算' },
  { group: '记忆', key: 'consolidation.*', timing: 'next-pass', note: '已排队的 pass 用旧参数' },
  { group: '记忆', key: 'sdrDim', timing: 'rebuild', note: '改了维度，旧 cell 的 SDR 全部失效' },
  { group: '记忆', key: 'sdrK', timing: 'rebuild', note: '同上' },
  { group: '记忆', key: 'embDim', timing: 'rebuild', note: '同上' },
  { group: '记忆', key: 'dbPath', timing: 'restart', note: '换库' },
  { group: '情感', key: 'affectEnabled', timing: 'next-turn', note: '关掉后走降级路径' },
  { group: '情感', key: 'affect.moodTau', timing: 'next-turn', note: '心境惯性' },
  { group: '安全', key: 'safety.*', timing: 'immediate', note: '安全项不允许延迟生效' },
]

export function timingOf(key: string): EffectTiming {
  const hit = EFFECT_MATRIX.find((r) => r.key === key || (r.key.endsWith('*') && key.startsWith(r.key.slice(0, -1))))
  return hit?.timing ?? 'next-turn'
}

/** 需要重建的键（UI 标黄 + 给按钮）。 */
export const REBUILD_KEYS = EFFECT_MATRIX.filter((r) => r.timing === 'rebuild').map((r) => r.key)

/**
 * token/轮估算：条目数 × 单条 token + 图例。
 * 单条 rows ≈ 23 token、compact ≈ 14、prose ≈ 58（附录 A 的口径，实测回填）。
 */
export function estimateTokensPerTurn(cfg: MnemoConfig, includeLegend = true): number {
  const perEntry = cfg.surfaceMode === 'compact' ? 14 : cfg.surfaceMode === 'prose' ? 58 : 23
  const entries = Math.min(cfg.maxEntriesPerTurn, cfg.maxSlots * 2)
  const legend = includeLegend ? (cfg.surfaceMode === 'compact' ? 120 : 140) : 0
  return legend + entries * perEntry + (cfg.affectEnabled ? 28 : 0)
}
