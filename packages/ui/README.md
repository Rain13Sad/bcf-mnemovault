# @bcf/dsh-mnemo-ui

Sidebar panel — memory browser, graph, affect and diagnostics.

Part of **MnemoVault** — long-term memory and affect for
[DeepSeek Harness](https://github.com/Rain13Sad/bcf-mnemovault). Sparse-code memory lattice, four-channel recall,
biphasic consolidation, ~116 tokens injected per turn, zero runtime dependencies.

## Install

```bash
npm i @bcf/dsh-mnemo-ui
```

Registers itself on the `sidebar.panellist` slot; no manual wiring needed.

## What it does

Client-side React panel registered on `sidebar.panellist`: browse cells, inspect the
graph, read the affect timeline, watch token cost per turn.

## Exports

- `MnemoPanel`
- `PANEL_ID`
- `clientEntry`

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
