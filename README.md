<div align="center">
  <img src="docs/assets/banner.svg" alt="MnemoVault — long-term memory and affect for DeepSeek Harness" width="100%">
</div>

<div align="center">

**Long-term memory and affect for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh).**
Memories are stored as fixed-size cells — sparse codes, int8 vectors, typed hyperedges, compressed
residuals — not as text. Injection renders **~116 tokens per turn** instead of replaying the transcript.

[![CI](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml/badge.svg)](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@bcf/dsh-mnemo-core.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@bcf/dsh-mnemo-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](#requirements)
[![Tests](https://img.shields.io/badge/tests-93-brightgreen.svg)](test/)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.3-4b6bfb.svg)](docs/API-CONTRACT.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](CONTRIBUTING.md)

**English** · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md)

</div>

> Memory should not be text. Text is a projection for humans, not a storage format for machines.
>
> This README is the English summary. The **Chinese documentation is canonical** — it is where the
> design rationale, the 15 known weaknesses and the measured numbers live.

| | |
| :--- | :--- |
| **Status** | v0.2.0 · Developer Preview. Baseline DSH `0.2.1-rc.3` (`next` channel); the host itself still ships breaking changes |
| **Size** | 10 packages · 42 source files / 11,215 lines of TS · 93 tests · **zero runtime dependencies** (only built-in `node:sqlite` and `node:zlib`) |
| **Start here** | Maintaining it → [Project guide](docs/PROJECT-GUIDE.md) (in Chinese)<br>Hacking on it → [CONTRIBUTING](CONTRIBUTING.md)　Design rationale → [design doc v0.2](docs/design/MNEMOVAULT-DESIGN.md)<br>All docs → [docs/README.md](docs/README.md) |

---

## Table of contents

- [Why this exists](#why-this-exists) · [What it is not](#what-it-is-not) · [Data flow](#data-flow)
- [Quick start](#quick-start) · [Benchmarks](#benchmarks) · [Packages](#packages)
- [Sidebar panel](#sidebar-panel) · [Known limitations](#known-limitations)
- [Documentation](#documentation) · [Contributing](#contributing) · [License](#license)

---

## Why this exists

A context window is finite, and "what the user told you three months ago" either does not fit or is too
expensive to keep. The usual answer is to summarise the conversation into text and retrieve it — but
summaries are **lossy and irreproducible**: two runs over the same dialogue differ, and once you
summarise, the original is gone.

This project takes a different route:

1. **Write side** splits utterances into propositions and encodes each into a fixed-size cell:
   sparse code (identity) + int8 vector (semantics) + typed hyperedges (relations) + event/invalid
   timestamps (bi-temporal) + affect reading + version chain. The original bytes are kept separately
   as a brotli residual and can always be recovered.
2. **Read side** runs four retrieval channels (semantic / identity / graph / temporal), merges their
   scores, and lets a 4±1 slot competition decide what gets injected — rendered as table rows.
3. **Offline** consolidation is sleep-like and biphasic: NREM abstracts schemas, REM grows associations,
   a power-law forgetting curve demotes cells.
4. **Affect is a parameter, not a script**: appraisal → PAD → mood → relationship → persona anchor,
   all persisted as ordinary cells — evolvable and rollback-able.

## What it is not

- **Not a RAG replacement.** It retrieves memories *about a person*, not documents.
- **No claim of phenomenal consciousness.** Every affect output is a projection of state variables;
  `affect_report` returns numbers and ships its own disclaimer.
- **Not a turnkey product.** It needs a DSH host, and DSH is still in Developer Preview
  (supported range: `>=0.2.1-rc.3 <0.3.0`).
- **Extraction quality is rule-bound.** The L1 (model-based) port exists but only the rule-enhanced
  path runs today. A stated weakness, not a hidden one.

## Data flow

<div align="center">
  <img src="docs/assets/pipeline.svg" alt="Write side, read side and offline consolidation" width="100%">
</div>

The lattice is derived state: it can be rebuilt by replaying `session_log`, and any recall can be
replayed byte-for-byte from its snapshot.

---

## Quick start

<a id="requirements"></a>
**Requirements:** Node ≥ 22.5 (built-in `node:sqlite` / `node:zlib`) and npm ≥ 10.
**Running the tests does not require DSH.**

```bash
npm ci               # devDependencies only (typescript / react / types)
npm run build        # compiles the 10 packages in dependency order (plain tsc, no bundler)
npm test             # 93 tests
npm run demo         # 26-turn Chinese dialogue: injection / consolidation / stats / egress guard
npm run bench:eval   # mnemo-bench: Recall@8 / MRR / dedupe P,R / temporal reasoning / token cost
npm run panel        # sidebar panel preview at http://127.0.0.1:5178/
npm run verify       # all of the above in one shot (this is what CI runs)
```

### Installing into DSH

Published on npm as `@bcf/*` (public). Install the slice you want — the packages are independent,
so memory without affect is `core + encoder + recall + tools`:

```bash
npm i @bcf/dsh-mnemo-core @bcf/dsh-mnemo-encoder @bcf/dsh-mnemo-recall @bcf/dsh-mnemo-tools
npm i @bcf/dsh-mnemo-affect @bcf/dsh-mnemo-consolidator @bcf/dsh-mnemo-proactive   # optional layers
npm i @bcf/dsh-mnemo-ui @bcf/dsh-mnemo-settings                                    # panel + settings
```

Then insert the plugins into your DSH profile using each package's `cordis.patch.yml`
(plugin id, package name, default config). The actual shape of the host-side seams — and where it
differs from the design doc — is recorded in [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md).

<details>
<summary>Working from source instead</summary>

```bash
git clone https://github.com/Rain13Sad/bcf-mnemovault.git
cd bcf-mnemovault
npm ci && npm run build
```

</details>

---

## Benchmarks

Measured on Node 22.22 / Windows; reproducible from `artifacts/bench.json` (`npm run bench:eval`).

| Metric | Measured | Target | Note |
| :--- | ---: | :--- | :--- |
| Recall@8 | **0.941** | ≥ 0.80 | 34 synthetic facts with ground truth |
| MRR | **0.686** | ≥ 0.65 | same |
| Dedupe precision | **0.90** | ≥ 0.90 | restating a fact should merge |
| Dedupe recall | **1.00** | — | same topic, different value should not merge |
| Temporal reasoning | **1.00** | ≥ 0.75 | `pnpm → npm → bun` across three versions |
| tokens / turn | **116.0** | ≤ 240 | legend amortised |
| Recall p95 | **30 ms** | ≤ 40 ms @1M | 100 cells locally, not a million |
| Storage ratio (short propositions) | 24.1× | ≤ 0.60 | **known miss — see below** |
| Storage ratio (800-char turn) | 2.50× | ≤ 0.60 | same |

CI turns these into failing assertions via [`scripts/ci-assert-bench.mjs`](scripts/ci-assert-bench.mjs)
(Recall@8 ≥ 0.80 / MRR ≥ 0.60 / tokens ≤ 240). The storage ratio is a known miss and is only printed,
never gated — a CI that stays red stops being read.

<details>
<summary><b>Why the storage ratio misses, and what would fix it</b></summary>

Every cell has a fixed base of 192 B (header) + 256 B (sparse code) + 256 B (vector) = **704 B**,
plus a brotli residual of roughly `0.42 × raw`. So `ratio ≈ (nCells × 750 + 0.42 × L) / L`.
The design estimate assumed *one cell per turn*; the encoder splits per **proposition** (which is what
the design asks for), so a turn yields 2–4 cells and the fixed base is amplified 2–4×.

That is a gap in the design doc, not an implementation bug. Mitigations, none implemented yet:
coarser splitting (`maxCellsPerTurn`), product quantisation in the cold tier (256 → 32 B),
moving the embedding from proposition cells to turn level.

</details>

---

## Packages

| Package | Role | Key exports |
| :--- | :--- | :--- |
| [`@bcf/dsh-mnemo-core`](https://www.npmjs.com/package/@bcf/dsh-mnemo-core) | lattice + storage + recall + rendering | `ctx.memory`, `SdrSpace`, `encodeCell`, `SensoryRing`, `WorkingSet` |
| [`@bcf/dsh-mnemo-affect`](https://www.npmjs.com/package/@bcf/dsh-mnemo-affect) | affect kernel | `ctx.affect`, `appraise`, `derivePolicy`, `deriveUserSchema` |
| [`@bcf/dsh-mnemo-encoder`](https://www.npmjs.com/package/@bcf/dsh-mnemo-encoder) | write side | `Encoder` (subscribes to `session/event`) |
| [`@bcf/dsh-mnemo-recall`](https://www.npmjs.com/package/@bcf/dsh-mnemo-recall) | read side | `agent/pre-step` gating and injection |
| [`@bcf/dsh-mnemo-consolidator`](https://www.npmjs.com/package/@bcf/dsh-mnemo-consolidator) | offline consolidation | `Consolidator` (NREM / REM / forgetting) |
| [`@bcf/dsh-mnemo-tools`](https://www.npmjs.com/package/@bcf/dsh-mnemo-tools) | tools + commands | 6 tools, 15 `/mnemo` subcommands, egress guard |
| [`@bcf/dsh-mnemo-proactive`](https://www.npmjs.com/package/@bcf/dsh-mnemo-proactive) | **speaking up first** | `ctx.mnemoProactive`, `candidate()`, `tick()` |
| [`@bcf/dsh-mnemo-settings`](https://www.npmjs.com/package/@bcf/dsh-mnemo-settings) | settings panel | `ctx.mnemoSettings`, effect matrix |
| [`@bcf/dsh-mnemo-ui`](https://www.npmjs.com/package/@bcf/dsh-mnemo-ui) | **sidebar panel (client)** | `main` + `sidebar.panellist` slot registration |
| [`@bcf/dsh-mnemo-devkit`](https://www.npmjs.com/package/@bcf/dsh-mnemo-devkit) | host-free harness | `createHarness()` (real Cordis fiber) |

The split is not cosmetic: Cordis `inject` is dependency-driven, so users who want memory without
affect install `core + encoder + recall + tools` only, and `recall` degrades to a no-affect gating path.

---

## Sidebar panel

The panel uses the **actually published** client contract of `0.2.1-rc.3`, not the sketch in the design doc:

```ts
export const inject = ['slots', 'layout']
ctx.slots.register({ name: 'main', key: 'mnemo' }, MnemoPanel)
ctx.slots.register({ name: 'sidebar.panellist', id: 'mnemo', order: 60, label: () => '记忆' }, PanelIcon)
```

Four views: **Timeline** (grouped by day, virtualised, invalidated versions marked, inline edits),
**Graph** (two-hop concentric layout, deterministic), **Affect** (PAD scatter, six homeostatic
variables, persona anchor, user schema), **Diagnostics** (hit rate, token curve, contradictions,
tuning wizard, forgetting audit).

"Why was this recalled?" is rendered from the same `ScoreBreakdown` the scorer produces; the host and
client implementations are cross-checked by `test/panel-ssr.test.mjs`.

The preview needs no bundler: `npm run panel:build` copies `packages/ui/lib/client` into
`artifacts/panel/`, rewrites the two bare module specifiers to a React UMD shim, and serves it.
The point is that **the preview runs the same compiled output the host loads**.

---

## Known limitations

1. Only the rule-enhanced L1 path runs; `LlmPort` / `encodeTurnAsync` are ready but the host's `ctx.llm` shape is unverified.
2. Embeddings are character n-gram hashes — stable, but not semantic. Synonyms are covered by a lexicon.
3. No HNSW. Exact cosine scan is faster below 100k cells; the `annTopK` seam is reserved.
4. `ctx.remote` is not wired; the panel's remote adapter follows the shape documented in `docs/API-CONTRACT.md`.
5. The command surface depends on `ctx.cmdline`; it degrades to a `mnemo_command` tool.
6. No phenomenal consciousness, by design.
7. No encryption at rest — the database holds real conversations. See [SECURITY.md](SECURITY.md).

---

## Documentation

Long-form docs are in Chinese; the design doc and the project guide are the two that matter.

| Doc | What it is |
| :--- | :--- |
| [`docs/README.md`](docs/README.md) | Documentation map — pick by intent, not by order |
| [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) | What the code actually does; 15 weaknesses with evidence; 12 improvements ranked P0–P2 |
| [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md) | Full derivation: sparse-code algebra, four-channel recall, MRS rendering, biphasic consolidation |
| [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) | Where the real DSH `0.2.1-rc.3` packages differ from the design doc |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Environment, code map, hard constraints, commit style |
| [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md) · [`docs/PUBLISH.md`](docs/PUBLISH.md) | History, threat model, release steps |

## Contributing

Three hard constraints first: **injection has a token budget**, **writes must be reproducible**,
**no runtime dependencies**. Behaviour changes need tests — this project has a class of bugs
(a merge that overwrites leaves the old cell behind, so one fact becomes two records) that neither
the type checker nor code review can catch.

## License

[MIT](LICENSE). The research reports and the design doc under `docs/design/` remain the property of
their authors; this implementation only reproduces their engineering conclusions.
