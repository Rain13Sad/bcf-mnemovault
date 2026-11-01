# @rain13sad/llm-mnemo-affect

Affect kernel — appraisal, mood, persona and the user schema.

Part of **MnemoVault** — an emotion-aware memory engine for LLMs
([repo](https://github.com/Rain13Sad/bcf-mnemovault)). Sparse-code memory lattice, four-channel recall, biphasic consolidation,
~117 tokens injected per turn, zero runtime dependencies. Runs standalone through
`EmotionMemoryEngine`, or as a plugin inside DeepSeek Harness.

## Install

```bash
npm i @rain13sad/llm-mnemo-affect
```

Inside DeepSeek Harness it loads as a Cordis plugin — declare it in your plugin list and it applies itself. Standalone, import it directly.

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
| `@rain13sad/llm-mnemo-core` | Lattice, store, index and renderer — the `ctx.memory` service. |
| `@rain13sad/llm-mnemo-llm` | LLM adapters — embedding / extraction / tokenizer ports for common models. |
| `@rain13sad/llm-mnemo-affect` | Affect kernel — appraisal, mood, persona and the user schema. |
| `@rain13sad/llm-mnemo-encoder` | Write path — turns a finished turn into sparse-code cells. |
| `@rain13sad/llm-mnemo-recall` | Read path — four-channel recall and prompt injection. |
| `@rain13sad/llm-mnemo-consolidator` | Offline consolidation — NREM, REM and forgetting. |
| `@rain13sad/llm-mnemo-proactive` | Companion layer — when the agent may speak first. |
| `@rain13sad/llm-mnemo-tools` | Tool surface and `/mnemo` commands. |
| `@rain13sad/llm-mnemo-settings` | Settings schema, presets and the effect matrix. |
| `@rain13sad/llm-mnemo-devkit` | Host-free runner — mock Cordis context and session replay. |
| `@rain13sad/llm-mnemo-ui` | Sidebar panel — memory browser, graph, affect and diagnostics. |

## Links

- Repository and full docs: https://github.com/Rain13Sad/bcf-mnemovault
- 中文说明: https://github.com/Rain13Sad/bcf-mnemovault/blob/main/README.zh-CN.md
- Design notes: https://github.com/Rain13Sad/bcf-mnemovault/blob/main/docs/design/MNEMOVAULT-DESIGN.md

## License

MIT
