/**
 * 生成每个包的 cordis.patch.yml（DSH bundle 用）。
 * 配置文件写在插件行的 config 下，由 schemastery 校验并生成设置表单（§15.3）。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

const patches = {
  core: `# 晶格服务：存储、索引、四路召回、MRS 渲染
- insert:
    - id: mnemo-core
      name: '@rain13sad/dsh-mnemo-core'
      config:
        dbPath: !!js \`\${ctx.baseDir}/mnemo/vault.db\`
        residualDir: !!js \`\${ctx.baseDir}/mnemo/blob\`
        sdrDim: 2048
        sdrK: 8
        embDim: 256
        preset: balanced
        maxSlots: 4
        surfaceMode: rows
        forgettingProfile: semantic
        affectEnabled: true
`,
  affect: `# 情感内核：内感受 → 评价 → PAD → 心境 → 关系模型
- insert:
    - id: mnemo-affect
      name: '@rain13sad/dsh-mnemo-affect'
      config:
        moodTau: 20
        personaDriftEpsilon: 0.25
        negativeWeight: 3
        enabled: true
`,
  encoder: `# 写侧：turn/end 时把本轮对话编码成 0..N 个 MemCell
- insert:
    - id: mnemo-encoder
      name: '@rain13sad/dsh-mnemo-encoder'
      config:
        encodeAssistant: true
        encodeTools: true
        maxCellsPerTurn: 8
        maxResidualBytes: 8192
        l1:
          enabled: false
`,
  recall: `# 读侧：agent/pre-step 门控 + 注入（写 memory/recall）
- insert:
    - id: mnemo-recall
      name: '@rain13sad/dsh-mnemo-recall'
      config:
        enabled: true
        injectOnFirstTurn: true
        topicDriftThreshold: 0.6
        minTurnsBetweenInjections: 1
        budgetGuard: 0.8
        applyTemperature: false
`,
  consolidator: `# 离线巩固：NREM / REM + 按比例降权 + 弱边剪除
- insert:
    - id: mnemo-consolidator
      name: '@rain13sad/dsh-mnemo-consolidator'
      config:
        enabled: true
        gamma: 0.95
        pruneBelow: 8
        pruneAfterDays: 90
        divergenceTemp: 0.7
        maxSeeds: 60
`,
  tools: `# 工具面（6）+ 命令面（/mnemo …）+ egress 守卫
- insert:
    - id: mnemo-tools
      name: '@rain13sad/dsh-mnemo-tools'
      config:
        piiRedaction: true
        blockMemoryInEgress: true
        requireApprovalFor: [memory_forget]
        commandToolFallback: true
`,
  settings: `# 设置面板：预设档、生效矩阵、配置快照
- insert:
    - id: mnemo-settings
      name: '@rain13sad/dsh-mnemo-settings'
      config:
        panelPageSize: 50
        graphMaxNodes: 200
        lockSafetyGroup: true
`,
}

for (const [dir, body] of Object.entries(patches)) {
  writeFileSync(join(root, 'packages', dir, 'cordis.patch.yml'), body, 'utf8')
}
console.log(`wrote ${Object.keys(patches).length} cordis.patch.yml`)
