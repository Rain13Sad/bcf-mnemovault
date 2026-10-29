# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

本项目基线是 DeepSeek Harness `0.2.1-rc.3`（Developer Preview，宿主本身存在破坏性变更），
所以 `0.x` 期间 minor 升级也可能不兼容。

## [0.3.0] — 2026-10-29

处理 v0.2 遗留的六个问题（存储比 / L1 端口 / embedding / HNSW / `ctx.remote` / 命令面），
并按 DSH 记忆插件的版式重做侧栏面板。**存储布局升到 MC03，旧库需 `/mnemo rebuild --from-log`。**

### 存储：MC03 与存储比

- **存储布局 MC03**（`cell.ts`）：头 192 → 112 B（时间戳 i64 → u48、浮点按量纲降位、
  槽位/边计数 u8）；SDR 从定长位图（256 B）改为稀疏索引 + 差分变长整数（无损，且不再随
  `sdrDim` 膨胀）；向量落盘维度 256 → 128（`embStoreDim`，计算仍在 256 维哈希空间后折叠）。
  单条 cell 从 844 B 降到 **341 B**。`decodeCell` 仍可读 MC02。
- **冷层 PQ 修复**：`pq32` 改为先按最大绝对值归一化再取 4 bit。此前哈希向量的分量只有
  ±4…±8，`avg/16` 全部取整为 0，冷层向量变成零向量——冷记忆在语义路上永远拿 0 分。
- **`cosine` 支持不等长向量**：短的一侧按 PQ 语义展开后比较（同样是"冷层零分"的根因）。
- **元数据 cell 改 upsert**：人格锚 / 关系模型 / 图式走 `memory.upsertMeta(key, cell)`，
  按稳定 key 覆盖。此前它们走 `ingest`，每轮都判出"冲突"并新增一行。
- **残差压缩档 5 → 9**：2.4 KB 上 2 ms，压缩率 0.525 → 0.468。
- **长度感知的切分预算**：`encoder.cellsPerTurnChars`（默认 600），
  一轮 800 字最多 2 条 cell；设为 0 退回纯 `maxCellsPerTurn`。
- **bench 修复两处测量错误**：存储场景的分母只有 311 字（注释写的是 800 字），
  `bytesPerCell` 把残差摊进了 cell。新增 `storageRatioCoarse` / `bytesPerCell` /
  `residualShare` / `storageBreakEvenChars` 四项分解指标。
- **存储比进 CI 门槛**：`storageRatioRealistic ≤ 0.90`、`storageRatioCoarse ≤ 0.72`。
  实测 0.839 / 0.678（v0.2 为 2.50×）。

### 检索

- **HNSW 实现**（`core/src/ann.ts`）：确定性层高（id 哈希，重建得到同一张图）、
  墓碑删除 + 20% 阈值重建、`BruteIndex` 同接口。`cell < 2000` 仍走精确扫描。
- **语义路接入索引**：`runRecall` 通过 `deps.ann` 取候选，多取一倍以抵消作用域过滤；
  `memory.annOverlap(k)` 可抽样比对 ANN 与精确扫描的重合度。
- **embedding v2**：字符 bigram 骨架 + 24 组同义词族桥接 + 标识符整体成词 + sublinear TF。
  Recall@8 保持 0.941，MRR 0.686 → 0.681（128 维落盘）。
- 新增 `EmbeddingPort` 与 `quantize()`（宿主 embedding 服务的接口，尚未接线）。

### 编码与接线

- **`fromHostLlm` 扩到 8 种入口 × 4 个嵌套路径**，返回结构支持字符串 / `{text}` /
  `{content}` / `{choices[0].message.content}` / 异步迭代器；新增 `probeLlmPort()` 启动自检。
- **`turn/end` 走 `encodeTurnAsync`**：端口可用时用模型切分，异常自动回退同步路径。
- **`ctx.remote` 接线**：host 侧 `ctx.provide('mnemoRemote', …)` + 四种注册表形状探测；
  新增 `mnemoSnapshot`（只读兜底）与 `mnemoCommands`（面板按钮命令桥）。
- **命令面探测四种形状**，全不中才降级为 `mnemo_command` 工具。
- **`RuntimeStatus`**（`ctx.provide('mnemoRuntime')`）：L1 / ANN / 命令面 / remote / 工具清单
  集中登记，面板与 doctor 读同一份。

### 面板

- **重做为六个页签**：记忆总览 / 记忆检索 / 记忆整理 / 收件箱 / 情感状态 / 设置。
  总览页含存储路径卡、8 个指标格、8 类分类统计、索引状态、标签云、四列最近列表、
  后端能力与已注册工具；收件箱支持确认 / 忽略 / 矛盾裁决；设置页标注每项的生效时机。
- **`PanelSnapshot` 新增** `runtime` / `index` / `tags` / `categories` / `recentNew` /
  `recentUpdated` / `pending` / `consolidation`（全部可选，旧快照仍能渲染）。
- **`PanelAction` 新增** `consolidate` / `rebuild` / `doctor` / `confirm` / `dismiss`。
- **修复侧栏宽度 bug**：`.mnv-root` 作为 flex 子项时 `min-width` 默认是 `min-content`，
  会把 320–420 px 的侧栏顶宽、右边被裁掉。
- 面板预览支持 `#overview` / `#search` / … 直接定位页签。

### 测试与工具

- 测试 93 → **109**：新增 `test/ann.test.mjs`（6 条：HNSW 重合度 / 可复现 / 删除 / 空索引 /
  PQ 余弦 / 折叠保序）、`test/bridge.test.mjs`（9 条：L1 形状 / 自检 / remote 面 / 命令面），
  面板 SSR 冒烟覆盖全部新视图。
- 修复 `test/companion.test.mjs` 的日期炸弹：`at()` 写死 `2026-10-28`，跨过午夜后
  `snapshot()` 会因 `lastDay` 变化把 `todayCount` 归零，该用例必挂。
- 新增 `devkit` 的 `encoder` 配置覆盖，供 bench 做切分粒度对照实验。

## [Unreleased]

### 新增

- **多语言 README**：`README.md` 改为英文首页，新增 `README.zh-CN.md`（完整版）、`README.ja.md`、
  `README.ko.md`、`README.es.md`（摘要版），首页顶部带语言切换。
- **仓库视觉**：`docs/assets/banner.svg`（横幅）、`pipeline.svg`（写入/读取/离线三条链路示意图）、
  `social-preview.png`（1280×640，用于 GitHub Social preview）。
- **CI 门槛**：`scripts/ci-assert-bench.mjs`，把 README 的指标变成会失败的断言。
- `CONTRIBUTING.md` / `SECURITY.md` / `docs/PUBLISH.md` / `docs/README.md`。

### 变更

- 仓库地址统一为 `Rain13Sad/bcf-mnemovault`（此前文档里写的是占位名 `mnemo-vault`）。
- 面板构建与伺服拆分为 `scripts/panel-build.mjs` + `scripts/panel-dev.mjs`，并加 `pretest` 钩子——
  原先 `test/panel-bundle.test.mjs` 依赖一个会起服务器且不退出的脚本，CI 无法通过。
- 文档改用 ASCII 文件名（`docs/项目说明书.md` → `docs/PROJECT-GUIDE.md`），中文标题保留在正文。
- 每个包补齐 `repository.directory` / `homepage` / `bugs` / `keywords` / `publishConfig`。

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
