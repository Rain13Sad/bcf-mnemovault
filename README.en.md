# MnemoVault

**A long-term memory and affect plugin family for [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (DSH).**
Memories are not stored as text: each one is a fixed-size *cell* — a 2048-bit sparse code (identity),
an int8 vector (semantics), typed hyperedges (relations), bi-temporal stamps and an affect reading —
plus a brotli residual that keeps the original bytes. Injection renders **~116 tokens per turn**
instead of replaying the transcript.

[![CI](https://github.com/Rain13Sad/mnemo-vault/actions/workflows/ci.yml/badge.svg)](https://github.com/Rain13Sad/mnemo-vault/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](#requirements)
[![Tests](https://img.shields.io/badge/tests-93-brightgreen.svg)](test/)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.3-4b6bfb.svg)](docs/API-CONTRACT.md)

[中文](README.md) · English

> **In one line**: memory should not be text. Text is a projection for humans, not a storage format for machines.

| | |
| :--- | :--- |
| **Status** | v0.2.0, Developer Preview. Baseline DSH `0.2.1-rc.3` (`next` channel); the host itself still ships breaking changes |
| **Size** | 10 packages · 42 source files / 11,215 lines of TS · 93 tests · **zero runtime dependencies** (only built-in `node:sqlite` and `node:zlib`) |
| **Start here** | Maintaining it → [Project guide](docs/PROJECT-GUIDE.md) (15 known weaknesses, 12 ranked improvements, in Chinese)<br>Hacking on it → [CONTRIBUTING](CONTRIBUTING.md)　Design rationale → [design doc v0.2](docs/design/MNEMOVAULT-DESIGN.md) |

---

## The problem it addresses

A DSH context window is finite, and "what the user told you three months ago" either does not fit or
is too expensive to keep. The usual answer is to summarise the conversation into text and retrieve it —
but summaries are **lossy and irreproducible**: two runs over the same dialogue differ, and once you
summarise, the original is gone.

This project takes a different route:

1. **Write side** splits utterances into propositions and encodes each into a fixed-size cell:
   sparse code (identity) + int8 vector (semantics) + typed hyperedges (relations) + event/invalid
   timestamps (bi-temporal) + affect + version chain. The original text is kept separately as a
   brotli residual and can always be recovered byte-for-byte.
2. **Read side** runs four retrieval channels (semantic / identity / graph / temporal), merges the
   scores, and lets a 4±1 slot competition decide what gets injected — rendered as table rows,
   ~116 tokens per turn at steady state (~90% cheaper than replaying summaries).
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
  path runs today. This is a stated weakness, not a hidden one.

---

## Quick start

<a id="requirements"></a>
Requirements: **Node ≥ 22.5** (built-in `node:sqlite` / `node:zlib`) and npm ≥ 10.
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

Measured on Node 22.22 / Windows; reproducible from `artifacts/bench.json`:

| Metric | Measured | Target | Note |
| :--- | ---: | :--- | :--- |
| Recall@8 | **0.941** | ≥ 0.80 | 34 synthetic facts with ground truth |
| MRR | **0.686** | ≥ 0.65 | same |
| Dedupe precision | **0.90** | ≥ 0.90 | restating a fact should merge |
| Dedupe recall | **1.00** | — | same topic, different value should not merge |
| Temporal reasoning | **1.00** | ≥ 0.75 | `pnpm → npm → bun` across three versions |
| tokens / turn | **116.0** | ≤ 240 | legend amortised |
| Recall p95 | **30 ms** | ≤ 40 ms @1M | 100 cells locally, not a million |
| Storage ratio (short propositions) | 24.1× | ≤ 0.60 | **see "One metric we miss"** |
| Storage ratio (800-char turn) | 2.50× | ≤ 0.60 | same |

CI turns these into failing assertions via [`scripts/ci-assert-bench.mjs`](scripts/ci-assert-bench.mjs).
The storage ratio is a known miss and only printed, not gated — a CI that is permanently red
stops being read.

### Installing into DSH

Not published to npm yet (the `@bcf` scope is unclaimed), so install from source:

```bash
git clone https://github.com/Rain13Sad/mnemo-vault.git && cd mnemo-vault
npm ci && npm run build
```

Then insert the plugins into your DSH profile using each package's `cordis.patch.yml`
(plugin id, package name, default config). The actual shape of the host-side seams — and where
it differs from the design doc — is recorded in [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md).

---

## Architecture at a glance

| Package | Role | Key exports |
| :--- | :--- | :--- |
| `@bcf/dsh-mnemo-core` | lattice + storage + recall + rendering | `ctx.memory`, `SdrSpace`, `encodeCell`, `SensoryRing`, `WorkingSet` |
| `@bcf/dsh-mnemo-affect` | affect kernel | `ctx.affect`, `appraise`, `derivePolicy`, `deriveUserSchema` |
| `@bcf/dsh-mnemo-encoder` | write side | `Encoder` (subscribes to `session/event`) |
| `@bcf/dsh-mnemo-recall` | read side | `agent/pre-step` gating and injection |
| `@bcf/dsh-mnemo-consolidator` | offline consolidation | `Consolidator` (NREM / REM / forgetting) |
| `@bcf/dsh-mnemo-tools` | tools + commands | 6 tools, 15 `/mnemo` subcommands, egress guard |
| `@bcf/dsh-mnemo-proactive` | **speaking up first** | `ctx.mnemoProactive`, `candidate()`, `tick()` |
| `@bcf/dsh-mnemo-settings` | settings panel | `ctx.mnemoSettings`, effect matrix |
| `@bcf/dsh-mnemo-ui` | **sidebar panel (client)** | `main` + `sidebar.panellist` slot registration |
| `@bcf/dsh-mnemo-devkit` | host-free harness | `createHarness()` (real Cordis fiber) |

The split is not cosmetic: Cordis `inject` is dependency-driven, so users who want memory without
affect install `core + encoder + recall + tools` only, and `recall` degrades to a no-affect gating path.

## One metric we miss

**Storage ratio is 2.50× on 800-character turns; the design targeted 0.45–0.60×.**

The arithmetic is simple: every cell has a fixed base of 192 B (header) + 256 B (sparse code) +
256 B (vector) = **704 B**, plus a brotli residual of about `0.42 × raw`. So
`ratio ≈ (nCells × 750 + 0.42 × L) / L`. The design estimate assumed *one cell per turn*;
the encoder splits per **proposition** (which is what §7.2 asks for), so a turn yields 2–4 cells and
the fixed base is amplified 2–4×. This is a gap in the design doc, not an implementation bug.
Mitigations (not yet done): coarser splitting, product quantisation in the cold tier, moving the
embedding to turn level.

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

All long-form docs are in Chinese; the design doc and project guide are the two that matter.

| Doc | What it is |
| :--- | :--- |
| [`docs/README.md`](docs/README.md) | Documentation map — pick by intent, not by order |
| [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) | What the code actually does; 15 weaknesses with evidence; 12 improvements ranked P0–P2 |
| [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md) | Full derivation: sparse-code algebra, four-channel recall, MRS rendering, biphasic consolidation |
| [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) | Where the real DSH `0.2.1-rc.3` packages differ from the design doc |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md) · [`docs/PUBLISH.md`](docs/PUBLISH.md) | Contribution rules, history, threat model, release steps |

## License

[MIT](LICENSE). The research reports and the design doc under `docs/design/` remain the property of
their authors; this implementation only reproduces their engineering conclusions.
