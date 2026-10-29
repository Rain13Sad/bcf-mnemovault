<div align="center">
  <img src="docs/assets/banner.svg" alt="MnemoVault — DeepSeek Harness のための長期記憶と感情" width="100%">
</div>

<div align="center">

**DeepSeek Harness のための長期記憶・感情プラグイン群。**
記憶はテキストではなく**固定長セル**として保存されます — スパースコード（同一性）、int8 ベクトル（意味）、
型付きハイパーエッジ（関係）、圧縮残差（原文）。コンテキストへの注入は **1 ターン約 107 トークン**。

[![CI](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml/badge.svg)](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](#クイックスタート)
[![Tests](https://img.shields.io/badge/tests-93-brightgreen.svg)](test/)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.3-4b6bfb.svg)](docs/API-CONTRACT.md)

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

</div>

> この README は日本語の要約です。設計の根拠・既知の弱点 15 件・実測値は**中国語ドキュメントが正**です
> （[`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) / [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md)）。

| | |
| :--- | :--- |
| **状態** | v0.2.0 · Developer Preview。基準は DSH `0.2.1-rc.3`（`next` チャンネル）。ホスト自体が破壊的変更を続けています |
| **規模** | 10 パッケージ · 42 ソースファイル / 11,215 行の TypeScript · 93 テスト · **実行時依存ゼロ**（組み込みの `node:sqlite` と `node:zlib` のみ） |
| **まず読む** | 保守する → [プロジェクト解説](docs/PROJECT-GUIDE.md)（中国語）／改造する → [CONTRIBUTING](CONTRIBUTING.md)／設計根拠 → [設計ドキュメント](docs/design/MNEMOVAULT-DESIGN.md) |

---

## なぜ作ったか

コンテキストウィンドウは有限で、「三か月前に言っていたこと」は入らないか、入れるには高すぎます。
よくある解は会話をテキストに要約して検索することですが、要約は**不可逆かつ非再現**です —
同じ会話を二度要約すれば結果は違い、要約した時点で原文は失われます。

そこで経路を変えます。

1. **書き込み側**：発話を命題に分割し、固定長セルに符号化 — スパースコード（同一性）＋ int8 ベクトル（意味）
   ＋ 型付きハイパーエッジ（関係）＋ 事象時刻と失効時刻（双時間）＋ 感情値 ＋ バージョン連鎖。
   原文は brotli 残差として別に保存し、いつでもバイト単位で復元できます。
2. **読み出し側**：4 経路（意味 / 同一性 / グラフ / 時間）のスコアを統合し、4±1 スロット競合で
   注入する数件を決め、表の行として描画。定常状態で約 107 トークン/ターン。
3. **オフライン**：睡眠に似た二相の固定化 — NREM が図式を抽象化し、REM が連想を伸ばし、
   冪則の忘却曲線がセルを降格します。
4. **感情は台詞ではなくパラメータ**：評価 → PAD → 気分 → 関係 → ペルソナのアンカー。
   すべて通常のセルとして保存され、進化も巻き戻しもできます。

## これは何ではないか

- **RAG の代替ではありません。** 文書ではなく「その人についての記憶」を扱います。
- **現象的意識を主張しません。** 感情の出力はすべて状態変数の射影で、`affect_report` は数値と免責事項を返します。
- **すぐ使える製品ではありません。** DSH ホストが必要で、DSH はまだ Developer Preview です（対応範囲 `>=0.2.1-rc.3 <0.3.0`）。
- **抽出品質は規則に縛られます。** L1（モデル抽出）の口は用意済みですが、現在動くのは「規則強化」版のみ。隠していない既知の弱点です。

## データフロー

<div align="center">
  <img src="docs/assets/pipeline.svg" alt="書き込み・読み出し・オフライン固定化の三経路" width="100%">
</div>

格子は派生状態です。`session_log` を再生すれば再構築でき、任意の想起はスナップショットからバイト単位で再現できます。

---

## クイックスタート

**必要環境：** Node ≥ 22.5（組み込みの `node:sqlite` / `node:zlib`）、npm ≥ 10。**テストの実行に DSH は不要です。**

```bash
npm ci               # devDependencies のみ（typescript / react / 型）
npm run build        # 依存順に 10 パッケージをコンパイル（bundler なし、tsc のみ）
npm test             # 93 テスト
npm run demo         # 26 ターンの中国語対話：注入 / 固定化 / 統計 / egress ガード
npm run bench:eval   # mnemo-bench：Recall@8 / MRR / 重複除去 / 時間推論 / トークンコスト
npm run panel        # サイドバーパネルのプレビュー http://127.0.0.1:5178/
npm run verify       # 上記を一括実行（CI と同じ）
```

npm 未公開のため、現状はソースから導入します。

```bash
git clone https://github.com/Rain13Sad/bcf-mnemovault.git
cd bcf-mnemovault && npm ci && npm run build
```

その後、各パッケージの `cordis.patch.yml` に従って DSH プロファイルへプラグインを insert します。
ホスト側インターフェースの実際の形（設計ドキュメントとの差分）は
[`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) に記録しています。

---

## ベンチマーク

Node 22.22 / Windows で実測。`artifacts/bench.json` から再現できます（`npm run bench:eval`）。

| 指標 | 実測 | 目標 | 補足 |
| :--- | ---: | :--- | :--- |
| Recall@8 | **0.941** | ≥ 0.80 | 正解付きの合成事実 34 件 |
| MRR | **0.681** | ≥ 0.65 | 同上 |
| 重複除去 適合率 | **0.90** | ≥ 0.90 | 同じ事実の言い換えは統合されるべき |
| 重複除去 再現率 | **1.00** | — | 同じ話題で値が違うものは統合しない |
| 時間推論 | **1.00** | ≥ 0.75 | `pnpm → npm → bun` の三版 |
| トークン/ターン | **106.9** | ≤ 240 | 凡例の償却込み |
| 想起 p95 | **30 ms** | ≤ 40 ms @100 万 | 手元は 100 セル規模 |
| 1 セルあたり | **341 B** | — | MC03（v0.2 は 844 B） |
| 保存比率（短い命題の DB） | 5.32× | 診断用 | 固定基底が支配的 |
| 保存比率（800 字ターン・既定の分割） | **0.84×** | ≤ 0.90 | 762 字/ターン、2.25 セル/ターン |
| 保存比率（800 字ターン・1 セル） | **0.68×** | ≤ 0.72 | 粗い分割の対照 |

<details>
<summary><b>保存比率が未達の理由</b></summary>

各セルの固定基数は 192 B（ヘッダ）＋ 256 B（スパースコード）＋ 256 B（ベクトル）＝ **704 B**、
加えて brotli 残差が原文の約 `0.42 ×`。よって `ratio ≈ (nCells × 750 + 0.42 × L) / L`。
設計時の見積りは「1 ターン 1 セル」を仮定していましたが、エンコーダは**命題単位**で分割するため
1 ターンで 2〜4 セルになり、固定基数が 2〜4 倍に膨らみます。実装の不具合ではなく設計ドキュメントの穴です。
緩和策（未実装）：分割を粗くする、低温層の PQ（256 → 32 B）、埋め込みをターン単位へ移す。

</details>

---

## パッケージ

| パッケージ | 役割 |
| :--- | :--- |
| `@rain13sad/dsh-mnemo-core` | 格子・保存・想起・描画（`ctx.memory`） |
| `@rain13sad/dsh-mnemo-affect` | 感情カーネル（`ctx.affect`） |
| `@rain13sad/dsh-mnemo-encoder` | 書き込み側（`session/event` を購読） |
| `@rain13sad/dsh-mnemo-recall` | 読み出し側（`agent/pre-step` のゲートと注入） |
| `@rain13sad/dsh-mnemo-consolidator` | オフライン固定化（NREM / REM / 忘却） |
| `@rain13sad/dsh-mnemo-tools` | ツール 6 個・`/mnemo` 15 サブコマンド・egress ガード |
| `@rain13sad/dsh-mnemo-proactive` | 主動的に話しかける（四つのゲート） |
| `@rain13sad/dsh-mnemo-settings` | 設定パネルと効果マトリクス |
| `@rain13sad/dsh-mnemo-ui` | サイドバーパネル（クライアント側） |
| `@rain13sad/dsh-mnemo-devkit` | ホスト不要の実行器（`createHarness()`） |

Cordis の `inject` は依存駆動なので、感情が不要なら `core + encoder + recall + tools` だけで動き、
`recall` は感情ゲートなしの経路に自動で落ちます。

## 既知の制限

1. 動いているのは「規則強化」版の L1 のみ（モデル抽出の口は未検証）。
2. 埋め込みは文字 n-gram ハッシュ — 安定だが意味的ではない。
3. HNSW は未実装（10 万セル以下では厳密走査の方が速い）。
4. `ctx.remote` は未接続。5. コマンド面は `ctx.cmdline` 依存。6. 現象的意識は扱いません。
7. 保存時の暗号化は未実装 — 実会話が入るため [SECURITY.md](SECURITY.md) を参照。

## ドキュメント

| ドキュメント | 内容 |
| :--- | :--- |
| [`docs/README.md`](docs/README.md) | ドキュメントマップ（目的別） |
| [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) | 実装が実際に何をしているか、弱点 15 件、改善 12 件（P0–P2） |
| [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md) | 設計の導出（スパースコード代数、四経路想起、MRS 描画、二相固定化） |
| [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) | DSH `0.2.1-rc.3` 実物との差分 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md) | 参加方法・変更履歴・脅威モデル |

## ライセンス

[MIT](LICENSE)。`docs/design/` の調査報告と設計ドキュメントの著作権は原著者に帰属します。
