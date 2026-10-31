<!-- DOC-VERSION: 0.5.2 -->

# MnemoVault

<div align="center">
  <img src="docs/assets/banner.png" alt="MnemoVault" width="100%">
</div>

<div align="center">

**DeepSeek Harness를 위한 장기 기억 + 정서 플러그인 모음.**
기억은 텍스트가 아니라 **고정 길이 셀**(희소 코드 + int8 벡터 + 타입이 있는 하이퍼엣지 + 압축 잔차)로 저장되며,
주입은 대화 기록 재생이 아니라 **턴당 약 116 token**으로 끝납니다.

[![CI](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml/badge.svg)](https://github.com/Rain13Sad/bcf-mnemovault/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rain13sad/dsh-mnemo-core.svg?logo=npm&label=npm)](https://www.npmjs.com/package/@rain13sad/dsh-mnemo-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](#빠른-시작)
[![Tests](https://img.shields.io/badge/tests-176-brightgreen.svg)](test/)

[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · **한국어** · [Español](README.es.md)

</div>

> **이 문서는 요약입니다.** 정식 문서는 [영어판](README.md)과 [중국어판](README.zh-CN.md)에 있으며,
> 삭제 판단 체인의 전체 구조, v0.5.x 변경점, 19가지 알려진 한계(D1–D19)가 그쪽에 있습니다.

| | |
| :--- | :--- |
| **상태** | **v0.5.2** · Developer Preview (기준 DSH `0.2.1-rc.3`) |
| **규모** | 10개 패키지 · 59개 소스 파일 / 약 18,700줄 (`.ts` + `.tsx`) · 176개 테스트 |
| **의존성** | 실행 시 **`@deepseek-ai/*` 이외의 서드파티 패키지에 의존하지 않습니다** (유일한 외부 패키지는 설정 스키마용 `schemastery`, 나머지는 Node 내장 `node:sqlite` / `node:zlib`) |
| **요구 사항** | Node ≥ 22.13 · npm ≥ 10. 테스트 실행에 DSH 호스트는 필요 없습니다 |

---

## 개요

**기능.** DSH 에이전트에게 컨텍스트 윈도보다 오래 사는 기억을 줍니다. 매 턴을 고정 길이 셀로 쓰고,
답변마다 네 경로로 읽어 **약 116 token**만 주입합니다. 사실 외에 정서 상태(평가 → PAD → 기분 →
관계 → 페르소나 앵커)도 함께 보관하므로 "무엇을 말했는지"뿐 아니라 "어떻게 말했는지"도 꺼낼 수
있습니다. 22개 서브커맨드, 7탭 패널, 그리고 "망각은 읽을 수 있는 결정이지 보이지 않는 TTL이 아니다"라는 규칙.

**기술.** 텍스트로 저장되는 것은 하나도 없습니다. 셀 하나는 341 B: 2048비트 희소 코드(동일성),
128차원으로 접은 int8 벡터(의미), 타입 있는 하이퍼엣지(관계), 이중 시간축, 정서값, 버전 체인.
원문은 brotli 잔차로 따로 남기므로 어느 단계도 영구 손실이 아닙니다. 저장은 단일 `node:sqlite`
파일, 검색은 SDR 역색인 + 연속 int8 벡터 행렬이라 빠른 경로와 느린 경로의 점수가 비트 단위로
같습니다. 보존도는 채점 가능한 파이프라인입니다: 7요인 → 진부화 엔벨로프 → 5개 점수 구간(P5…P1) →
상한만 정하는 6개 게이트 → 5개 tier, 패스당 한 단계. **검색 중에 모델을 호출하지 않습니다.**

**강점.** 읽기 경로에 생성 단계가 없으므로 검색은 **결정적**이고 스냅샷에서 바이트 단위로 재생됩니다.
잔차를 남기므로 "요약하고 원문을 버린다"가 일어나지 않습니다. 삭제가 채점과 설명을 동반하므로
라이브러리가 줄어도 "일어난 일"을 조용히 잃지 않습니다. 비용도 규모에 따라 늘지 않습니다:
822셀에서 p50 **약 4 ms**, 10k셀에서 p95 **25–32 ms**, 실행 시 `@deepseek-ai/*` 외 서드파티 의존성 0,
10개 패키지, 176개 테스트, Node 내장만 사용.

## 무엇을 해결하는가

컨텍스트 윈도는 유한하고, "석 달 전에 들은 것"은 들어가지 않거나 넣기엔 너무 비쌉니다.
흔한 답은 대화를 요약해 텍스트로 저장하는 것이지만, **요약은 손실되고 재현되지 않습니다**.

이 프로젝트는 다른 길을 갑니다.

1. **쓰기 쪽**: 발화를 명제로 나누고 각각을 고정 길이 셀로 부호화합니다
   (희소 코드 + int8 벡터 + 타입 있는 엣지 + 이중 시간축 + 정서값 + 버전 체인).
   원문은 brotli 잔차로 따로 보관되어 언제든 복원할 수 있습니다.
2. **읽기 쪽**: 의미 / 동일성 / 그래프 / 시간 네 경로로 후보를 모아 점수를 합치고,
   4±1 슬롯 경쟁으로 주입 내용을 결정합니다.
3. **오프라인**: NREM이 도식을 추상화하고, REM이 연상을 만들며,
   **7요인 보존도**(ACT-R 활성 + 중요도 + 정서 + 연결도 + 서사 + 사용자 고정 + 간격 − 중복)가 계층을 결정합니다.

<div align="center">
  <img src="docs/assets/pipeline.png" alt="쓰기 / 읽기 / 오프라인 세 레인: 발화 → MemCell, 4경로 검색 → 4±1 슬롯, 통합과 강등" width="100%">
</div>

## v0.5.x 핵심

- **삭제 판단이 실제로 동작합니다**: v0.4에서는 "평범한 발화 10건을 400일 전으로 옮겨도 0건만 강등"되었습니다.
  원인은 세 가지(항상 참이 되는 게이트, 시간에 따라 감쇠하지 않는 정적 요인, 1단계 강등 × P3 하한)였고 v0.5에서 해소했습니다.
- **게이트는 점수를 바꾸지 않습니다**: 점수는 7요인이 결정하고, 게이트는 "묘비로 가는 것"만 막습니다.
- **tier 4 = 묘비**: 잔차와 벡터를 해제하고 검색에서 제외되며, 패널에서 되살릴 수 있습니다(원문은 돌아오지 않습니다).
- **v0.5.1**: i8 부호 손실(음수 정서값이 양수로 바뀜), 기념일 보너스로 인한 계층 되돌림,
  묘비를 찾을 수 없던 "죽은 스위치"를 수정했습니다.
- **v0.5.2**: 실제 규모에서 성립하게 만들었습니다. 병목은 "쓰기가 O(n)"이 아니라
  **"128번의 곱셈을 위해 매번 라이브러리 전체 blob을 디코딩하던 것"**이었습니다.
  822 cell에서 턴당 25.4 ms → **3.1 ms**(증가가 멈췄습니다), 1만 cell의 recall p95는 **25 ms**.
  SDR 역색인(임계값은 판정식에서 역산한 **필요조건**이라 후보는 초집합), 메모리 벡터 행렬,
  시간 색인, 보유도 영속화 + 단조성 가지치기를 넣었습니다.

## 빠른 시작

```bash
npm ci               # devDependencies만 (typescript / react / 타입 정의)
npm run build        # 10개 패키지를 의존 순서로 tsc 빌드 (번들러 없음)
npm test             # 176개 테스트
npm run demo         # 26턴 중국어 대화: 주입 / 통합 / 통계 / egress 가드
npm run bench:eval   # Recall@8 / MRR / 중복 제거 / 시간 추론 / token 비용
npm run panel        # 패널 미리보기 → http://127.0.0.1:5178/
```

DSH에 설치하는 경우:

```bash
npm i @rain13sad/dsh-mnemo-core @rain13sad/dsh-mnemo-encoder @rain13sad/dsh-mnemo-recall @rain13sad/dsh-mnemo-tools
npm i @rain13sad/dsh-mnemo-affect @rain13sad/dsh-mnemo-consolidator @rain13sad/dsh-mnemo-proactive
npm i @rain13sad/dsh-mnemo-ui @rain13sad/dsh-mnemo-settings
```

각 패키지의 `cordis.patch.yml`을 프로파일에 추가하세요.
호스트 측 접합의 실제 형태는 [`docs/API-CONTRACT.md`](docs/API-CONTRACT.md)에 기록되어 있습니다.

## 이것이 아닌 것

- **RAG 대체재가 아닙니다.** 문서가 아니라 "사람에 대한 기억"을 다룹니다.
- **현상적 의식을 주장하지 않습니다.** 정서 출력은 상태 변수의 투영이며, `affect_report`는 숫자와 면책 문구를 반환합니다.
- **바로 쓸 수 있는 제품이 아닙니다.** DSH 호스트가 필요하고, DSH 자체가 아직 Developer Preview입니다.

## 더 읽기

| 문서 | 내용 |
| :--- | :--- |
| [`README.md`](README.md) | 영어판 (삭제 판단 체인, 벤치마크, 19가지 한계) |
| [`README.zh-CN.md`](README.zh-CN.md) | 중국어판 (가장 상세. 용어와 수치의 정본) |
| [`docs/design/V0.5-PLAN.md`](docs/design/V0.5-PLAN.md) | v0.5 설계 판단과 실측값 |
| [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md) | 결함 19가지(D1–D19)와 개선 제안 |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 환경 · 코드 맵 · 지켜야 할 제약 |

## 라이선스

MIT
