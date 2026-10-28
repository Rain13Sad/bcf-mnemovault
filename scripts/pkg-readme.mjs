/**
 * 生成每个子包自己的 README（npm 包页只认包内那份）。
 *
 * npm 包页面只认包内的 README，仓库根目录那份不会带过去；
 * 没有 README 的包页看起来像"没写完"。这里按一张表统一生成，
 * 以后加包只要往 PACKAGES 里补一行。
 *
 *   node scripts/pkg-readme.mjs          写入
 *   node scripts/pkg-readme.mjs --check  只检查是否过期（CI 用）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'https://github.com/Rain13Sad/bcf-mnemovault'
const check = process.argv.includes('--check')
const root = process.cwd()

/** @type {{dir:string, tagline:string, body:string, exports:string[]}[]} */
const PACKAGES = [
  {
    dir: 'core',
    tagline: 'Lattice, store, index and renderer — the `ctx.memory` service.',
    body: [
      'Owns the SQLite store, the sparse-code cell format, the four-channel index and the',
      'prompt renderer. Every other package talks to the vault through this one.',
    ],
    exports: ['MemoryService', 'encodeCell / decodeCell', 'SdrSpace', 'SensoryRing', 'WorkingSet', 'defaultConfig', 'PRESETS'],
  },
  {
    dir: 'affect',
    tagline: 'Affect kernel — appraisal, mood, persona and the user schema.',
    body: [
      'Scores each turn on valence/arousal/dominance, integrates a slow mood, keeps a',
      'relational state and a persona profile, and turns all of it into a retrieval policy',
      'that biases what gets recalled.',
    ],
    exports: ['AffectService', 'appraise', 'integrateMood', 'derivePolicy', 'deriveUserSchema', 'clampPersona'],
  },
  {
    dir: 'encoder',
    tagline: 'Write path — turns a finished turn into sparse-code cells.',
    body: [
      'Subscribes to `session/event`, extracts facts / preferences / events / affect from the',
      'turn, fills the 4.1-slot layout and writes cells into the vault with provenance.',
    ],
    exports: ['Encoder', 'fillSlots', 'PROVENANCE_LABEL'],
  },
  {
    dir: 'recall',
    tagline: 'Read path — four-channel recall and prompt injection.',
    body: [
      'Hooks `agent/pre-step`, decides whether this turn deserves an injection, runs the',
      'four channels (sparse / lexical / temporal / affect), dedupes and renders a compact',
      'block at a fixed position in the message list.',
    ],
    exports: ['shouldInject', 'buildInjectionMessage', 'insertAt', 'lastUserText'],
  },
  {
    dir: 'consolidator',
    tagline: 'Offline consolidation — NREM, REM and forgetting.',
    body: [
      'Replays recent cells, merges duplicates, promotes what keeps coming back, decays what',
      'does not, and writes the result back as a new generation of the lattice.',
    ],
    exports: ['Consolidator', 'derivePassId', 'PassResult'],
  },
  {
    dir: 'proactive',
    tagline: 'Companion layer — when the agent may speak first.',
    body: [
      'Produces candidate openers (emotion, milestone, association, memory, silence) and a',
      'tick that decides whether any of them is worth interrupting for, with mute windows.',
    ],
    exports: ['ProactiveService', 'ProactiveCandidate', 'ProactiveState'],
  },
  {
    dir: 'tools',
    tagline: 'Tool surface and `/mnemo` commands.',
    body: [
      'Six model-callable tools (search, remember, forget, stats, timeline, affect) plus the',
      '`/mnemo` command family, and an egress guard that keeps vault content off the wire.',
    ],
    exports: ['runCommand', 'isEgressTool', 'buildGuard'],
  },
  {
    dir: 'settings',
    tagline: 'Settings schema, presets and the effect matrix.',
    body: [
      'Describes every knob with type, default, range and cost, exposes presets, and answers',
      '"what changes if I turn this on" as data the panel can render.',
    ],
    exports: ['MnemoSettingsService', 'PRESETS', 'EFFECT_MATRIX', 'estimateTokensPerTurn'],
  },
  {
    dir: 'devkit',
    tagline: 'Host-free runner — mock Cordis context and session replay.',
    body: [
      'Boots a real Cordis fiber without DSH, replays scripted sessions, and returns what was',
      'injected per turn. Used by the demo, the tests and the benchmark.',
    ],
    exports: ['createHarness', 'Harness', 'InjectedMessage'],
  },
  {
    dir: 'ui',
    tagline: 'Sidebar panel — memory browser, graph, affect and diagnostics.',
    body: [
      'Client-side React panel registered on `sidebar.panellist`: browse cells, inspect the',
      'graph, read the affect timeline, watch token cost per turn.',
    ],
    exports: ['MnemoPanel', 'PANEL_ID', 'clientEntry'],
  },
]

const family = PACKAGES.map((p) => `| \`@bcf/dsh-mnemo-${p.dir}\` | ${p.tagline.replace(/\|/g, '\\|')} |`).join('\n')

const render = (p) => {
  const name = `@bcf/dsh-mnemo-${p.dir}`
  const isClient = p.dir === 'ui'
  return `# ${name}

${p.tagline}

Part of **MnemoVault** — long-term memory and affect for
[DeepSeek Harness](${REPO}). Sparse-code memory lattice, four-channel recall,
biphasic consolidation, ~116 tokens injected per turn, zero runtime dependencies.

## Install

\`\`\`bash
npm i ${name}
\`\`\`

${isClient ? 'Registers itself on the `sidebar.panellist` slot; no manual wiring needed.' : 'Loaded by the harness as a Cordis plugin — declare it in your plugin list and it applies itself.'}

## What it does

${p.body.join('\n')}

## Exports

${p.exports.map((e) => `- \`${e}\``).join('\n')}

## The family

| Package | Role |
| :--- | :--- |
${family}

## Links

- Repository and full docs: ${REPO}
- 中文说明: ${REPO}/blob/main/README.zh-CN.md
- Design notes: ${REPO}/blob/main/docs/design/MNEMOVAULT-DESIGN.md

## License

MIT
`
}

let stale = 0
for (const p of PACKAGES) {
  const file = join(root, 'packages', p.dir, 'README.md')
  const next = render(p)
  if (check) {
    const prev = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (prev !== next) {
      console.error(`stale: packages/${p.dir}/README.md`)
      stale++
    }
    continue
  }
  writeFileSync(file, next)
  console.log(`wrote packages/${p.dir}/README.md`)
}

if (check && stale) {
  console.error(`${stale} package README(s) out of date — run: node scripts/pkg-readme.mjs`)
  process.exit(1)
}
