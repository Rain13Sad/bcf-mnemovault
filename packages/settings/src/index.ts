/**
 * @bcf/dsh-mnemo-settings —— 设置面板 schema + 预设档 + 生效矩阵（§12.2 / §12.8 / §13）
 *
 * 一条原则：**不要手写 UI 表单**。DSH 的插件配置由 Config（schemastery）声明，
 * 设置面板据此生成表单。把 Config 写清楚就够了——这是"可操作性"的最低成本实现，
 * 也是唯一不会随 DSH 升级而失效的实现。
 *
 * 本包做的是 Config 做不到的三件事：
 *   1. 预设档与细项的互斥（选 lean 时细项置灰并显示该档取值）
 *   2. 生效矩阵（哪些改动需要 rebuild / restart，面板要标黄并给按钮）
 *   3. 配置快照导出（调参结论必须能复现，否则换机器又得重来）
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  EFFECT_MATRIX,
  PRESETS,
  REBUILD_KEYS,
  applyPreset,
  estimateTokensPerTurn,
  type MemoryService,
  type MnemoConfig,
  type Preset,
} from '@bcf/dsh-mnemo-core'

export const name = 'mnemo-settings'
export const inject = ['memory']

export interface Config {
  /** 面板分页大小（性能约束，§12.10） */
  panelPageSize: number
  /** 图谱节点上限 */
  graphMaxNodes: number
  /** 安全组是否加锁（改动需二次确认） */
  lockSafetyGroup: boolean
}

export const Config: z<Config> = z.object({
  panelPageSize: z.number().min(20).max(200).default(50).description('时间线虚拟滚动单页条数'),
  graphMaxNodes: z.number().min(50).max(500).default(200).description('图谱节点上限，超过改用聚类视图'),
  lockSafetyGroup: z.boolean().default(true).description('安全组加锁：改动需二次确认'),
})

export interface SettingField {
  group: '档位' | '检索' | '记忆' | '情感' | '安全' | '诊断'
  key: string
  label: string
  value: number | string | boolean
  /** 该档预设下的取值（preset ≠ custom 时显示这个，而不是当前值） */
  presetValue?: number | string | boolean
  /** 生效时机 */
  timing: 'next-turn' | 'next-pass' | 'rebuild' | 'restart' | 'immediate'
  /** 影响预估：token / 召回率 / 延迟 */
  impact: string
  editable: boolean
  /** 需要二次确认（安全组） */
  locked?: boolean
}

export class MnemoSettingsService extends Service {
  config: Config
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mnemoSettings')
    this.config = config
  }

  private get memory(): MemoryService {
    return this.ctx.get('memory') as MemoryService
  }

  current(): MnemoConfig {
    return this.memory.config
  }

  /** 预设档与细项不并列生效：选 lean/balanced/fidelity 时细项被覆盖。 */
  setPreset(preset: Preset): MnemoConfig {
    return this.memory.setConfig({ preset })
  }

  set(patch: Partial<MnemoConfig>): MnemoConfig {
    return this.memory.setConfig(patch)
  }

  /** 设置面板的数据源：每个参数都带"当前实际值 + 影响预估"。 */
  fields(): SettingField[] {
    const c = this.current()
    const preset = c.preset === 'custom' ? undefined : PRESETS[c.preset as Exclude<Preset, 'custom'>]
    const editable = c.preset === 'custom'
    const tokens = estimateTokensPerTurn(c)
    const rows: SettingField[] = [
      { group: '档位', key: 'preset', label: '预设档', value: c.preset, timing: 'next-turn', impact: `当前约 ${tokens} token/轮`, editable: true },
      { group: '档位', key: 'maxSlots', label: '竞争槽位', value: c.maxSlots, presetValue: preset?.maxSlots, timing: 'next-turn', impact: `+1 槽约 +45 token/轮`, editable },
      { group: '档位', key: 'surfaceMode', label: '渲染格式', value: c.surfaceMode, presetValue: preset?.surfaceMode, timing: 'next-turn', impact: 'compact 省约 25% token', editable },
      { group: '档位', key: 'maxSurfaceTokens', label: '注入预算', value: c.maxSurfaceTokens, presetValue: preset?.maxSurfaceTokens, timing: 'next-turn', impact: '硬上限，超出从尾部丢条目', editable },
      { group: '检索', key: 'recall.wSim', label: '相似度权重', value: c.recall.wSim, timing: 'next-turn', impact: '主信号，提高更"字面"', editable },
      { group: '检索', key: 'recall.wRecency', label: '近期优先', value: c.recall.wRecency, timing: 'next-turn', impact: '提高可缓解"答旧版本"', editable },
      { group: '检索', key: 'recall.wFreq', label: '复述强化', value: c.recall.wFreq, timing: 'next-turn', impact: '复述越多越优先', editable },
      { group: '检索', key: 'recall.wAffect', label: '心境一致', value: c.recall.wAffect, timing: 'next-turn', impact: '上限 0.25，防负向自强化', editable },
      { group: '检索', key: 'recall.wGoal', label: '任务相关', value: c.recall.wGoal, timing: 'next-turn', impact: '无 goal 时不计入', editable },
      { group: '检索', key: 'recall.wCue', label: '情境匹配', value: c.recall.wCue, timing: 'next-turn', impact: '编码/提取环境一致性', editable },
      { group: '检索', key: 'recall.wInterf', label: '冗余惩罚', value: c.recall.wInterf, timing: 'next-turn', impact: '调低可减少槽内重复', editable },
      { group: '检索', key: 'recall.ignition', label: '空槽阈值', value: c.recall.ignition, presetValue: preset?.ignition, timing: 'next-turn', impact: '↑ 省 token（↓ 会更贵）', editable },
      { group: '检索', key: 'recall.graphHops', label: '图跳数', value: c.recall.graphHops, presetValue: preset?.graphHops, timing: 'next-turn', impact: '多跳深度，3 跳起收益递减', editable },
      { group: '记忆', key: 'forgettingProfile', label: '遗忘档位', value: c.forgettingProfile, presetValue: preset?.forgettingProfile, timing: 'next-turn', impact: '只改 S₀ 不改曲线形状', editable },
      { group: '记忆', key: 'consolidation.everyTurns', label: '巩固间隔', value: c.consolidation.everyTurns, presetValue: preset?.everyTurns, timing: 'next-pass', impact: '已排队的 pass 用旧参数', editable },
      { group: '记忆', key: 'consolidation.schemaMinSupport', label: '抽象门槛', value: c.consolidation.schemaMinSupport, timing: 'next-pass', impact: '同一规律被观察几次才抽象', editable },
      { group: '记忆', key: 'consolidation.remLinkBudget', label: '联想边预算', value: c.consolidation.remLinkBudget, presetValue: preset?.remLinkBudget, timing: 'next-pass', impact: 'REM 每 pass 最多新增边数', editable },
      { group: '记忆', key: 'sdrDim', label: 'SDR 维度', value: c.sdrDim, timing: 'rebuild', impact: '改了维度，旧 cell 的 SDR 全部失效', editable },
      { group: '情感', key: 'affectEnabled', label: '启用情感', value: c.affectEnabled, timing: 'next-turn', impact: '关闭后记忆仍工作，走降级路径', editable },
      { group: '情感', key: 'affect.moodTau', label: '心境惯性', value: 20, timing: 'next-turn', impact: '调大更稳（30+），调小更跳变', editable },
      { group: '情感', key: 'affect.personaDriftEpsilon', label: '人格漂移上限', value: 0.25, timing: 'next-turn', impact: '只在超界时收缩，不会放大', editable },
      { group: '安全', key: 'safety.piiRedaction', label: '编码期脱敏', value: c.safety.piiRedaction, timing: 'immediate', impact: '安全项立即生效', editable: true, locked: true },
      { group: '安全', key: 'safety.blockMemoryInEgress', label: '外发守卫', value: c.safety.blockMemoryInEgress, timing: 'immediate', impact: 'fail-closed，不确定就拒绝', editable: true, locked: true },
      { group: '安全', key: 'safety.requireApprovalFor', label: '审批清单', value: c.safety.requireApprovalFor.join(','), timing: 'immediate', impact: '列出的工具需用户确认', editable: true, locked: true },
      { group: '诊断', key: 'stats.cells', label: '记忆条数', value: this.memory.stats().cells, timing: 'next-turn', impact: '只读', editable: false },
      { group: '诊断', key: 'stats.hitRate', label: '命中率', value: this.memory.stats().hitRate, timing: 'next-turn', impact: '只读', editable: false },
      { group: '诊断', key: 'stats.tokensPerTurn', label: 'tokens/轮', value: Math.round(this.memory.stats().tokensPerTurn), timing: 'next-turn', impact: '只读', editable: false },
    ]
    return rows
  }

  /** 生效矩阵（§12.8），面板据此标黄。 */
  matrix(): Array<{ group: string; key: string; timing: 'next-turn' | 'next-pass' | 'rebuild' | 'restart' | 'immediate'; note: string }> {
    return EFFECT_MATRIX
  }

  /** 需要重建的键：面板要给按钮，而不是只留一个"保存"。 */
  rebuildKeys(): string[] {
    return REBUILD_KEYS
  }

  /** 配置快照：调参结论必须能复现（§13.3 第 7 步）。 */
  exportSnapshot(): string {
    return JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), config: this.current() }, null, 2)
  }

  /** 导入快照（回滚到某次调参结论）。 */
  importSnapshot(json: string): MnemoConfig {
    const parsed = JSON.parse(json) as { config?: Partial<MnemoConfig> }
    if (!parsed.config) throw new Error('快照缺少 config 字段')
    return this.memory.setConfig(applyPreset({ ...this.current(), ...parsed.config }))
  }
}

export function apply(ctx: Context, config: Config) {
  const service = new MnemoSettingsService(ctx, config)
  ctx.logger('mnemo-settings').info(`settings ready (page=${config.panelPageSize}, graphNodes=${config.graphMaxNodes})`)
  return service
}

export { PRESETS, EFFECT_MATRIX, estimateTokensPerTurn }
