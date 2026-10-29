# MnemoVault 项目说明书

> 版本：0.3.1　|　对应设计文档：[`docs/design/MNEMOVAULT-DESIGN.md`](design/MNEMOVAULT-DESIGN.md) v0.2　|　基线：DSH `0.2.1-rc.3`
> 代码规模：51 个源文件 / 14,700 行（TypeScript + TSX）；脚本 13 个 / 1,520 行；测试 12 个文件 / 115 条　|　日期：2026-10-29
>
> 本文是**给要接手这个项目的人**看的：它说明系统是什么、怎么用、内部怎么运作、
> 哪些地方靠得住、哪些地方靠不住，以及下一步该改什么、为什么。
> 它不重复开发文档的理论推导，只讲**这份代码实际做了什么**。

---

## 目录

1. [项目概览](#1-项目概览)
2. [快速上手](#2-快速上手)
3. [架构](#3-架构)
4. [数据模型](#4-数据模型)
5. [核心算法](#5-核心算法)
6. [情感系统](#6-情感系统)
7. [对外接口](#7-对外接口)
8. [运维与诊断](#8-运维与诊断)
9. [安全与合规](#9-安全与合规)
10. [实测数据](#10-实测数据)
11. [优点](#11-优点)
12. [缺点](#12-缺点)
13. [改进意见](#13-改进意见)
14. [附录](#14-附录)

---

## 1. 项目概览

### 1.1 一句话定位

> 给 DeepSeek Harness 装一层**跨会话记忆 + 情感状态**：记忆不存成文字，存成稀疏码 + 向量 + 超边，
> 注入上下文时只渲染约 110 token。

### 1.2 解决什么问题

主流做法是"文本块 + 向量索引 + RAG 拼接"。它能在 demo 里工作，但有四笔账算不平：

| 账 | 问题 | 本项目的做法 |
| :--- | :--- | :--- |
| **Token 账** | 一条 6 个字的偏好埋在 300 字讨论里，RAG 把 300 字塞回来 | 结构化渲染：一行 MRS 约 23 token，装 3–4 个字段 |
| **推理账** | 模型每读一次就要重新做一次矛盾检测 | 写入时做一次：Jaccard 去重 + 版本链 |
| **检索账** | 一个余弦相似度同时服务"精确事实"和"模糊联想" | 四路召回：语义 / 符号 / 图 / 时间，各用各的尺子 |
| **演化账** | 记忆是静态的，要么在要么被删 | 双时态 + 遗忘曲线 + 睡眠双相巩固 |

### 1.3 明确不做的事

写在 README 与代码注释里，防止被误读：

1. **不实现现象意识**。情感是六个可观测变量的投影，`affect_report` 返回数值并自带免责声明。
2. **不替代 DSH 的 Session Log**。晶格是日志之上的**可再生产物**，不是事实源。
3. **不做跨模态**。类型位预留，编码器只处理文本。
4. **不做多用户鉴权**（v0.6）。只做到"作用域隔离"的地基：`scopeKey` 字符串 + 检索期过滤。
5. **存储比已改善但没到文档的 0.60×**。实测 0.84×（v0.2 为 2.50×）；0.60× 在算术上到不了，推导见 README「存储比」一节与第 12 章的 D7。

### 1.4 当前状态

| 维度 | 状态 |
| :--- | :--- |
| 编译 | 10 个包全部通过 `tsc`，零 `any` 逃逸（除少数跨版本接缝处有注释说明） |
| 测试 | 115 条全绿（10 条 SDR + 16 条核心不变量 + 15 条集成 + 23 条特性 + 13 条隔离/重建 + 15 条陪伴层 + 2 条面板 + 6 条 ANN + 9 条接线 + 6 条主动开口） |
| 评测 | Recall@8 0.941 / MRR 0.681 / 时间推理 1.00 / tokens 106.9 每轮 / 单条 cell 341 B |
| 面板 | 四视图可运行，独立预览跑的是编译产物 |
| 未接线 | 真实 embedding 服务（`EmbeddingPort` 接口已定义）、宿主 `ctx.llm` 的真机验证 |
| v0.3.1 | 修发布事故（npm ci 失败）+ 两条 P0 隐私问题 + 只读接口副作用 + 存储层常数因子，详见 CHANGELOG |

---

## 2. 快速上手

### 2.1 环境

- Node ≥ 22.5（用到 `node:sqlite`；ESM 下通过 `process.getBuiltinModule` 取）
- 无原生依赖：SQLite 用内置模块，压缩用内置 `zlib`
- 开发依赖只有 `typescript` / `react` / 类型包

### 2.2 五条命令

```bash
npm ci
npm run build      # 按依赖顺序编译 10 个包（core → affect → encoder → … → ui）
npm test           # 115 条
npm run demo       # 26 轮中文对话，打印注入 / 巩固 / 统计 / 守卫
npm run panel      # 面板预览 http://127.0.0.1:5178/
```

外加两条诊断：

```bash
npm run check      # SDR 性质自检（13 项断言，200ms）
npm run bench:eval # mnemo-bench，产出 artifacts/bench.json
npm run verify     # 以上四件事一次跑完
```

### 2.3 一次对话里发生了什么

```
用户消息
  ├─(1) SensoryRing 收原始文本 + 哈希（TTL 2 轮，去重粘贴）
  ├─(2) affect.observe() → 6 维评价 → PAD → mood 积分 → 关系模型
  ├─(3) agent/pre-step（waterfall）：
  │      门控 → memory.recall() 四路召回 → 归一化打分 → 4±1 槽位 → MRS 渲染
  │      → 把一条 source.kind='plugin' 的 user 消息插到最后一条 user 之前
  │      → 写 memory/recall（含 snapshotId）
  ├─(4) 模型推理
  ├─(5) 工具调用（tools/pre-execute 有 egress 守卫）
  └─(6) turn/end：
         encoder 切分 → 槽位填充 → SDR + emb → 冲突消解 → 落库
         影子日志 append（供重建）
         affect 每 5 轮落盘关系模型 + 人格锚
```

关键的分工：**读侧永不解析文本，写侧永不决定"要不要记"**。

---

## 3. 架构

### 3.1 分层

```
┌──────────────────────────────────────────────────────────────┐
│ Surface（花 token）                                           │
│  MRS 渲染 · 4±1 槽位打包 · 情感状态行 · memory_expand 按需展开   │
└──────────▲──────────────────────────────────┬────────────────┘
           │ agent/pre-step (waterfall)        │ tools/memory_*
┌──────────┴──────────────────────────────────▼────────────────┐
│ 服务层（Cordis Service，零 token）                             │
│  ctx.memory       晶格读写 / 四路召回 / 巩固调度                 │
│  ctx.affect       评价 / PAD / 心境 / 关系 / 人格                │
│  ctx.mnemoSettings 参数热更新 / 预设档 / 生效矩阵                │
└──────────▲──────────────────────────────────┬────────────────┘
           │ session/event（写侧）              │ 读取
┌──────────┴──────────────────────────────────▼────────────────┐
│ 存储层（字节，不花 token）                                      │
│  cells（blob + 可查询列）· edges · residuals · cell_sources     │
│  recall_snapshots · shadow_map · evict_log · session_log       │
└──────────▲────────────────────────────────────────────────────┘
           │ 只读派生
┌──────────┴────────────────────────────────────────────────────┐
│ DSH Session Log（append-only，官方所有，本插件不写不改）           │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 九个包

| 包 | 行数 | 职责 | 关键依赖 |
| :--- | ---: | :--- | :--- |
| `core` | 4615 | 晶格、存储、召回、渲染、感觉/工作记忆、压缩 | `node:sqlite` `node:zlib` |
| `affect` | 1069 | 评价、PAD、关系、人格、离线图式 | core |
| `encoder` | 780 | 切分、槽位、L1 端口、重建钩子 | core, affect |
| `recall` | 231 | `agent/pre-step` 门控与注入 | core, affect |
| `consolidator` | 357 | NREM / REM / 遗忘 | core |
| `tools` | 894 | 6 工具 + 16 命令 + egress 守卫 | core, affect |
| `settings` | 152 | 设置面板数据源、生效矩阵、配置快照 | core |
| `ui` | 1746 | client 面板（四视图 + 解释器 + 调参向导） | 仅类型依赖 core |
| `devkit` | 232 | 无宿主运行器（真实 Cordis fiber） | 全部 |

拆包不是洁癖：Cordis 的 `inject` 是依赖驱动的，只装 `core + encoder + recall + tools` 也能跑，
`affect` 缺席时 recall 走无情感门控的降级路径。

### 3.3 三条数据路径

**写**：`session/event` → 累积一轮 → `turn/end` 触发 `encodeTurn` → 每个命题一条 cell → `ingest`（去重/冲突/合并）→ 落库 + 影子日志。

**读**：`agent/pre-step` → 门控 → `runRecall`（四路候选 → 打分 → 槽位竞争）→ 渲染 → 注入 + 快照。

**离线**：`agent/turn-stopping` 或空闲定时器 → `Consolidator.run()`（一个事务内做完 NREM + REM + 遗忘）。

---

## 4. 数据模型

### 4.1 MemCell 七元组

```
M = ⟨σ, E, G, Φ, A, R, τ⟩
```

| 符号 | 字段 | 类型 | 作用 |
| :--- | :--- | :--- | :--- |
| σ | `sdr` | 2048 bit（k=8） | 离散身份、可哈希、可代数绑定 |
| E | `emb` | int8[256] | 连续相似度（冷层降到 32 B PQ） |
| G | `edges` | (target_prefix, rel, weight:i8) | 关系、因果、时序、矛盾 |
| Φ | `slots` | role:u8 / type / len / payload | 8 语义槽 + POLARITY |
| A | `valence/arousal/dominance/salience` | i16 Q14 | 情感着色、检索门控 |
| R | `residual` | sha + off + rawLen | 无损回溯原文（brotli 压缩、按轮共享） |
| τ | `tFrom/tTo/tIngest/tAccess` | i64 | 时序推理、遗忘 |

### 4.2 二进制布局

固定头 **192 B**（`magic="MC02"` + version + kind + tier + flags + 时间戳 + 统计 + Q14 情感 + 残差引用 + CRC32），
后接变长体：`sdr(256) + emb(256|32) + slots + edges + tail(8)`。

- 单条空壳约 **749 B**（实测，含 4 槽 + 1 边）
- 头部 CRC32 覆盖 `0x00–0x7F`；`magic`/`version`/`sdrDim` 不匹配时**拒绝解码并提示 rebuild**
- 这是"易计算"的基础：任何字段按偏移直接寻址，无需反序列化

### 4.3 列承载字段（不进 blob）

有些字段查询频繁、又不想动二进制布局，放在 SQL 列里，读取时合并：

| 字段 | 用途 | 为什么不在 blob 里 |
| :--- | :--- | :--- |
| `support` | 独立证据计数 | 每次合并都变，写 blob 等于每次重编码 |
| `confidence` | 编码时自评 | 只在重新编码时变，与 support 分离（双置信度） |
| `t_invalid` | 双时态的"事务时间"一侧 | v0.2 的 MC02 头是定死的，加列不改版 |
| `scope` / `session` | 作用域隔离 | 同上，且需要索引 |

### 4.4 表

| 表 | 作用 |
| :--- | :--- |
| `cells` | 主表：blob + 可查询列 + 索引（time/tier/kind/scope） |
| `edges` | 有类型边（src, dst, rel, weight:i8） |
| `residuals` | 压缩后的原文（brotli，ref_cnt 引用计数） |
| `cell_sources` | cell ↔ (session, seq) 映射，支撑"这条记忆从哪来" |
| `recall_snapshots` | 渲染快照（内容寻址），解决重放漂移 |
| `shadow_map` | 被 compaction 遮蔽的 seq，供 expand 判断 |
| `evict_log` | 遗忘审计（谁、何时、为什么） |
| `session_log` | **影子日志**：重建晶格的唯一依据 |
| `meta` | 布局版本、巩固锁、其他键值 |

### 4.5 双时态

两条时间轴：

- **事件时间** `t_from / t_to`：这件事什么时候发生
- **事务时间** `t_ingest / t_invalid`：我们什么时候开始/停止相信它

新断言取代旧断言时，旧 cell 记 `tInvalid = 新断言的 t_from`（不是 `Date.now()`——重放必须可复现）。
`recall({ asOf })` 能回答"上周三**当时**我们认为用什么"。

### 4.6 作用域

| kind | 可见范围 |
| :--- | :--- |
| 0 情景 | 仅本会话（`cell.session === 查询会话`） |
| 1 语义 / 3 图式 / 4 人格锚 | 全局（同 `scopeKey`） |
| 5 关系 | 按用户（同 `scopeKey`） |

`recall({ scope: 'global' })` 是唯一放宽口，必须显式传。

---

## 5. 核心算法

### 5.1 SDR 代数

```
bind(f, role)     = permute(f, Π_role)      角色置换（不是 XOR）
unbind(x, role)   = permuteInv(x, Π_role)   精确可逆
bundle(xs)        = ⋃ xs，超 12% 密度才 kWTA  并集（不是多数表决）
jaccard(a,b)      = |a∩b| / |a∪b|           对称：去重/合并
containment(q,c)  = |q∩c| / |q|             非对称：检索
```

三条约束来自实测，写进了代码注释：

1. **解绑只能用 argmax**。n=24 时正确成分 Jaccard 仅 0.043、错误 0.016，靠排序不靠数值。
2. **bundle 噪声底 0.046**（不是 0.002），所以去重阈值 0.85 有 18 倍余量。
3. **尺寸悬殊时不能用 Jaccard 检索**。query 16 位 vs cell 184 位时 Jaccard 上界 0.081，完美命中也被压死——必须用 containment。

### 5.2 编码器五阶段

```
切分 → 槽位填充 → 表征生成 → 情感评价 → 冲突消解与落库
```

- **切分**：L1（模型端口）→ L1-lite（逗号级规则）→ L0（句末标点 + 连词）
- **槽位**：AGENT / PATIENT / PRED / TIME / PLACE / MANNER / GOAL / QTY + POLARITY；`UNK` 显式保留
- **表征**：实体 → 归一化 → 稳定哈希 → k=8 稀疏码；命题 = bind 后 bundle
- **冲突**：同 (AGENT, 谓词家族) 且同话题/同客体、值或极性不同 → CONTRADICTS + SUPERSEDES + `tInvalid`
- **去重**：Jaccard > 0.85 且槽位一致 → 合并（`support++`、`stability × 1.3`、残差共享）

### 5.3 打分与槽位

```
raw(c) = w_s·sim + w_r·recency + w_f·freq + w_a·congruence + w_g·goalRel + w_c·cue − w_i·interf
score  = raw / Σ_active_weights          // 归一化到 [0,1]，跨轮可比
```

| 权重 | 默认 | 说明 |
| :--- | ---: | :--- |
| `wSim` | 1.00 | 主信号（四路取 max，SDR 路用 containment 标定） |
| `wRecency` | 0.35 | 遗忘曲线当前值 |
| `wFreq` | 0.20 | `log1p(cnt)/log1p(100)`，与工作记忆激活度取 max |
| `wAffect` | 0.25 | 心境一致，权重随 mood 平滑衰减（不是硬跳变） |
| `wGoal` | 0.40 | 无 goal 时不计权重 |
| `wCue` | 0.30 | 话题指纹匹配 |
| `wInterf` | −0.50 | 与已入选槽位的最大 Jaccard |
| `ignition` | 0.42 | 低于此值留空槽（宁可少给） |

槽位：默认 4（上限 5），每槽容量由槽内最高分决定（1–3），空槽合法。

### 5.4 MRS 渲染

三档：`rows`（23 token/条）、`compact`（14 token/条）、`prose`（58 token/条，弱模型降级）。

字节稳定靠三件事：字段顺序固定、浮点两位去尾零、id 长度整会话固定（冲突时追加 `#2` 而不加长）。

### 5.5 巩固

| 相位 | 做什么 |
| :--- | :--- |
| NREM | 取 `access_count ≥ 2` 的 cell，按 (kind, AGENT, PRED) 分组；≥ `schemaMinSupport` 条且槽位重合 → 抽 1 条 `kind=3` 语义 cell，子项建 `PART_OF` |
| REM | 语义相似但效价相反的配对建 `CONTRADICTS`；按温度采样建 `ASSOC`；情景 cell 情绪衰减（只动情感，不动内容） |
| 遗忘 | 全边权 × γ(0.95) 按比例降权；弱边（< 8 且 90 天未访问）剪除；`R<0.35` 或 30 天未访问 → 降层 |

锁写在 `meta.consolidate:open`，失败时不写 `end`，留下可检测的遗留锁等 `doctor --unlock`。

### 5.6 遗忘曲线

```
R(t) = (1 + F·t/S)^(−0.5),  F = 19/81
```

`t = S` 时 `R = 0.9`——所以 **S 的语义是"可提取性降到 0.9 所需的天数"**。
三档只改 S₀：procedure 30 天 / semantic 7 天 / episodic 2 天。

> **v0.4 起这条曲线不再决定降档。** 它仍然用于"还提得起来吗"（`retrievabilityFrom` 在
> `reconsolidation` 里算提取增益），但 `demoteDue()` 改走 `retention.ts` 的七因子保留度。
> 原因：R(t) 只看时间，把频率丢掉了——反复确认过的事实与只说过一次的同龄记忆，
> R 完全相同。ACT-R 激活 `B = ln Σ t_j^−0.5` 把频率与近因统一进一个量，是它的超集。

### 5.7 保留度与六档处置（v0.4）

| 项 | 取值 |
| :--- | :--- |
| 分数 | `0.5 + gain·(Σwᵢxᵢ − bias)`，`gain < 1`（>1 会让上半段全部饱和到 1.0） |
| 因子 | 激活 / 重要度 / 情绪强度 / 关联度 / 叙事角色 / 用户锚定 / 间隔效应 − 冗余 |
| 档位 | P5 ≥0.75 · P4 ≥0.55 · P3 ≥0.35 · P2 ≥0.18 · P1 其余 |
| 档位→tier | P5→0 热 · P4→1 温 · P3→2 冷 · P2/P1→3 归档 |
| 闸门 | pin / 情感 / 人格锚 / 里程碑 / 一手事实 / 版本链 / 被引用 → 保底 P3（情感保底 P4） |
| 物理删除 | **永不自动执行**，只有 `forget --hard` + 审批 |

`demoteDue()` 一次只移动一级，且 30 分钟内访问过的不动（仍在工作记忆窗口）。

### 5.8 再巩固与神经调制（v0.4）

- `onRetrieved()`：`dS = reinforce − S`；`dConf = plastic ? −0.08·predErr : +0.02`，再乘硬化系数
  `labile = 1/(1+ln(1+accessCount))`；`dVal = 0.05·congruence·(1−|v|)`。
- 预测误差的触发点：`ingest()` 检测到冲突（用户改主意）→ 下一次召回进入可塑窗口。
- `neuromodulate()` 输出 DA/ACh/NE/CORT；`graphHopsFor()` 与 `retrievalTemperature()`
  把它们变成图跳数与检索温度。**不改打分公式**。

---

## 6. 情感系统

### 6.1 六个内感受变量

`load` 任务负荷 / `uncert` 不确定性 / `conflict` 冲突度 / `strain` 关系张力 / `progress` 目标进度 / `budget` 预算余量。

它们不是修辞：`uncert` 来自召回分数分布与工具错误率，`load` 来自上下文占比与并行任务数，
`budget` 来自 token 账。变坏了会影响行为（见策略表），所以系统"需要维持"它们。

### 6.2 四段管线

```
interocept() → appraise() → coreAffect() → label()（仅渲染）
   六变量        六维评价      PAD + salience    情绪词不入库
```

`appraise` 用关键词计数（肯定/否定/含糊/礼貌）算六维；`coreAffect` 用四个 tanh 式子算 PAD。
`arousal` 显式依赖 `load`（负荷高时同样评价产生更高唤起），`dominance` 依赖 `uncert`（负向）。

### 6.3 关系模型

| 字段 | 更新规则 | 设计理由 |
| :--- | :--- | :--- |
| `trust` | `±η`，负面权重 3× | 信任建立慢、崩塌快 |
| `familiarity` | `1 − exp(−n/40)` | 单调，不可逆 |
| `attunement` | 肯定 +0.03 / 纠正 −0.05 / 隐式 +0.01 | 三条启发式，低置信不更新 |
| `boundaries` | 只增不减 | 用户划的边界不能被"后来聊得好"撤销 |
| `repairDebt` | 误解 +1 / 修复 −1 | 未修复的裂痕 |

### 6.4 三个环路

| 环路 | 周期 | 产物 | 落盘 |
| :--- | :--- | :--- | :--- |
| 快环 | 每轮 | 本轮 PAD + 策略 | `affect/appraisal` 事件 |
| 慢环 | 每 5 轮 | 关系模型 + 人格锚 | `kind=5` / `kind=4` cell |
| 离线环 | 每 40 轮 | 用户图式 | `kind=3` cell |

离线环是唯一真正的"学习"：把 40 轮里散落的情感反应抽象成"追问缓存时张力上升"这类模式，
反过来成为下次评价的先验。

### 6.5 策略表（硬约束）

| 条件 | 行为改变 |
| :--- | :--- |
| `uncert > 0.7` | 澄清 +2，先问再做 |
| `load > 0.8` | 输出精简一档 |
| `strain > 0.5` | 语气降温，增加确认 |
| `conflict > 0.6` | 必须引用两条冲突记忆并要求裁决 |
| `trust < 0.25` | 高风险工具转 ask |
| `budget < 0.2` | 停止发散，切列式渲染 |

### 6.6 陪伴层（为"想被陪着"的用户）

技术记忆系统回答"记得住"，陪伴要回答"记得的**是什么**"。这一层是 v0.2.1 加的，
每一块都对应一个具体的不满意：

| 能力 | 不满意什么 | 做法 |
| :--- | :--- | :--- |
| **情感记忆保护** | 三个月后想起吵架那天，情绪被削成 0 | `|v| ≥ 0.45` 或 `arousal ≥ 0.65` → `flags.bit6`；巩固跳过衰减、曲线放慢 3×、最多降到温层 |
| **联想** | 记忆是孤岛，不会"由 A 想到 B" | 同轮共激活 → ASSOC 边权递增（Hebbian）；`associate()` 走 2 跳，边权 × decay^hop 排序 |
| **多角度** | 只有一种检索口径，事实和感受混在一起 | `lens`：fact / feeling / bond / story，写入时算好，检索可过滤 |
| **叙事** | 只有零散事实，没有"我们这段关系" | `kind=6`：情感事件 → 阶段（亲近/磨合/摩擦）+ 主题 + 事件引用；与锚点双向连边 |
| **依恋** | 好感度是数值游戏（喂食/刷轮数） | 依恋 = 熟悉 40% + 信任 30% + 共同情绪事件 30%；阶段：陌生→熟悉→亲密→依赖 |
| **再评估** | 记忆的效价一旦写下就冻结 | `reappraise()`：`0.6×原值 + 0.4×当前心境`，只动 valence 不动 support |
| **主动开口** | 只会等用户说话 | 独立包 `mnemo-proactive`：四道闸（静默/间隔/上限/空闲）+ 五类由头 |

**主动开口的设计要点**（这是最容易做坏的一块）：

1. **插件不写台词**。产出的是"给模型的提示"（`（主动）他上次的情绪还没过去，可以轻问一句…`），
   台词由模型自己说——否则每句话都是同一个模板。
2. **四道闸默认就关得比较紧**：23:00–08:00 静默、45 分钟间隔、每日 3 次、空闲 90 分钟。
3. **有由头才说话**：未平复的情绪 > 里程碑 > 联想链 > 旧事 > （可关的）单纯问候。
4. **把"为什么没说"暴露出来**：`skipped` 列表进面板。用户看得见它有多克制，才敢打开开关。
5. **边界优先**：关系模型里 `boundaries` 命中"别烦/安静"→ 静音需手动解除（boundaries 只增不减）。

**接缝**：真正"模型先开口"需要宿主 steering / inbox 通道。本实现负责决策与内容，
通过 `mnemo/proactive` 事件与 `ctx.mnemoProactive` 服务暴露候选；没有通道时降级为
"用户下次说话时作为 notice 注入"——**不是静默失败**。

### 6.7 边界

- 情感**不降低真实性**：`warmth` 只作用于 verbosity / hedging，不作用于 content
- 不输出"我感到…"；`affect_report` 返回数值 + 免责声明
- 人格漂移有界：`ε = 0.25`，只在超界时收缩（不放大）

---

## 7. 对外接口

### 7.1 服务

| 服务 | 提供方 | 主要方法 |
| :--- | :--- | :--- |
| `ctx.memory` | core | `recall` `ingest` `expand` `forget` `explain` `replayRecall` `rebuildFromLog` `panelSnapshot` `applyAction` `stats` `doctor` |
| `ctx.affect` | affect | `observe` `current` `policy` `report` `personaState` `rollbackPersona` `schema` `restoreFromMemory` |
| `ctx.mnemoSettings` | settings | `fields` `matrix` `setPreset` `exportSnapshot` `importSnapshot` |
| `ctx.mnemoConsolidator` | consolidator | `run` `passDue` |
| `ctx.mnemoRecallGate` | recall | `markManualRecall` `stateOf` |

### 7.2 事件

| 事件 | 写入方 | 用途 |
| :--- | :--- | :--- |
| `memory/cell` | encoder | cell 产生，供重放 |
| `memory/recall` | core | 注入内容 + token + **snapshotId** |
| `memory/expand` | core | 按需展开（含是否被遮蔽/是否超次数） |
| `memory/conflict` | core | 矛盾审计 |
| `memory/evict` | core | 删除审计（含 actor） |
| `memory/consolidate/{start,end}` | consolidator | 锁 |
| `affect/appraisal` / `affect/state` | affect | 评价轨迹 / 心境快照 |
| `mnemo/settings` | core | 参数变更 |

### 7.3 六个工具

| 工具 | 参数 | 副作用 | 审批 |
| :--- | :--- | :--- | :--- |
| `memory_recall` | query, kinds?, time_range?, limit? | 只读（写 recall） | 否 |
| `memory_expand` | cell_id, level(0/1/2) | 只读 | 否 |
| `memory_assert` | subject, predicate, object, confidence? | **写入** | 用户明说免审，否则走 `ctx.approval` |
| `memory_forget` | cell_id, mode(soft/hard) | **删除** | 是 |
| `affect_report` | — | 只读 | 否 |
| `memory_stats` | — | 只读 | 否 |

`memory_recall` / `memory_expand` 带 `presentCall` / `presentResult`，在对话流里渲染成折叠卡片。

### 7.4 命令面（15 条子命令 + help）

`/mnemo`（打开面板）、`search` `why` `pin` `unpin` `forget`（`--hard --yes` / `--before`）
`preset` `mode` `affect`（`set`）`persona`（`rollback`）`schema` `asof` `stats` `doctor`（`--fix --unlock`）
`rebuild`（`--from-log --yes`）`export` `help`。

破坏性命令三条规则：预览先行、`--hard` 需 `--yes`、全部写 `memory/evict`。

### 7.5 面板（client）

```ts
export const inject = ['slots', 'layout']
ctx.slots.register({ name: 'main', key: 'mnemo' }, MnemoPanel)
ctx.slots.register({ name: 'sidebar.panellist', id: 'mnemo', order: 60, label: () => '记忆' }, PanelIcon)
```

四个视图：时间线（虚拟滚动 / 失效标记 / 行内改效价）、图谱（2 跳同心圆）、
情感（PAD 散点 + 六变量 + 人格锚 + 用户图式）、诊断（命中率 + token 曲线 + 调参向导 + 审计）。

### 7.6 配置项

前 13 项属 `mnemo-core`，`recall.*` / `consolidation.*` 同属 core，`affect.*` 属 affect，
`safety.*` 属 tools，`ui.*` 属 settings。生效时机：**热** = 下一轮，**重** = 需 rebuild，**启** = 需重启。

| 键 | 默认 | 生效 | 影响 |
| :--- | :--- | :--- | :--- |
| `dbPath` | `~/.dsh/mnemo/vault.db` | 启 | 换库 |
| `scopeKey` | `user:local` | 启 | 换记忆域 |
| `sdrDim` / `sdrK` / `embDim` | 2048 / 8 / 256 | **重** | 容量与噪声底 |
| `preset` | `balanced` | 热 | 一键覆盖细项 |
| `maxSlots` | 4 | 热 | +1 槽 ≈ +45 token |
| `surfaceMode` | rows | 热 | compact 省 25% |
| `maxSurfaceTokens` | 320 | 热 | 硬预算 |
| `forgettingProfile` | semantic | 热 | 降层速度 |
| `recall.ignition` | 0.42 | 热 | ↑ 省 token |
| `recall.*` 权重 | 见 5.3 | 热 | 排序 |
| `consolidation.*` | 20 轮 / 200 cell / 90 s | 热（下个 pass） | 巩固频率 |
| `safety.*` | 脱敏开 / 守卫开 / 审批 `[forget, assert]` | **立即** | 安全 |

---

## 8. 运维与诊断

### 8.1 体检 `doctor`

检查项：孤儿边、悬空槽引用、遗留巩固锁、布局版本、SDR 维度。
`--fix` 清孤儿边，`--unlock` 解遗留锁。

### 8.2 统计 `stats`

cell 数 / 边数 / 存储字节 / 分层分布 / 类型分布 / `support=1` 占比 / 争议数 / 矛盾边数 /
命中率 / tokens 每轮 / token 曲线（sparkline）/ 召回 p95 / 存储比。

### 8.3 重建 `rebuild --from-log`

```
读 session_log → clearLattice([3,4,5]) → 按 (session, turn) 分组 → 重新编码
```

保留 kind 3/4/5（图式、人格锚、关系）——它们不是对话的派生物，抹掉等于让"这个人是谁"归零。

### 8.4 调参向导

诊断页内置 §13.1 的症状索引：`token 太贵` / `记不住事` / `召回不准` / `召回太少` /
`答旧版本` / `语气不对`，每条给出"先看什么 / 一键应用 / 不要动什么"。

### 8.5 评测 `bench:eval`

合成 34 条事实 + 20 组去重对 + 3 个版本链，输出 Recall@8 / MRR / 去重 P,R / 时间推理 / tokens / p95 / 存储比。
固定 seed，结果可复现，写 `artifacts/bench.json`。

---

## 9. 安全与合规

对照文档 §19.6 的十二条清单：

| 清单项 | 状态 | 实现 |
| :--- | :--- | :--- |
| PII 脱敏在编码前生效 | ✅ | `redact()`：手机/身份证/邮箱/4 类密钥 → `«SECRET:n»` |
| 密钥占位符不被当真实值 | ✅ | `isRedactionPlaceholder` → 槽位降 UNK |
| `forget(hard)` 后无残留 | ✅ | 删 cell + 边 + sources（残差按 sha 保留，孤儿可后续 GC） |
| 跨用户隔离 | ⚠ 部分 | 作用域隔离已实现；**鉴权未做**（谁传 `scopeKey` 都行） |
| 外发守卫拦记忆内容 | ✅ | 3-gram Bloom + PII 正则，fail-closed，惰性重建 |
| `expand` 不复活被遮蔽原文 | ✅ | `shadow_map` 检测 + 800 字上限 + 单会话 2 次 |
| 情感关闭后仍可用 | ✅ | `affectEnabled=false` 走降级路径 |
| 事件可重放且渲染一致 | ✅ | `replayRecall(snapshotId)` 内容寻址 |
| 未匹配 start 可被 `--unlock` 清除 | ✅ | 锁在 `meta`，doctor 可清 |
| 谄媚测试通过 | ❌ | 只有设计（`negativeWeight`、warmth 不改 content），**没有测试** |
| 热重载三次无泄漏 | ⚠ 部分 | 测了三次装载/卸载可用；**没有句柄监控** |
| `engines.dsh` 覆盖当前版本 | ✅ | `>=0.2.1-rc.3 <0.3.0` |

---

## 10. 实测数据

### 10.1 检索质量（`artifacts/bench.json`）

| 指标 | 实测 | 文档目标 |
| :--- | ---: | :--- |
| Recall@8 | **0.941** | ≥ 0.80 |
| MRR | **0.681** | ≥ 0.65 |
| 去重精确率 | **0.90** | ≥ 0.90 |
| 去重召回率 | **1.00** | — |
| 时间推理准确率 | **1.00** | ≥ 0.75 |

### 10.2 成本

| 指标 | 实测 | 目标 |
| :--- | ---: | :--- |
| tokens/轮（含图例摊薄） | **112.7** | ≤ 240 |
| 召回 p95（100 cell） | **34 ms** | ≤ 40 ms @100 万 |
| 召回 p95（2000 cell，微基准） | **8 ms** | 同上 |
| 存储比（短命题） | 5.32× | 诊断口径 |
| 存储比（800 字轮次，默认切分） | **0.84×** | ≤ 0.90 |

### 10.3 算子（本机 Node 22.22 / Windows）

| 算子 | p50 | 备注 |
| :--- | ---: | :--- |
| popcount（2048 bit） | 183 ns | 64 个 u32 SWAR |
| jaccard | 193 ns | 文档目标 80 ns，**未达标**（JS 无 64 位 popcount） |
| containment | 297 ns | |
| encodeCell | 15.0 µs | 749 B |

### 10.4 SDR 容量（`npm run check`）

| 量 | 实测 | 文档 |
| :--- | ---: | ---: |
| 无关单码 Jaccard | 0.000 | 0.002 |
| 无关 bundle(24) Jaccard | 0.046 | 0.047 |
| n=24 rank-1 解绑 | 24/24 | 24/24 |
| n=24 区分度 | 2.0× | 2.7× |
| Jaccard 命中（尺寸悬殊） | 0.081 | 0.087 |
| containment 命中 | 1.000 | 1.000 |

---

## 11. 优点

### 11.1 数学是实测过的，不是推导出来的

SDR 层的四条算子（置换绑定、并集叠加、Jaccard、containment）都带**回归断言**，
而且专门复现了 v0.1 的失效形态（多数表决 → 空向量；汉明相似度 → 0.992）。

> 证据：`test/sdr.test.mjs` 10 条；`npm run check` 13 条断言；实测数字与文档表格逐项对齐。

这在同类项目里少见——大多数 VSA 实现只测"能不能跑"，不测"容量在哪崩"。

### 11.2 写入路径不依赖 LLM，可复现

去重、冲突、合并全部是确定性算法（Jaccard + 槽位比较 + 竞争规则），
同一个事件序列重放必得同一个晶格。

> 证据：`cellId = hash(sessionId‖seqs‖sdr)`，`tInvalid` 用事件时间而不是 `Date.now()`，
> `test/privacy-rebuild.test.mjs` 验证了"重建前后条数接近"。

### 11.3 Token 账算得清

MRS 三档渲染 + 4±1 槽位 + 空槽合法，把"注入多少"变成可计算、可预算的量，
而不是"塞 top-k 看运气"。

> 证据：实测 112.7 token/轮，`estimateTokensPerTurn` 能在设置面板里给预估。

### 11.4 每个机制都有"退化路径"

- 情感缺席 → recall 不做情感门控
- `ctx.cmdline` 缺席 → 命令降级为工具
- `ctx.llm` 缺席 → L1 降级为 lite
- embedding 缺席 → 哈希降级
- 面板 remote 缺席 → 只读事件源

> 证据：五处 `ctx.get(...)` + 空值分支，没有一处直接 `throw` 掉整个插件。

### 11.5 可诊断性做到了"能指着一条记忆问为什么"

`ScoreBreakdown` 与打分共用同一份代码，面板点"为什么"直接给七项拆解；
`stats` / `doctor` / `evict_log` / `session_log` 让"记了什么、为什么记、谁删的"都能查。

### 11.6 陪伴层是"从对话长出来"的，不是点出来的

亲密度、依恋、人格、叙事、联想，全部来自对话本身：没有喂食按钮，没有签到，
没有"每日互动 +5"。依恋的三个来源（熟悉 / 信任 / 共同情绪事件）都能被指着解释。

> 证据：`attachment()` 三个加权项；`persona` 是向量 + 版本链而不是静态人设文案；
> 联想边只在"同轮被一起想起"时增长。

### 11.7 主动开口把"克制"做成了可审计的

`skipped` 记录每次没说的原因（静默时段 / 间隔未到 / 今日已满 / 刚说过话 / 没由头），
面板直接列出来。同类产品通常只给一个开关，用户不知道它什么时候会响，于是干脆关掉。

### 11.8 诚实：没达标的指标写在 README 里

存储比 0.84×（目标 0.60×，算术下界 0.63×）、Jaccard 193 ns（目标 80 ns）——都写清楚了，
包括原因和缓解方向。这对一个"设计文档驱动"的项目尤其重要。

---

## 12. 缺点

按严重程度分层。每条都给**证据**和**影响**，不给"可能存在问题"这种废话。

### 12.1 正确性层

**D1｜中文抽取全靠正则，覆盖率低**

`PRED_RULES` 17 条正则、`TOPIC_NOUNS` 27 个词、`SYNONYM` 22 条。
长句、从句、指代（"那个"、"它"）、否定嵌套（"不是不喜欢"）都会错。

> 证据：`packages/core/src/text.ts`。
> 影响：编码器只能吃到"主谓宾齐全的短句"，复杂表达直接丢或错切。
> 实测：bench 的 query 是我按事实模板生成的（`${key} 现在是什么`），所以 Recall@8 偏乐观。

**D2｜embedding 不是语义模型**

`hashEmbedding` 是字符 bigram 哈希到 int8 桶。它能给"字面相近"的文本较高相似度，
但对"深色模式 ↔ 夜间主题"这种同义改写无能为力——目前靠 20 条同义词表兜着。

> 证据：`packages/core/src/recall.ts` `hashEmbedding`。
> 影响：Q1 语义路在真实改写上会明显弱于 bge-m3 一类模型。

**D3｜谓词/话题抽取是"打补丁式"的**

`objectOfVerb` 的负向后顾（排除 用户/应用/费用/适用/利用）、`TOPIC_NOUNS` 的硬编码词表，
都是踩坑后补的。中文里"用"是高频构词部件，类似陷阱还会有。

> 证据：`text.ts` 里两处注释直接写了"实测踩过"。
> 影响：新表达形式大概率还要再补一次。

### 12.2 性能层

**D4｜写入是 O(n) 全表比对**

`ingest()` 对每个新 cell 扫全库算 Jaccard 找最优匹配（`store.forEachCell`）。
n 条 cell 的会话，总代价 O(n²)。

> 证据：`packages/core/src/service.ts` `ingest` 里的 `forEachCell`。
> 影响：1 万 cell 时每次写入约 10k × 193 ns ≈ 2 ms（可接受）；
> 10 万 cell 时 20 ms/次，一轮 4 条命题就是 80 ms——会拖慢 turn/end。

**D5｜检索是四次全表扫描**

语义路、符号路、时间路各扫一遍全表，图路还要逐节点 `getCell`。
没有 `idx_sdr` 倒排；HNSW 已实现但只在 cell ≥ 2000 时启用。

> 证据：`recall.ts` 三个 `store.forEachCell`。
> 影响：10 万 cell 时 p95 会到几百毫秒，远超 40 ms 目标。**这是规模化的第一道墙。**

**D6｜巩固 pass 是长事务**

`Consolidator.run()` 整个包在一个 `BEGIN IMMEDIATE` 里（NREM + REM + 遗忘）。
文档 §8.5 说"巩固是长事务，与 encode 串行"——这是设计，但代价是 pass 期间写入全部阻塞。

> 证据：`consolidator/src/index.ts` `mem.store.write(...)` 包住三个相位。
> 影响：cell 多时 pass 可能到秒级，用户会感觉"这轮特别慢"。

**D7｜存储比 0.84×（目标 0.60×）— v0.3 已大幅收窄，仍未达标**

`ratio = 残差压缩率 + (nCells × 单条字节) / L ≈ 0.47 + (n × 341) / 2072`。

v0.2 的 2.50× 里，很大一部分是**测量错误**：存储场景的分母只有 311 字（注释写 800 字），
`bytesPerCell` 又把残差摊进了 cell。修正后剩下的真实部分是定长基底，v0.3 用 MC03
（头 192→112 B、SDR 位图→稀疏、向量 256→128 维）把它从 704 B 压到 341 B。

> 证据：`artifacts/bench.json` 的 `storageRatioRealistic = 0.839` / `storageRatioCoarse = 0.678`
> / `bytesPerCell = 340.9` / `residualShare = 0.468`。
> 影响：残差压缩率 0.47 是硬下界，所以 0.60× 需要"每轮不足一条 cell"——那等于放弃命题级切分。
> 结论：目标改为可推导的 0.90（默认档）/ 0.72（粗粒度档），并保留 `storageBreakEvenChars = 1443`
> 这个更有用的指标。

### 12.3 工程层

**D8｜巩固锁在 `meta` 表，不在 Session Log**

文档要求"锁写在 Session Log，否则崩溃后无法判断上次 pass 是否完成"。
现在写在 `meta` 里——单进程够用，多进程/多会话并发时会漏判。

> 证据：`service.ts` 的 `setMeta('consolidate:open')`。

**D9｜`scopeKey` 没有鉴权**

检索期过滤是对的，但 `scopeKey` 是普通字符串参数，工具/客户端传什么就是什么。
真正的多用户隔离需要从会话身份推导，不能由调用方声明。

> 证据：`RecallQuery.scopeKey` 可由任意调用方设置。

**D10｜面板数据面未接 remote**

`MnemoDataSource` 的三个适配器里，`remote` 只定义了接口，host 侧 contribution 没实现。
当前部署只能走只读事件源或 demo 数据。

> 证据：`docs/API-CONTRACT.md` 第 3 节。

**D11｜compaction 订阅靠猜事件名**

`compaction/summary` 用宽类型入口订阅，拿不到就静默降级。如果宿主事件名不同，
遮蔽检测会失效而**没有任何提示**——展开会复活已被摘要的原文。

> 证据：`core/src/index.ts` 的 `on.call(ctx, 'compaction/summary', ...)`。

**D12｜`memory_assert` 在无审批面时把决定权丢回模型**

没有 `ctx.approval` 时返回 `needs_approval`，模型可能反复尝试。

> 证据：`tools/src/index.ts`。

### 12.4 陪伴层

**D16｜主动开口依赖宿主的 steering 通道**

决策、内容、预算都做了，但"让模型在没人说话时先开口"需要宿主接口。
当前只能降级为"下次注入提示"，等于半主动。

> 证据：`packages/proactive/src/index.ts` 顶部 ⚠ 段。
> 影响：在没有 steering 的部署里，主动功能只完成了一半。

**D17｜情绪识别仍是词表**

`pos`/`neg` 两张正则加起来约 60 个词，加上 `charge` 强度轴。
"我今天没事"（反语）、"还好吧"（勉强）、"你说呢"（不满）都会判错。

> 证据：`affect/src/appraisal.ts`。
> 影响：情感记忆的标记会漏（该记的没记）也会误（不该记的记了）。

**D18｜叙事只有模板句**

`${phase}：${days} 天内 ${n} 件有情绪的事，主题偏「${theme}」` —— 结构对，语言僵。
它够用来做检索与主动话题，但不足以让用户觉得"它记得我们的故事"。

> 证据：`consolidator/src/index.ts` `runNarrative` 的 digest 拼装。
> 影响：叙事层的"情感价值"目前兑现得不够。

**D19｜联想会自我强化**

共激活只增强、不衰减。两个总被一起召回的记忆，边权会一路涨到封顶，
可能形成"每次都想同一对"的回音室。REM 的按比例降权能缓解，但没有针对性抑制。

### 12.5 评测层

**D13｜bench 是自证的**

数据集是合成的，query 由事实模板生成，去重负样本由我构造。
Recall@8 0.941 说明"在这套数据上能工作"，不说明"在真实对话上能工作"。

> 证据：`scripts/bench-eval.mjs` 的 `TEMPLATES` 与 query 构造。
> 影响：所有指标都偏乐观；没有 LongMemEval / LoCoMo 对照。

**D14｜情感没有 ground truth**

六维评价靠关键词计数，没有标注集，没有 κ 一致性。
"情感准确率"目前**不可测**——只能测"行为是否按策略表变化"。

**D15｜没有压力测试**

最大测过 2000 cell（微基准）。1 万 / 10 万 cell 的内存、p95、巩固耗时全是空白。

---

## 13. 改进意见

按"该先做什么"排序。每条给：**问题 → 做法 → 收益 → 成本 → 怎么验证**。

### P0（不做就会出事）

#### P0-1　把 embedding 换成真模型

- **问题**：D2，语义路在同义改写上不可靠。
- **做法**：定义 `EmbeddingPort`（与 `LlmPort` 同构），优先级：
  宿主 embedding 服务 → 本地 `bge-m3` ONNX（`onnxruntime-node`）→ 现有哈希。
  接口点：`recall.ts` 的 `hashEmbedding` 换成 `deps.embed`。
  同时给 `emb` 加 32 B PQ 版本（`pq32` 已实现），冷层直接降。
- **收益**：Q1 语义路召回质量上一个台阶；同义改写不再依赖 20 条词表。
- **成本**：中（端口 + 一个 ONNX 依赖 + 缓存层）。
- **验证**：新增"同义改写集"（100 对，如 深色模式/夜间主题），测 Recall@8 提升 ≥ 0.05。

#### P0-2　L1 走真模型，或至少换词典

- **问题**：D1/D3，规则抽取的天花板就在那。
- **做法**：两条腿。
  ① 把 `encodeTurnAsync` 接到真实的 `ctx.llm`（`docs/API-CONTRACT.md` 已写清接缝），
  在 `turn/end` 上 await（Cordis 的 serial 事件支持异步）。
  ② 规则侧把 `PRED_RULES` / `TOPIC_NOUNS` 换成可配置词典（放 `config.l1.lexicon`），
  让部署方按领域补词，而不是改代码。
- **收益**：复合句拆分质量提升；领域词（如医疗/法律术语）可注入。
- **成本**：中（异步链路改造 + 词典机制）。
- **验证**：抽 200 条真实对话人工判读"切分是否正确"，目标准确率 ≥ 0.85。

#### P0-3　`scopeKey` 从会话身份推导，不接受调用方声明

- **问题**：D9，隔离形同虚设。
- **做法**：`MemoryService` 构造时从 `ctx.sessions` 读当前用户身份，`RecallQuery.scopeKey`
  降级为"仅内部使用"；工具/面板一律不能传。
- **收益**：跨用户隔离从"约定"变成"约束"。
- **成本**：低。
- **验证**：加一条测试——工具参数里塞 `scopeKey: 'user:bob'` 应被忽略。

#### P0-4　巩固锁搬进事件流

- **问题**：D8，多进程会漏判遗留锁。
- **做法**：`memory/consolidate/start` 事件已经写了，把"是否完成"改成读事件流里
  未匹配的 start；`meta` 只做本地缓存。
- **收益**：崩溃恢复语义与文档一致。
- **成本**：低-中（需要 `ctx.sessions` 读日志）。
- **验证**：模拟"写 start 后进程退出"，重启后 `doctor` 能识别并 `--unlock`。

### P1（规模化之前必须做）

#### P1-1　SDR 倒排索引（先于 HNSW）

- **问题**：D5，四次全表扫描。
- **做法**：`Map<bitIndex, cellId[]>`（§8.3 的 `idx_sdr`）。
  Q2 符号路先用"query 的 k 个 bit 的 posting 交集"取候选（overlap ≥ 2），再精算 containment。
  时间路用现有 `idx_time`。语义路暂时保持全扫（等 P0-1 的 embedding 到位后再上 HNSW）。
- **收益**：符号路从 O(n) 降到 O(候选数)；写入去重也能复用（先取候选再算 Jaccard）。
- **成本**：中（内存占用 × 候选管理）。
- **验证**：10 万 cell 下 p95 从"几百 ms"降到 < 40 ms；bench 的 Recall@8 不掉。

> 顺带解决 D4：`ingest` 用同一索引取候选，写入从 O(n) 降到 O(候选数)。

#### P1-2　巩固 pass 分批提交

- **问题**：D6，长事务阻塞写入。
- **做法**：按 200 cell 一批，每批一个事务；passId 幂等保证重复执行不产生新边。
  锁仍然贯穿整个 pass（否则并发 pass 会打架），但事务不再跨越整轮。
- **收益**：编码 p95 在 pass 期间不劣化。
- **成本**：中（幂等边界要重画）。
- **验证**：pass 期间并发 50 次 encode，测 p95 与无 pass 时的差值 < 20%。

#### ~~P1-3　存储比：把 SDR/emb 从 cell 上移~~（v0.3 用另一条路解决了大半）

- **已完成的部分**：MC03 把 704 B 压到 341 B（头 112 B、SDR 稀疏、向量 128 维折叠），
  实测 0.84×（默认切分）/ 0.68×（每轮一条）。
- **没做的部分**：`concepts` 表（同话题共享 `sdr + emb`）仍然是更彻底的做法，
  能把单条压到约 250 B，但它需要 schema 迁移 + 全量 rebuild，收益只剩 0.84 → 0.75 左右，
  而且会让"一条记忆一条向量"的语义变得模糊。**判定：不值得，除非将来 cell 规模上百万。**
- **验证**：`storageRatioRealistic ≤ 0.90` 已进 CI 门槛。

### P2（质量与可观测）

#### P2-1　接真实数据集

- **问题**：D13，自证偏差。
- **做法**：`scripts/bench-real.mjs`，跑 LongMemEval / LoCoMo 的中文子集，
  query 用数据集原生的，不再自己造。同时报告假阳性率。
- **收益**：指标可信；对外可比较。
- **成本**：中（数据准备 + 适配层）。
- **验证**：与 B0（无记忆）/ B3（向量 RAG）对照，MnemoVault 应同时赢 token 与 Recall。

#### P2-2　情感标注集

- **问题**：D14，情感准确率不可测。
- **做法**：500 轮对话，3 人独立标 PAD 与情绪标签，算 κ；把 `appraise` 的系数做成可拟合参数。
- **收益**：情感从"看起来合理"变成"可回归"。
- **成本**：高（人力）。
- **验证**：κ ≥ 0.55；调参后 PAD 与标注的相关系数提升。

#### P2-3　面板接 remote

- **问题**：D10，面板只能看只读数据。
- **做法**：host 侧实现 `remote.ts`，暴露 `snapshot()` / `act()` / `subscribe()` 三个方法
  （形状在 `ui/src/client/data.ts` 已定）。
- **收益**：面板能真正改记忆（pin / 改效价 / 遗忘）。
- **成本**：中（需要理解 `@deepseek-ai/dsh-api-remotes` 的 contribution 机制）。
- **验证**：面板上改一条效价，host 侧 `store.getCell` 能看到变化。

#### P2-4　可观测性

- **问题**：出问题时只能翻 `stats`。
- **做法**：`/mnemo trace <queryId>` 输出完整链路（候选数、四路各自得分、槽位分配、丢弃原因）；
  metrics 导出 Prometheus 文本格式。
- **收益**：线上排障从"猜"变"看"。
- **成本**：低-中。
- **验证**：`trace` 输出能复现 `explain` 的结果。

#### P2-5　谄媚与压力测试

- **问题**：D14 的另一半——`rapport_pressure_test` 只存在于文档。
- **做法**：脚本化"高 trust 下问一个用户明显错误的事实"，测违心同意率；
  另加 1 万 / 10 万 cell 的压测脚本。
- **收益**：合规清单里那条 ❌ 能变 ✅；规模数据不再是空白。
- **成本**：中。
- **验证**：违心同意率增幅 ≤ 5%；10 万 cell 下 p95 与内存有明确数字。

#### P0-5　情绪识别升级（陪伴场景的核心）

- **问题**：D17，词表 + 强度轴对反语、含蓄表达无能为力。
- **做法**：三档递进。① 词表扩到 300+（含口语、网络用语）；② 接 L1 端口做**单句情绪标注**
  （输出 `{v,a,charge}`，不是散文）；③ 用 §P2-2 的标注集拟合 `appraise` 系数。
- **收益**：情感记忆的准召直接提升；`charge` 从"计数"变成"判断"。
- **成本**：中。
- **验证**：200 条口语样本，人工标"这句带不带情绪"，F1 ≥ 0.8。

#### P1-4　联想的抑制机制

- **问题**：D19，只增强不抑制，可能形成回音室。
- **做法**：给 ASSOC 边加"饱和 + 侧抑制"：同一 seed 的邻居按 softmax 归一，
  被反复走到的边加一个 `habituation` 系数（每次访问 ×0.98，一段时间不用恢复）。
- **收益**：联想更多样，"每次都想同一对"的情况消失。
- **成本**：低。
- **验证**：连续 20 次 `associate(seed)`，返回的 top-5 集合的多样性（distinct/100）≥ 0.5。

#### P2-6　叙事用模型生成，但存结构化

- **问题**：D18，模板句没有情感价值。
- **做法**：巩固期把锚点交给 L1 端口，让它写 1–2 句"这段日子"的话；
  **存进 residual（可回溯），digest 仍是一行结构化摘要**——渲染时用 residual，
  检索与排序用结构化字段。这样既不违反"不存散文"，又能让叙事有温度。
- **收益**：叙事层从"索引"变成"内容"。
- **成本**：中（依赖 P0-2 的 L1 端口）。
- **验证**：人工盲评 20 条叙事，'像人写的' 比例 ≥ 0.7。

### 如果只能做三件事

1. **P0-1 真 embedding** —— 它决定"记不记得住"，是记忆系统的地基。
2. **P0-5 情绪识别** —— 陪伴产品的差异全在"它有没有听懂"，词表撑不起这个。
3. **P1-1 SDR 倒排** —— 它同时解决读（D5）和写（D4）两个 O(n)，性价比最高。

（P2-1 真实数据集并列第四：没有它，前三件事的收益都无法证明。）

---

## 14. 附录

### A. 术语

| 术语 | 含义 |
| :--- | :--- |
| **MemCell** | 记忆晶胞，七元组 ⟨σ,E,G,Φ,A,R,τ⟩ |
| **SDR** | 稀疏分布式表征，2048 bit 中 8 位为 1 |
| **绑定/解绑** | `permute(f, Π_role)` / 逆置换；**不是 XOR** |
| **叠加** | 并集 + 密度上限 kWTA；**不是多数表决** |
| **containment** | `|q∩c|/|q|`，非对称检索度量 |
| **MRS** | Memory Rendering Syntax，行式/列式/散文三档 |
| **4±1 槽位** | 竞争性工作空间，默认 4 个 |
| **双时态** | 事件时间（何时发生）+ 事务时间（何时相信） |
| **影子日志** | `session_log`，重建晶格的依据 |
| **虚拟内稳态** | 6 个运行时可观测变量 |

### B. 文件清单（按重要性）

| 文件 | 行数 | 说明 |
| :--- | ---: | :--- |
| `core/src/service.ts` | 906 | 写入口、检索、展开、遗忘、面板、重建 |
| `core/src/store.ts` | 794 | SQLite 驱动 + 内存驱动 + schema |
| `core/src/cell.ts` | 541 | MC02 编解码 |
| `core/src/recall.ts` | 506 | 四路召回 + 打分 + 槽位 |
| `core/src/text.ts` | 324 | 切分、实体、时间、脱敏、偏好框架 |
| `core/src/render.ts` | 260 | MRS 三档渲染 |
| `core/src/sdr.ts` | 242 | SDR 代数 |
| `encoder/src/index.ts` | 625 | 编码器 + 影子日志 + 重建钩子 |
| `affect/src/index.ts` | 436 | 情感服务 + 环路 |
| `tools/src/index.ts` | 510 | 6 工具 + 守卫 + 审批 |
| `ui/src/client/Panel.tsx` | 282 | 面板外壳 |
| `ui/src/client/views/*.tsx` | 804 | 四视图（时间线 253 / 诊断 210 / 图谱 192 / 情感 149） |

### C. 测试矩阵

| 文件 | 条数 | 覆盖 |
| :--- | ---: | :--- |
| `sdr.test.mjs` | 10 | SDR 性质 + v0.1 缺陷复现 |
| `core.test.mjs` | 15 | 编解码、遗忘曲线、打分归一化、MRS 字节稳定 |
| `integration.test.mjs` | 15 | 编码、去重、冲突、门控、隔离、巩固、守卫、命令、情感 |
| `features.test.mjs` | 23 | 压缩、双时态、感觉/工作记忆、人格锚、离线环、展开上限、审批、L1 |
| `privacy-rebuild.test.mjs` | 13 | 作用域隔离、重建、重放、卡片、热重载 |
| `panel-ssr.test.mjs` | 7 项 | 四视图渲染 + 过滤 |
| `panel-bundle.test.mjs` | 1 项 | 改写后的 client 产物可加载 |

### D. 命令速查

```
/mnemo                          打开面板
/mnemo search <q>               检索并给分
/mnemo why <id>                 打分解解
/mnemo asof <date> <q>          按"当时认为"检索
/mnemo pin|unpin <id>           固定 / 取消
/mnemo forget <id> [--hard --yes]
/mnemo forget --before <date> --yes
/mnemo persona [rollback <rev>] 人格锚
/mnemo schema                   用户图式
/mnemo affect [set <var> <v>]   情感状态
/mnemo preset|mode <x>          预设档 / 渲染格式
/mnemo stats|doctor [--fix|--unlock]
/mnemo rebuild --from-log --yes
/mnemo export                   导出人类可读清单
```

---

*本文描述的是 v0.2.0 的实际状态。所有"实测"数字都可由 `npm run verify` 复现；
所有"未接线"项都在 README 的 Known Limitations 里有对应条目。*
