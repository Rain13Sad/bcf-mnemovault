<!-- DOC-VERSION: 0.5.1 -->

# MnemoVault

<div align="center">
  <img src="docs/assets/banner.svg" alt="MnemoVault" width="100%">
</div>

<div align="center">

**DeepSeek Harness のための長期記憶 + 感情プラグイン群。**
記憶はテキストではなく**固定長セル**（スパースコード + int8 ベクトル + 型付きハイパーエッジ + 圧縮残差）として保存され、
注入は会話履歴の再生ではなく **1 ターン約 116 token** で済みます。

[![CI](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml/badge.svg)](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rain13sad/dsh-mnemo-core.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@rain13sad/dsh-mnemo-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](#クイックスタート)
[![Tests](https://img.shields.io/badge/tests-160-brightgreen.svg)](test/)

[English](README.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Español](README.es.md)

</div>

> **このページは要約です。** 正式なドキュメントは
> [英語版](README.md) と [中国語版](README.zh-CN.md) にあり、削除判断チェーンの全容、
> v0.5.x の変更点、19 件の既知の制限（D1–D19）はそちらにあります。

| | |
| :--- | :--- |
| **状態** | **v0.5.1** · Developer Preview（基線 DSH `0.2.1-rc.3`） |
| **規模** | 10 パッケージ · 56 ソースファイル / 約 17,300 行（`.ts` + `.tsx`）· 160 テスト |
| **依存** | 実行時に **`@deepseek-ai/*` 以外の第三者パッケージに依存しません**（唯一の外部は設定スキーマ用の `schemastery`、残りは Node 組み込みの `node:sqlite` / `node:zlib`） |
| **要件** | Node ≥ 22.13 · npm ≥ 10。テストの実行に DSH ホストは不要 |

---

## 何を解決するか

コンテキストウィンドウは有限で、「三か月前に聞いたこと」は入らないか、入れるには高すぎます。
よくある答えは会話を要約してテキストで保存することですが、**要約は不可逆で再現性がありません**。

このプロジェクトは別の道を取ります。

1. **書き込み側**：発話を命題に分割し、それぞれを固定長セルに符号化します
   （スパースコード + int8 ベクトル + 型付きエッジ + 二時制タイムスタンプ + 感情値 + バージョン連鎖）。
   原文は brotli 残差として別に保存され、いつでも復元できます。
2. **読み出し側**：意味 / 同一性 / グラフ / 時間の 4 経路で候補を集め、スコアを統合し、
   4±1 のスロット競争で注入内容を決めます。
3. **オフライン**：NREM が図式を抽象化し、REM が連想を作り、
   **7 因子の保持度**（ACT-R 活性 + 重要度 + 感情 + 連結度 + 物語 + ユーザー固定 + 間隔 − 冗長）が階層を決めます。

## v0.5.x の要点

- **削除判断が実際に動く**：v0.4 では「10 件の普通の発話を 400 日前にずらしても 0 件しか降格しない」状態でした。
  原因は 3 つ（常に真になるゲート、時間で減衰しない静的因子、1 段階降格 × P3 フロア）で、v0.5 で解消しました。
- **ゲートはスコアを書き換えない**：スコアは 7 因子が決め、ゲートは「墓碑へ行かせない」だけを担当します。
- **tier 4 = 墓碑**：残差とベクトルを解放し、検索から外れ、パネルから復活できます（原文は戻りません）。
- **v0.5.1**：i8 の符号欠落（負の感情値が正に化ける）、周年ボーナスによる階層の揺り戻し、
  墓碑が検索できない「死んだスイッチ」を修正しました。

## クイックスタート

```bash
npm ci               # devDependencies のみ（typescript / react / 型定義）
npm run build        # 10 パッケージを依存順に tsc でビルド（バンドラなし）
npm test             # 160 テスト
npm run demo         # 26 ターンの中国語対話：注入 / 統合 / 統計 / egress ガード
npm run bench:eval   # Recall@8 / MRR / 重複排除 / 時間推論 / token コスト
npm run panel        # パネルのプレビュー → http://127.0.0.1:5178/
```

DSH へ導入する場合：

```bash
npm i @rain13sad/dsh-mnemo-core @rain13sad/dsh-mnemo-encoder @rain13sad/dsh-mnemo-recall @rain13sad/dsh-mnemo-tools
npm i @rain13sad/dsh-mnemo-affect @rain13sad/dsh-mnemo-consolidator @rain13sad/dsh-mnemo-proactive
npm i @rain13sad/dsh-mnemo-ui @rain13sad/dsh-mnemo-settings
```

各パッケージの `cordis.patch.yml` をプロファイルに追加してください。
ホスト側の接縫の実形状は [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) に記録しています。

## これは何ではないか

- **RAG の代替ではありません。** 文書ではなく「人についての記憶」を扱います。
- **現象意識を主張しません。** 感情出力は状態変数の射影で、`affect_report` は数値と免責事項を返します。
- **すぐ使える製品ではありません。** DSH ホストが必要で、DSH 自体がまだ Developer Preview です。

## さらに読む

| 文書 | 内容 |
| :--- | :--- |
| [`README.md`](README.md) | 英語版（削除判断チェーン、ベンチマーク、19 件の制限） |
| [`README.zh-CN.md`](README.zh-CN.md) | 中国語版（最も詳細。用語と数値の正典） |
| [`docs/design/V0.5-PLAN.md`](docs/design/V0.5-PLAN.md) | v0.5 の設計判断と実測値 |
| [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) | 欠点 19 件（D1–D19）と改善提案 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 環境・コードマップ・守るべき制約 |

## ライセンス

MIT
