/**
 * @rain13sad/llm-mnemo-core —— 插件入口（§15.4）
 *
 * 配置直接写在插件行的 `config` 下，由 schemastery 校验并生成设置表单。
 * 不手写 UI 表单：这是"可操作性"的最低成本实现，也是唯一不会随 DSH 升级而失效的实现（§12.2）。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyPreset, PRESETS, EFFECT_MATRIX, estimateTokensPerTurn } from './preset.js'
import { MemoryService } from './service.js'
import { baseUrlOf, resolveVaultPath } from './paths.js'
import type { EnginePorts } from './ports.js'
import { RuntimeStatus } from './runtime.js'
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
  scopeKey: z.string().default('auto').description("作用域键。'auto' = 从 userId 推导；显式字符串 = 固定域；多用户部署请传 userId"),
  residualDir: z.string().default('~/.dsh/mnemo/blob').description('残差存储目录'),
  sdrDim: z
    .union([z.const(1024), z.const(2048), z.const(4096)])
    .default(2048)
    .description('SDR 维度。改后必须 /mnemo rebuild（容量与噪声底的折中，§6.5）'),
  sdrK: z.number().min(4).max(16).default(8).description('激活位数。k/D 决定噪声底，改后必须重建'),
  embDim: z.number().min(64).max(1024).default(256).description('计算用语义向量维度。改后必须重建'),
  embStoreDim: z
    .number()
    .min(32)
    .max(256)
    .default(64)
    .description('落盘向量维度（MC03）。每条 cell 的向量字节数，64 维 = 64 B；改后必须重建'),
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
    annEnabled: z.boolean().default(true).description('启用 HNSW 索引（cell 数低于阈值时仍走精确扫描）'),
    annThreshold: z
      .number()
      .min(200)
      .max(200_000)
      .default(20_000)
      .description('触发 ANN 的最小 cell 数。v0.6 从 2000 提到 2 万：实测 1 万条时精确扫描 4 ms、HNSW 37 ms'),
    annM: z.number().min(4).max(64).default(16).description('HNSW 每层最大邻居数'),
    annEf: z.number().min(8).max(400).default(64).description('HNSW 查询宽度。↑ 更准更慢'),
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
  /**
   * v0.7.0：安全边界。默认值全部取安全侧——放宽必须由部署方显式做出。
   * 这一段直接对应独立审计的四条红线（隔离/删除/危机/未成年）。
   */
  security: z
    .object({
      allowScopeOverride: z.boolean().default(false).description('允许查询参数覆盖作用域（默认关：隔离只能由服务端推导）'),
      allowGlobalScope: z.boolean().default(false).description("允许 scope='global' 跨域全库检索（宿主/用户权限，不是模型权限）"),
      sessionIsolateSemantic: z.boolean().default(false).description('语义记忆也按会话隔离（多租户无法保证 per-user scopeKey 时开启）'),
      scopeMode: z
        .union([z.const('auto'), z.const('shared'), z.const('per-user'), z.const('per-session')])
        .default('auto')
        .description("作用域推导模式。多租户无身份层时设 'per-session'：一键做到'至少不跨会话泄漏'"),
      blockInstructionRendering: z.boolean().default(true).description('指令形态文本默认不进 MRS 渲染（仍可检索）'),
      crisisEnabled: z.boolean().default(true).description('危机识别与转介。关掉它必须写进部署文档'),
      crisisReferral: z.string().default('').description('转介文案覆盖（中国大陆以外部署必须改）。空 = 用内置默认'),
      minorGuardEnabled: z.boolean().default(true).description('未成年人保护：更短保留 + 关闭陪伴层'),
      purgeRequiresConfirm: z.boolean().default(true).description('级联删除必须带 confirm 令牌'),
    })
    .default({}),
  index: z
    .object({
      sdrEnabled: z.boolean().default(true).description('SDR 倒排索引（超预算自动退化并上报）'),
      sdrMaxCells: z.number().min(1000).default(200_000).description('索引容量上限，超过退回全扫'),
      demoteBatch: z.number().min(1).default(2000).description('单次降档 pass 最多评估的条数'),
      retentionTtlMs: z.number().min(60_000).default(6 * 3600_000).description('保留度缓存有效期'),
      idfEnabled: z.boolean().default(true).description('查询侧 IDF 剪枝：剔除无区分力的高频 token（不改落盘向量）'),
      idfMinDocs: z.number().min(1).default(30).description('低于这么多条记忆时不做剪枝（统计量不足）'),
      idfMaxDfRatio: z.number().min(0.1).max(1).default(0.6).description('df/docs 超过此比例视为无区分力'),
    })
    .default({}),
  /**
   * v0.6：LLM 适配。
   *
   * 两个开关默认**关**：真 embedding 与 LLM 抽取都会打破"零依赖、离线可跑"的承诺。
   * 打开之后能力变强、依赖变重，这个交换必须由用户显式做出，
   * 而不是由我们在升级时替他决定。
   */
  llm: z
    .object({
      model: z.string().default('deepseek-chat').description('主对话模型 id（决定 tokenizer / 预算 / 价格闸）'),
      provider: z.string().default('deepseek').description('provider 预设：deepseek / openai / anthropic / google / ollama / openai-compatible'),
      baseUrl: z.string().default('').description('自定义端点（代理 / 兼容端点 / 本地 ollama）。空 = 用预设'),
      apiKeyEnv: z.string().default('DEEPSEEK_API_KEY').description('密钥所在的环境变量名。密钥本身不写进配置'),
      timeoutMs: z.number().min(1000).max(120_000).default(15_000).description('单次调用超时；超时即降级，不阻塞对话'),
      retries: z.number().min(0).max(3).default(1).description('幂等请求的重试次数'),
      embeddingEnabled: z.boolean().default(false).description('启用真 embedding。关着走本地哈希（零依赖）'),
      embeddingModel: z.string().default('').description('embedding 模型 id；空 = 用 provider 默认'),
      extractEnabled: z.boolean().default(false).description('启用 LLM 抽取。关着走规则抽取（零依赖）'),
      maxPricePerTurn: z.number().min(0).default(0).description('单轮记忆注入价格上限（元）；0 = 不限'),
    })
    .default({}),
})

/**
 * 默认值只有一个来源：schema（v0.6 · 修 D5）。
 *
 * v0.5.3 之前这里是一张手写的第二份表，而 `embStoreDim` 在两张表里分别是 128 与 64，
 * 且**它参与布局键**。后果不是"数字不一致"这么轻：照着 README 写
 * `new MemoryService({ config: defaultConfig({ dbPath }) })` 的人，打开宿主建的库会被
 * 布局键挡住，错误信息还让他去 rebuild——一次本不该发生的数据迁移。
 *
 * 现在 `defaultConfig()` 以 `Config.parse({})` 为底，只覆盖"测试专用"的两个差异
 * （内存库、无残差目录）。`test/v06-config-defaults.test.mjs` 守着这条不变量：
 * 四个参与布局键的字段，`defaultConfig()` 与 `Config.parse({})` 必须逐字段相等。
 */
function schemaDefaults(): MnemoConfig {
  // schemastery 的 schema 实例本身可调用：Config({}) 走一遍校验并补全所有 default
  const parsed = Config({}) as MnemoConfig
  return parsed
}

/** 测试与 demo 用的完整默认值（schemastery 的 default 只在宿主校验时生效）。 */
export function defaultConfig(overrides: Partial<MnemoConfig> = {}): MnemoConfig {
  return applyPreset({
    ...schemaDefaults(),
    dbPath: ':memory:',
    residualDir: '',
    ...overrides,
  })
}

/** 真实部署的默认值（宿主未提供配置时用）。与 schema 同源，只换库路径。 */
export function productionConfig(overrides: Partial<MnemoConfig> = {}): MnemoConfig {
  return applyPreset({ ...schemaDefaults(), ...overrides })
}

export type ConfigShape = MnemoConfig

export function apply(ctx: Context, raw: MnemoConfig) {
  /**
   * 路径在**这里**解析，不在 patch 里（v0.6 保留 v0.5.3 的修复）。
   *
   * 两个各自致命的问题：`!!js` 标签在安装期解析不了（整个安装被回滚），
   * `ctx.baseDir` 根本不存在（Loader 上叫 `baseUrl`）。所以 patch 只写字面量，
   * 需要宿主上下文的默认值一律在这里解析。详见 `paths.ts` 顶部注释。
   */
  const baseUrl = baseUrlOf(ctx)
  const config = applyPreset({ ...productionConfig(), ...raw })
  config.dbPath = resolveVaultPath(config.dbPath, baseUrl)
  config.residualDir = resolveVaultPath(config.residualDir, baseUrl)
  const runtime = new RuntimeStatus()
  // 登记处本身也是一个服务：encoder（L1 状态）与 tools（命令面/remote/工具清单）
  // 都往这里写，面板与 doctor 从 memory.panelSnapshot() 读同一份。
  try {
    ctx.provide('mnemoRuntime', runtime)
  } catch {
    /* 已存在（热重载）就复用旧的 */
  }
  /**
   * 端口（v0.6）：由 llm 包 `ctx.provide('mnemoPorts', …)` 提供。
   * 它可能比 core 晚激活——所以这里只取一次引用，之后的替换走 `memory.usePorts()`。
   * 取不到就是空端口集合：哈希 + 规则 + 启发式计数，一切照常工作。
   */
  const ports = ctx.get('mnemoPorts') as EnginePorts | undefined
  const memory = new MemoryService(ctx, {
    config,
    scopeKey: config.scopeKey,
    panelPath: config.residualDir ? `${config.residualDir}/panel-snapshot.json` : undefined,
    runtime,
    ports,
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

export { MemoryService, cellIdFor, slotValue, pq32, deriveLens, buildTags, buildCategories, tuningValues, expandDotted } from './service.js'
export { RuntimeStatus, type L1Status, type CommandFace, type L1Mode } from './runtime.js'
export { expandHome, resolveVaultPath, baseUrlOf } from './paths.js'
export { applyPreset, PRESETS, EFFECT_MATRIX, REBUILD_KEYS, estimateTokensPerTurn, timingOf, type EffectRow, type EffectTiming, type PresetName } from './preset.js'
export * from './types.js'
export * from './cell.js'
export * from './sdr.js'
export * from './forgetting.js'
export * from './decay.js'
export * from './retention.js'
export * from './inverted.js'
export * from './ports.js'
export * from './emotion.js'
export * from './vault-tools.js'
export * from './compiler.js'
export * from './starmap.js'
export * from './engine.js'
export * from './emb.js'
export * from './reconsolidation.js'
export * from './neuromod.js'
export * from './lifecycle.js'
export * from './render.js'
export { runRecall, scoreCandidate, formatBreakdown, hashEmbedding, cosine, buildQuerySdr, pruneQueryEntities, canonicalToken, quantize, TopK } from './recall.js'
export { HnswIndex, BruteIndex, type VectorIndex, type VectorHit } from './ann.js'
export { createStore, MemoryStore, SqliteStore, type Store } from './store.js'
export * from './text.js'
// v0.7.0：安全边界与危机干预（红线 1/2/3/7）
export {
  resolveScopeKey,
  stripScopeArgs,
  looksLikeInstruction,
  isSensitive,
  SCOPE_ARG_KEYS,
  type ScopeMode,
  type ScopeResolution,
  type InstructionSignal,
} from './security.js'
export {
  assessCrisis,
  detectMinor,
  DEFAULT_REFERRAL,
  CRISIS_DISCLAIMER,
  MINOR_POLICY,
  type CrisisLevel,
  type CrisisCategory,
  type CrisisAssessment,
  type MinorSignal,
} from './crisis.js'
export { SensoryRing, WorkingSet } from './working.js'
export { compress, decompress, type Codec } from './codec.js'
export { hash64, toHex, digest32, shortId } from './hash.js'
