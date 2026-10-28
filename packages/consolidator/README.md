# @rain13sad/dsh-mnemo-consolidator

Offline consolidation — NREM, REM and forgetting.

Part of **MnemoVault** — long-term memory and affect for
[DeepSeek Harness](https://github.com/Rain13Sad/bcf-mnemovault). Sparse-code memory lattice, four-channel recall,
biphasic consolidation, ~116 tokens injected per turn, zero runtime dependencies.

## Install

```bash
npm i @rain13sad/dsh-mnemo-consolidator
```

Loaded by the harness as a Cordis plugin — declare it in your plugin list and it applies itself.

## What it does

Replays recent cells, merges duplicates, promotes what keeps coming back, decays what
does not, and writes the result back as a new generation of the lattice.

## Exports

- `Consolidator`
- `derivePassId`
- `PassResult`

## The family

| Package | Role |
| :--- | :--- |
| `@rain13sad/dsh-mnemo-core` | Lattice, store, index and renderer — the `ctx.memory` service. |
| `@rain13sad/dsh-mnemo-affect` | Affect kernel — appraisal, mood, persona and the user schema. |
| `@rain13sad/dsh-mnemo-encoder` | Write path — turns a finished turn into sparse-code cells. |
| `@rain13sad/dsh-mnemo-recall` | Read path — four-channel recall and prompt injection. |
| `@rain13sad/dsh-mnemo-consolidator` | Offline consolidation — NREM, REM and forgetting. |
| `@rain13sad/dsh-mnemo-proactive` | Companion layer — when the agent may speak first. |
| `@rain13sad/dsh-mnemo-tools` | Tool surface and `/mnemo` commands. |
| `@rain13sad/dsh-mnemo-settings` | Settings schema, presets and the effect matrix. |
| `@rain13sad/dsh-mnemo-devkit` | Host-free runner — mock Cordis context and session replay. |
| `@rain13sad/dsh-mnemo-ui` | Sidebar panel — memory browser, graph, affect and diagnostics. |

## Links

- Repository and full docs: https://github.com/Rain13Sad/bcf-mnemovault
- 中文说明: https://github.com/Rain13Sad/bcf-mnemovault/blob/main/README.zh-CN.md
- Design notes: https://github.com/Rain13Sad/bcf-mnemovault/blob/main/docs/design/MNEMOVAULT-DESIGN.md

## License

MIT
