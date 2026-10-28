/**
 * @bcf/dsh-mnemo-core —— 插件入口（§15.4）
 *
 * 配置直接写在插件行的 `config` 下，由 schemastery 校验并生成设置表单。
 * 不手写 UI 表单：这是"可操作性"的最低成本实现，也是唯一不会随 DSH 升级而失效的实现（§12.2）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyPreset, PRESETS, EFFECT_MATRIX, estimateTokensPerTurn } from './preset.js'
import { MemoryService } from './service.js'
import type { MnemoConfig } from './types.js'

export const name = 'mnemo-core'
/**
 * 文档 §14.2 写的是 `['storage', 'sessions']`。这里只保留 `sessions`：
 * core 直接走 node:fs + node:sqlite，从不读写 `ctx.storage`，
 * 把插件挂在一个用不到的服务上，只会让它在缺该服务的部署里静默不加载。
 * 需要 host 存储时应通过 `ctx.get('storage')` 做可选依赖（§14.3 的降级惯例）。
 */
export const inject = ['sessions']

export const Config = z.object({
  dbPath: z.string().default('~/.dsh/mnemo/vault.db').description('晶格数据库路径。换库需重启（§12.8）'),
  scopeKey: z.string().default('user:local').description('作用域键。多用户部署传 user:<id>；改它等于换一个记忆域'),
  residualDir: z.string().default('~/.dsh/mnemo/blob').description('残差存储目录'),
  sdrDim: z
    .union([z.const(1024), z.const(2048), z.const(4096)])
    .default(2048)
    .description('SDR 维度。改后必须 /mnemo rebuild（容量与噪声底的折中，§6.5）'),
  sdrK: z.number().min(4).max(16).default(8).description('激活位数。k/D 决定噪声底，改后必须重建'),
  embDim: z.number().min(64).max(1024).default(256).description('语义向量维度。改后必须重建'),
  preset: z
    .union([z.const('lean'), z.const('balanced'), z.const('fidelity'), z.const('custom')])
    .default('balanced')
    .description('预设档；选 custom 才启用下方细项'),
  maxSlots: z.number().min(3).max(5).default(4).description('竞争槽位数。+1 槽约 +45 token/轮'),
  maxEntriesPerTurn: z.number().min(2).max(16).default(8).description('单轮条目上限'),
  surfaceMode: z
    .union([z.const('rows'), z.const('compact'), z.const('prose')])
    .default('rows')
    .description('渲染格式。compact 省 25% token，prose 兼容弱模型'),
  maxSurfaceTokens: z.number().min(80).max(800).default(320).description('注入硬预算'),
  forgettingProfile: z
    .union([z.const('procedure'), z.const('semantic'), z.const('episodic')])
    .default('semantic')
    .description('遗忘速度档位，只改 S₀ 不改曲线形状'),
  affectEnabled: z.boolean().default(true).description('关闭后记忆仍工作，但检索不做情感门控、不注入情感状态行'),
  recall: z.object({
    wSim: z.number().min(0).max(2).default(1.0).description('相似度权重（主信号）'),
    wRecency: z.number().min(0).max(1).default(0.35).description('近期优先'),
    wFreq: z.number().min(0).max(1).default(0.2).description('复述强化'),
    wAffect: z.number().min(0).max(0.25).default(0.25).description('心境一致性（上限固定，防负向自强化）'),
    wGoal: z.number().min(0).max(1).default(0.4).description('任务相关优先'),
    wCue: z.number().min(0).max(1).default(0.3).description('情境依赖'),
    wInterf: z.number().min(0).max(1).default(0.5).description('冗余惩罚'),
    ignition: z.number().min(0).max(1).default(0.42).description('空槽阈值。↑ 省 token（降低阈值会更贵，§13.2）'),
    annTopK: z.number().min(16).max(256).default(64).description('语义路候选数'),
    graphHops: z.number().min(1).max(3).default(2).description('多跳深度'),
    graphDecay: z.number().min(0.3).max(0.9).default(0.6).description('跳衰减'),
  }),
  consolidation: z.object({
    everyTurns: z.number().min(5).max(100).default(20).description('巩固频率（轮）'),
    everyCells: z.number().min(50).max(1000).default(200).description('巩固频率（cell 数）'),
    idleMs: z.number().default(90000).description('空闲触发'),
    schemaMinSupport: z.number().min(2).max(10).default(3).description('抽象门槛：同一规律被独立观察到几次才抽出来'),
    remValenceDecay: z.number().min(0.8).max(1).default(0.92).description('REM 情绪衰减速率'),
    remArousalDecay: z.number().min(0.8).max(1).default(0.94).description('REM 唤起衰减速率'),
    remLinkBudget: z.number().min(0).max(1000).default(200).description('联想边预算'),
  }),
  safety: z.object({
    piiRedaction: z.boolean().default(true).description('编码期脱敏'),
    blockMemoryInEgress: z.boolean().default(true).description('记忆内容禁止出现在外发工具参数里'),
    requireApprovalFor: z.array(z.string()).default(['memory_forget', 'memory_assert']).description('需审批的工具清单'),
  }),
})

/** 测试与 demo 用的完整默认值（schemastery 的 default 只在宿主校验时生效）。 */
export function defaultConfig(overrides: Partial<MnemoConfig> = {}): MnemoConfig {
  return applyPreset({
    dbPath: ':memory:',
    scopeKey: 'user:local',
    residualDir: '',
    sdrDim: 2048,
    sdrK: 8,
    embDim: 256,
    preset: 'balanced',
    maxSlots: 4,
    maxEntriesPerTurn: 8,
    surfaceMode: 'rows',
    maxSurfaceTokens: 320,
    forgettingProfile: 'semantic',
    affectEnabled: true,
    recall: {
      wSim: 1.0,
      wRecency: 0.35,
      wFreq: 0.2,
      wAffect: 0.25,
      wGoal: 0.4,
      wCue: 0.3,
      wInterf: 0.5,
      ignition: 0.42,
      annTopK: 64,
      graphHops: 2,
      graphDecay: 0.6,
    },
    consolidation: {
      everyTurns: 20,
      everyCells: 200,
      idleMs: 90000,
      schemaMinSupport: 3,
      remValenceDecay: 0.92,
      remArousalDecay: 0.94,
      remLinkBudget: 200,
    },
    safety: { piiRedaction: true, blockMemoryInEgress: true, requireApprovalFor: ['memory_forget', 'memory_assert'] },
    ...overrides,
  })
}

export type ConfigShape = MnemoConfig

export function apply(ctx: Context, raw: MnemoConfig) {
  const config = applyPreset(raw)
  const memory = new MemoryService(ctx, {
    config,
    scopeKey: config.scopeKey,
    panelPath: config.residualDir ? `${config.residualDir}/panel-snapshot.json` : undefined,
  })

  ctx.effect(() => {
    const close = memory.open()
    return () => close()
  }, 'mnemo-core: vault')

  ctx.effect(() => {
    const timer = setInterval(() => memory.tick(), 60_000)
    return () => clearInterval(timer)
  }, 'mnemo-core: maintenance tick')

  /**
   * compaction 兼容（§14.8）：把被摘要遮蔽的 seq 写进 shadow_map，
   * memory_expand 才知道"这段原文已经被压缩过了"。
   *
   * 事件名在 rc 间可能调整，因此用宽类型入口 + 运行时校验，
   * 拿不到就静默降级（不订阅比订阅错更安全——错订阅会让展开误判）。
   */
  ctx.effect(() => {
    const on = (ctx as unknown as { on(n: string, f: (...a: unknown[]) => void): () => void }).on
    const off = on.call(ctx, 'compaction/summary', (payload: unknown) => {
      const p = payload as { sessionId?: string; session?: { id?: string }; shadowedSeqs?: number[] } | undefined
      const sid = p?.sessionId ?? p?.session?.id
      const seqs = p?.shadowedSeqs
      if (!sid || !Array.isArray(seqs) || seqs.length === 0) return
      try {
        memory.store.shadowSeqs(sid, seqs.filter((x) => Number.isFinite(x)))
      } catch (err) {
        memory.warn(`shadow_map 写入失败：${String(err)}`)
      }
    })
    return () => off()
  }, 'mnemo-core: compaction shadow map')

  ctx.logger('mnemo-core').info(
    `vault ready (preset=${config.preset}, D=${config.sdrDim}, k=${config.sdrK}, est=${estimateTokensPerTurn(config)} tok/turn)`,
  )
}

export { MemoryService, cellIdFor, slotValue, pq32, deriveLens } from './service.js'
export { applyPreset, PRESETS, EFFECT_MATRIX, REBUILD_KEYS, estimateTokensPerTurn, timingOf, type EffectRow, type EffectTiming } from './preset.js'
export * from './types.js'
export * from './cell.js'
export * from './sdr.js'
export * from './forgetting.js'
export * from './render.js'
export { runRecall, scoreCandidate, formatBreakdown, hashEmbedding, cosine, buildQuerySdr } from './recall.js'
export { createStore, MemoryStore, SqliteStore, type Store } from './store.js'
export * from './text.js'
export { SensoryRing, WorkingSet } from './working.js'
export { compress, decompress, type Codec } from './codec.js'
export { hash64, toHex, digest32, shortId } from './hash.js'
