# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

本项目基线是 DeepSeek Harness `0.2.1-rc.3`（Developer Preview，宿主本身存在破坏性变更），
所以 `0.x` 期间 minor 升级也可能不兼容。

## [0.2.0] — 2026-10-28

首个公开版本。10 个包 / 93 条测试 / 4 项基准指标。

### 新增

- **晶格与存储**：`MemCell` 七元组、MC02 定长头（192 B）+ 变长体 + CRC32、`node:sqlite`（WAL + `BEGIN IMMEDIATE`）零原生依赖。
- **稀疏码代数**：D=2048 / k=8、角色置换绑定、并集叠加 + kWTA 上限 12%、Jaccard 去重 + containment 检索（噪声底 0.09 的固定线性标定）。
- **四路召回与 4±1 槽位**：SDR / 向量 / 图 / 时间四路合并打分，空槽合法、组块化、冗余惩罚；归一化到 [0,1]。
- **MRS 渲染**：rows / compact / prose 三种表面，字节稳定；稳态约 116 token/轮。
- **双时态版本链**：`cell.tInvalid`（事件时间）+ `recall({asOf})` + `/mnemo asof`。
- **感觉记忆与工作记忆**：`SensoryRing`（TTL 2 轮、64 KB、不落盘）、`WorkingSet`（上限 16、turn 结束释放引用），工作记忆激活度并入 `freq` 打分。
- **双相巩固**：NREM 抽象 / REM 发散 + 锁 + 遗忘；遗忘曲线为幂律 `R = (1 + F·t/S)^-0.5`。
- **情感内核**：七维评价（含 `charge` 强度）→ PAD → 心境 → 关系模型 → 人格锚；`kind=3/4/5` cell 落盘，重启可恢复。
- **陪伴层**：情感记忆保护（`flags.bit6`）、共激活联想（Hebbian）、四视角 `lens`、叙事层（`kind=6`）、依恋阶段、情感再评估。
- **主动开口**（新包 `mnemo-proactive`）：四道闸（静默时段 / 最小间隔 / 每日上限 / 空闲）+ 五类由头，产出给模型的提示而非台词；`skipped` 记录"为什么没说"。
- **侧栏面板**：时间线 / 图谱 / 情感 / 诊断四视图，调参向导（症状 → 参数 → 一键应用），"为什么召回这条"打分拆解，host 与 client 两侧格式化实现对拍。
- **运维与安全**：作用域隔离、`session_log` 影子日志 + `/mnemo rebuild --from-log`、`memory.replayRecall(snapshotId)` 重放一致性、egress 守卫（惰性 Bloom）、PII 脱敏、条件审批。
- **评测**：`mnemo-bench`（Recall@8 / MRR / 去重 P,R / 时间推理 / token 成本）+ SDR 性质校验 13 项。

### 修复

写实现时跑出来的缺陷（类型检查抓不到的那一类）：

- 合并时若用新 cell 覆盖会留下旧 cell → 同一事实两条记录。改为永远保留先写入的 `cell_id`。
- egress 守卫在插件装载时建 Bloom（那时库是空的）→ 永不生效。改为按 cell 数惰性重建。
- `setConfig` 被 `applyPreset` 覆盖 → 改任一细项即视为 `preset='custom'`。
- 冲突检测漏判：`prefers/dislikes`、`uses/changes/deploys` 需谓词家族归一；且必须只与仍然有效的版本比较并取最新一条（否则 `pnpm→npm→bun` 的链式取代会断在中间）。
- `objectOfVerb` 把"用户用 pnpm"的宾语抽成"户用" → 两条不同事实被误合并。加负向后顾 + 拉丁优先 + 逐候选回退。
- `isQuestion` 用关键词判疑问句 → "感觉自己什么都做不好"（含"什么"）被整句丢弃。改为句式判据。
- 情感词表里裸的"好/对/差"命中"不好" → 否定句算正向。改为短语匹配（很好 / 不好）。
- `emotional` 判据误用 `salience ≥ 0.75`，而 `salience` 经 tanh 归一后基线就在 0.7 → 每条事实都被标成情感记忆。改为只用 `|valence|` 与 `arousal`。
- `tInvalid` 用 `Date.now()` 而非事件时间 → 重放不可复现、`asOf` 出现假阴性。
- `segmentLite` 把"部署走预发环境"当无谓词片段合并掉（谓词表缺"走"）、"…吗"未识别为疑问句。

### 已知问题

- **存储比 2.50×（800 字轮次），文档目标 0.45–0.60×。** 命题级切分把 704 B/cell 的定长基底放大 2–4 倍。详见 README「一个没达标的指标」。
- L1 抽取只有"规则增强"版在跑；`LlmPort` / `encodeTurnAsync` 已就绪但宿主 `ctx.llm` 的调用形状未实机验证。
- embedding 是字符 n-gram 哈希（稳定但非语义）；HNSW 未实现（10 万 cell 内精确扫描更快）；`ctx.remote` 面未接线。
- 静态加密未实现（见 [SECURITY.md](SECURITY.md)）。

### 参考

设计推导见 [`docs/design/MNEMOVAULT-DESIGN.md`](docs/design/MNEMOVAULT-DESIGN.md)；
实现取舍与 15 条缺点见 [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md)。
