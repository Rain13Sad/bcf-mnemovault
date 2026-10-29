<div align="center">
  <img src="docs/assets/banner.svg" alt="MnemoVault — DeepSeek Harness를 위한 장기 기억과 정서" width="100%">
</div>

<div align="center">

**DeepSeek Harness를 위한 장기 기억·정서 플러그인 모음.**
기억은 텍스트가 아니라 **고정 크기 셀**로 저장됩니다 — 희소 코드(정체성), int8 벡터(의미),
타입 초엣지(관계), 압축 잔차(원문). 컨텍스트 주입은 **턴당 약 107 토큰**.

[![CI](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml/badge.svg)](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.5-339933?logo=node.js&logoColor=white)](#빠른-시작)
[![Tests](https://img.shields.io/badge/tests-93-brightgreen.svg)](test/)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.3-4b6bfb.svg)](docs/API-CONTRACT.md)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md)

</div>

> 이 문서는 한국어 요약입니다. 설계 근거·알려진 약점 15가지·실측 수치는 **중국어 문서가 기준**입니다
> ([`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) / [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md)).

| | |
| :--- | :--- |
| **상태** | v0.2.0 · Developer Preview. 기준은 DSH `0.2.1-rc.3`(`next` 채널)이며, 호스트 자체가 아직 파괴적 변경을 냅니다 |
| **규모** | 패키지 10개 · 소스 42개 / TypeScript 11,215줄 · 테스트 93개 · **런타임 의존성 0** (내장 `node:sqlite`, `node:zlib`만 사용) |
| **먼저 읽을 것** | 유지보수 → [프로젝트 해설](docs/PROJECT-GUIDE.md)(중국어) / 개조 → [CONTRIBUTING](CONTRIBUTING.md) / 설계 근거 → [설계 문서](docs/design/MNEMOVAULT-DESIGN.md) |

---

## 왜 만들었나

컨텍스트 윈도는 유한하고, "세 달 전에 했던 말"은 들어가지 않거나 넣기에 너무 비쌉니다.
흔한 해법은 대화를 텍스트로 요약해 검색하는 것이지만, 요약은 **손실적이고 재현 불가**합니다 —
같은 대화를 두 번 요약하면 결과가 다르고, 요약하는 순간 원문은 사라집니다.

그래서 경로를 바꿉니다.

1. **쓰기 측**: 발화를 명제로 나누고 고정 크기 셀로 부호화합니다 — 희소 코드(정체성) + int8 벡터(의미)
   + 타입 초엣지(관계) + 사건/무효 시각(이중 시간) + 정서값 + 버전 사슬.
   원문은 brotli 잔차로 따로 보관되어 언제든 바이트 단위로 복원됩니다.
2. **읽기 측**: 네 경로(의미/정체성/그래프/시간) 점수를 합치고 4±1 슬롯 경쟁으로 주입할 항목을 정해
   표 행으로 렌더링합니다. 정상 상태에서 턴당 약 107 토큰.
3. **오프라인**: 수면과 유사한 두 단계 고정화 — NREM이 도식을 추상화하고, REM이 연상을 키우며,
   멱법칙 망각 곡선이 셀을 강등합니다.
4. **정서는 대사가 아니라 파라미터**: 평가 → PAD → 기분 → 관계 → 페르소나 앵커.
   모두 평범한 셀로 저장되어 진화하고 되돌릴 수 있습니다.

## 이것이 아닌 것

- **RAG 대체재가 아닙니다.** 문서가 아니라 "이 사람에 대한 기억"을 다룹니다.
- **현상적 의식을 주장하지 않습니다.** 정서 출력은 모두 상태 변수의 투영이며 `affect_report`는 수치와 면책 조항을 함께 반환합니다.
- **바로 쓸 수 있는 제품이 아닙니다.** DSH 호스트가 필요하고 DSH는 아직 Developer Preview입니다(지원 범위 `>=0.2.1-rc.3 <0.3.0`).
- **추출 품질은 규칙에 묶여 있습니다.** L1(모델 추출) 포트는 준비됐지만 지금 도는 것은 "규칙 강화" 버전뿐입니다. 숨기지 않은 약점입니다.

## 데이터 흐름

<div align="center">
  <img src="docs/assets/pipeline.svg" alt="쓰기·읽기·오프라인 고정화 세 경로" width="100%">
</div>

격자는 파생 상태입니다. `session_log`를 재생하면 재구축되고, 어떤 회상이든 스냅샷에서 바이트 단위로 재현됩니다.

---

## 빠른 시작

**요구 사항:** Node ≥ 22.5(내장 `node:sqlite` / `node:zlib`), npm ≥ 10. **테스트 실행에 DSH는 필요 없습니다.**

```bash
npm ci               # devDependencies만 (typescript / react / 타입)
npm run build        # 의존성 순서로 10개 패키지 컴파일 (번들러 없음, tsc만)
npm test             # 93개 테스트
npm run demo         # 26턴 중국어 대화: 주입 / 고정화 / 통계 / egress 가드
npm run bench:eval   # mnemo-bench: Recall@8 / MRR / 중복 제거 / 시간 추론 / 토큰 비용
npm run panel        # 사이드바 패널 미리보기 http://127.0.0.1:5178/
npm run verify       # 위 작업을 한 번에 (CI와 동일)
```

아직 npm에 배포되지 않았으므로 소스에서 설치합니다.

```bash
git clone https://github.com/Rain13Sad/bcf-mnemovault.git
cd bcf-mnemovault && npm ci && npm run build
```

이후 각 패키지의 `cordis.patch.yml`에 따라 DSH 프로필에 플러그인을 insert 합니다.
호스트 측 인터페이스의 실제 모양(설계 문서와의 차이)은
[`docs/API-CONTRACT.md`](docs/API-CONTRACT.md)에 기록되어 있습니다.

---

## 벤치마크

Node 22.22 / Windows 실측. `artifacts/bench.json`에서 재현됩니다(`npm run bench:eval`).

| 지표 | 실측 | 목표 | 비고 |
| :--- | ---: | :--- | :--- |
| Recall@8 | **0.941** | ≥ 0.80 | 정답이 붙은 합성 사실 34건 |
| MRR | **0.681** | ≥ 0.65 | 동일 |
| 중복 제거 정밀도 | **0.90** | ≥ 0.90 | 같은 사실의 재진술은 병합되어야 함 |
| 중복 제거 재현율 | **1.00** | — | 같은 주제·다른 값은 병합하면 안 됨 |
| 시간 추론 | **1.00** | ≥ 0.75 | `pnpm → npm → bun` 세 버전 |
| 토큰/턴 | **106.9** | ≤ 240 | 범례 상각 포함 |
| 회상 p95 | **30 ms** | ≤ 40 ms @100만 | 로컬은 100셀 규모 |
| 셀당 크기 | **341 B** | — | MC03(v0.2는 844 B) |
| 저장 비율(짧은 명제 DB) | 5.32× | 진단용 | 고정 기반 비용이 지배 |
| 저장 비율(800자 턴·기본 분할) | **0.84×** | ≤ 0.90 | 762자/턴, 2.25셀/턴 |
| 저장 비율(800자 턴·1셀) | **0.68×** | ≤ 0.72 | 거친 분할 대조군 |

<details>
<summary><b>저장 비율이 미달인 이유</b></summary>

셀마다 고정 기반은 192 B(헤더) + 256 B(희소 코드) + 256 B(벡터) = **704 B**이고,
brotli 잔차가 원문의 약 `0.42 ×`입니다. 따라서 `ratio ≈ (nCells × 750 + 0.42 × L) / L`.
설계 추정은 "턴당 1셀"을 가정했지만, 인코더는 **명제 단위**로 나누므로 한 턴에 2~4셀이 생겨
고정 기반이 2~4배로 커집니다. 구현 버그가 아니라 설계 문서의 구멍입니다.
완화책(미구현): 분할을 더 굵게, 저온층 PQ(256 → 32 B), 임베딩을 턴 단위로 이동.

</details>

---

## 패키지

| 패키지 | 역할 |
| :--- | :--- |
| `@rain13sad/dsh-mnemo-core` | 격자·저장·회상·렌더링(`ctx.memory`) |
| `@rain13sad/dsh-mnemo-affect` | 정서 커널(`ctx.affect`) |
| `@rain13sad/dsh-mnemo-encoder` | 쓰기 측(`session/event` 구독) |
| `@rain13sad/dsh-mnemo-recall` | 읽기 측(`agent/pre-step` 게이트와 주입) |
| `@rain13sad/dsh-mnemo-consolidator` | 오프라인 고정화(NREM / REM / 망각) |
| `@rain13sad/dsh-mnemo-tools` | 도구 6개 · `/mnemo` 15개 하위 명령 · egress 가드 |
| `@rain13sad/dsh-mnemo-proactive` | 먼저 말 걸기(네 개의 문) |
| `@rain13sad/dsh-mnemo-settings` | 설정 패널과 효과 매트릭스 |
| `@rain13sad/dsh-mnemo-ui` | 사이드바 패널(클라이언트 측) |
| `@rain13sad/dsh-mnemo-devkit` | 호스트 없는 실행기(`createHarness()`) |

Cordis의 `inject`는 의존성 기반이라, 정서가 필요 없으면 `core + encoder + recall + tools`만으로 동작하고
`recall`은 정서 게이트 없는 경로로 자동 강등됩니다.

## 알려진 제한

1. 지금 도는 것은 "규칙 강화" 버전 L1뿐(모델 추출 포트는 미검증).
2. 임베딩은 문자 n-gram 해시 — 안정적이지만 의미적이지 않음.
3. HNSW 미구현(10만 셀 이하에서는 정확 스캔이 더 빠름).
4. `ctx.remote` 미연결. 5. 명령 표면은 `ctx.cmdline` 의존. 6. 현상적 의식은 다루지 않음.
7. 저장 시 암호화 미구현 — 실제 대화가 들어가므로 [SECURITY.md](SECURITY.md) 참고.

## 문서

| 문서 | 내용 |
| :--- | :--- |
| [`docs/README.md`](docs/README.md) | 문서 지도(목적별) |
| [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) | 구현이 실제로 하는 일, 약점 15가지, 개선 12가지(P0–P2) |
| [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md) | 설계 유도(희소 코드 대수, 네 경로 회상, MRS 렌더링, 두 단계 고정화) |
| [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md) | DSH `0.2.1-rc.3` 실물과의 차이 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) · [`CHANGELOG.md`](CHANGELOG.md) · [`SECURITY.md`](SECURITY.md) | 참여 방법·변경 이력·위협 모델 |

## 라이선스

[MIT](LICENSE). `docs/design/`의 연구 보고서와 설계 문서의 저작권은 원저자에게 있습니다.
