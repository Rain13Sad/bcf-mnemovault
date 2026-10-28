# @bcf/dsh-mnemo-affect

Affect kernel — appraisal, mood, persona and the user schema.

Part of **MnemoVault** — long-term memory and affect for
[DeepSeek Harness](https://github.com/Rain13Sad/bcf-mnemovault). Sparse-code memory lattice, four-channel recall,
biphasic consolidation, ~116 tokens injected per turn, zero runtime dependencies.

## Install

```bash
npm i @bcf/dsh-mnemo-affect
```

Loaded by the harness as a Cordis plugin — declare it in your plugin list and it applies itself.

## What it does

Scores each turn on valence/arousal/dominance, integrates a slow mood, keeps a
relational state and a persona profile, and turns all of it into a retrieval policy
that biases what gets recalled.

## Exports

- `AffectService`
- `appraise`
- `integrateMood`
- `derivePolicy`
- `deriveUserSchema`
- `clampPersona`

## The family

| Package | Role |
| :--- | :--- |
| `@bcf/dsh-mnemo-core` | Lattice, store, index and renderer — the `ctx.memory` service. |
| `@bcf/dsh-mnemo-affect` | Affect kernel — appraisal, mood, persona and the user schema. |
| `@bcf/dsh-mnemo-encoder` | Write path — turns a finished turn into sparse-code cells. |
| `@bcf/dsh-mnemo-recall` | Read path — four-channel recall and prompt injection. |
| `@bcf/dsh-mnemo-consolidator` | Offline consolidation — NREM, REM and forgetting. |
| `@bcf/dsh-mnemo-proactive` | Companion layer — when the agent may speak first. |
| `@bcf/dsh-mnemo-tools` | Tool surface and `/mnemo` commands. |
| `@bcf/dsh-mnemo-settings` | Settings schema, presets and the effect matrix. |
| `@bcf/dsh-mnemo-devkit` | Host-free runner — mock Cordis context and session replay. |
| `@bcf/dsh-mnemo-ui` | Sidebar panel — memory browser, graph, affect and diagnostics. |

## Links

- Repository and full docs: https://github.com/Rain13Sad/bcf-mnemovault
- 中文说明: https://github.com/Rain13Sad/bcf-mnemovault/blob/main/README.zh-CN.md
- Design notes: https://github.com/Rain13Sad/bcf-mnemovault/blob/main/docs/design/MNEMOVAULT-DESIGN.md

## License

MIT
