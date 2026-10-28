import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const root = process.cwd()

/** 包族定义（§14.2）。依赖只写包内真正 import 的，避免 Cordis inject 之外的隐式耦合。 */
const packages = [
  {
    dir: 'core',
    name: '@rain13sad/dsh-mnemo-core',
    description: '服务定义 + 存储 + 索引 + 渲染（ctx.memory）',
    inject: ['storage', 'sessions'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools'],
  },
  {
    dir: 'affect',
    name: '@rain13sad/dsh-mnemo-affect',
    description: '情感内核：内感受 / 评价 / PAD / 心境 / 关系模型（ctx.affect）',
    inject: ['memory', 'sessions'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'],
    internal: ['@rain13sad/dsh-mnemo-core'],
  },
  {
    dir: 'encoder',
    name: '@rain13sad/dsh-mnemo-encoder',
    description: '写侧：订阅 session/event，产出 MemCell',
    inject: ['memory', 'sessions', 'affect'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'],
    internal: ['@rain13sad/dsh-mnemo-core', '@rain13sad/dsh-mnemo-affect'],
  },
  {
    dir: 'recall',
    name: '@rain13sad/dsh-mnemo-recall',
    description: '读侧：agent/pre-step 四路召回 + 4±1 槽位注入',
    inject: ['memory', 'sessions'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'],
    internal: ['@rain13sad/dsh-mnemo-core', '@rain13sad/dsh-mnemo-affect'],
  },
  {
    dir: 'consolidator',
    name: '@rain13sad/dsh-mnemo-consolidator',
    description: '离线巩固：NREM / REM pass + 锁 + 遗忘',
    inject: ['memory', 'sessions'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'],
    internal: ['@rain13sad/dsh-mnemo-core', '@rain13sad/dsh-mnemo-affect'],
  },
  {
    dir: 'tools',
    name: '@rain13sad/dsh-mnemo-tools',
    description: '工具面（6）+ 命令面（13）+ egress 守卫',
    inject: ['memory', 'tools', 'cmdline', 'sessions'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-session'],
    internal: ['@rain13sad/dsh-mnemo-core', '@rain13sad/dsh-mnemo-affect'],
  },
  {
    dir: 'proactive',
    name: '@rain13sad/dsh-mnemo-proactive',
    description: '主动开口：情感/记忆由头 + 频率与静默预算',
    inject: ['memory', 'sessions'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-session'],
    internal: ['@rain13sad/dsh-mnemo-core'],
  },
  {
    dir: 'settings',
    name: '@rain13sad/dsh-mnemo-settings',
    description: '设置面板 schema + 预设档 + 生效矩阵（ctx.mnemoSettings）',
    inject: ['memory'],
    deps: { '@deepseek-ai/schemastery': '^3.18.5' },
    peers: ['@deepseek-ai/cordis'],
    internal: ['@rain13sad/dsh-mnemo-core'],
  },
  {
    dir: 'ui',
    name: '@rain13sad/dsh-mnemo-ui',
    description: '侧栏面板（client 侧）：记忆浏览器 / 图谱 / 情感 / 诊断',
    client: true,
    clientInject: [
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-renderer',
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-sidebar',
      '@deepseek-ai/dsh-client-ui-layout',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-api-remotes',
    ],
    peers: ['@deepseek-ai/cordis', 'react'],
  },
  {
    dir: 'devkit',
    name: '@rain13sad/dsh-mnemo-devkit',
    description: '无宿主运行器：mock Cordis ctx + 会话回放，用于 demo / 测试',
    inject: [],
    peers: [],
    internal: [
      '@rain13sad/dsh-mnemo-core',
      '@rain13sad/dsh-mnemo-affect',
      '@rain13sad/dsh-mnemo-encoder',
      '@rain13sad/dsh-mnemo-recall',
      '@rain13sad/dsh-mnemo-consolidator',
      '@rain13sad/dsh-mnemo-tools',
      '@rain13sad/dsh-mnemo-settings',
    ],
  },
]

for (const p of packages) {
  const dir = join(root, 'packages', p.dir)
  mkdirSync(dir, { recursive: true })
  const pkg = {
    name: p.name,
    version: '0.2.0',
    description: p.description,
    type: 'module',
    main: './lib/index.js',
    types: './lib/types/index.d.ts',
    exports: p.client
      ? {
          '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
          './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
          './package.json': './package.json',
        }
      : { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' }, './package.json': './package.json' },
    files: ['lib', 'cordis.patch.yml', 'README.md'],
    engines: { dsh: '>=0.2.1-rc.3 <0.3.0' },
    dsh: p.client
      ? { client: { inject: p.clientInject, platform: 'web' } }
      : { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: Object.fromEntries((p.peers ?? []).map((n) => [n, '*'])),
    dependencies: { ...(p.deps ?? {}), ...Object.fromEntries((p.internal ?? []).map((n) => [n, '*'])) },
    license: 'MIT',
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  const tsconfig = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      outDir: 'lib',
      rootDir: 'src',
      declarationDir: 'lib/types',
      composite: false,
      ...(p.client ? { jsx: 'react-jsx', lib: ['ES2022', 'DOM', 'DOM.Iterable'] } : {}),
    },
    include: ['src/**/*.ts', ...(p.client ? ['src/**/*.tsx'] : [])],
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2) + '\n')
}

console.log(`scaffolded ${packages.length} packages`)
