# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

本项目基线是 DeepSeek Harness `0.2.1-rc.3`（Developer Preview，宿主本身存在破坏性变更），
所以 `0.x` 期间 minor 升级也可能不兼容。

## [0.4.0] — 2026-10-30

v0.3 有两处"说不清"的地方：**为什么这条该留、那条该走**，以及**为什么难过的事会被忘掉**。
两者都不是实现细节，而是没有机制——判据只有最后访问时间，情绪事件只是一个带半衰期的数组。
0.4 换掉这两处，并且让每一处都能被测试断言。

向后兼容：**存储布局不变（仍是 MC03）**，旧库不需要 rebuild；新增的 `PanelSnapshot.retention`
是可选字段，旧快照仍能渲染。

### 新增 · 保留度（`core/src/retention.ts`）

- **ACT-R 激活** `B = ln Σ (t_now − t_j)^(−0.5)`：把频率与近因统一进一个量，
  替代只看 `tAccess` 的判据。库里只存 `accessCount/tAccess/tIngest`，
  因此把 n 次提取视为在区间内均匀分布逐项求和（n=1 时与定义完全一致），
  并对近期项补一项 0.5 权重修正——是可解释的近似，不是拍出来的数字。
- **七因子加权**：激活 / 重要度 / 情绪强度 / 关联度 / 叙事角色 / 用户锚定 / 间隔效应 − 冗余，
  三档权重（lean / balanced / fidelity），`fidelity` 把情绪强度提到最高。
- **六档处置**：P5 保持 / P4 压缩 / P3 摘要化 / P2 归档 / P1 墓碑 / **P0 物理删除永不自动执行**。
- **六道"永不删除"闸**：pin、情感记忆、人格锚、关系里程碑、用户亲口一手事实、版本链环节、
  仍被引用。命中者保底 P3（情感记忆保底 P4），**不**保底热层——初版写成"保底 P4"，
  结果所有用户发言都永远温热，六档退化成两档，已在实现中修正并写进设计文档。
- `demoteDue()` 改走新公式，一次 pass 只移动一级；只在 tier 真的变化时写库。

### 新增 · 再巩固（`core/src/reconsolidation.ts`）

- 提取即强化（测试效应）+ 预测误差 > 0.4 时进入可塑窗口（`confidence` 下降）
  + 心境一致性轻微改写效价 + 反复提取后的"硬化"系数。
- 接入 `recall()`：被召回的 cell 走 `onRetrieved()` → `applyReconsolidation()`，
  变更写入 `reconsolidationLog`（面板保留度页展示）。
- 预测误差的触发点是 `ingest()` 的冲突检测（"用户改主意"是唯一确定的不符信号）；
  `predictionErrorProxy()` 已实现但未接线——不把它说成真预测误差。

### 新增 · 神经调制（`core/src/neuromod.ts`）

- DA δ / ACh / NE / CORT 四个标量，全部由已有量算出，**不新增模型调用**。
- 只作用于全局增益：编码初值、图跳数、检索温度。**不改打分公式**，bench 基线不受影响。

### 新增 · 生命周期抽象（`core/src/lifecycle.ts`）

- `abstractCandidates()`：≥3 条情景 + 同 (AGENT, PRED) + 同话题 + 跨度 > 1 天 → 图式候选。
- `nextTier()`：逐级降档，杜绝"热层直接掉到归档"这种无法解释的跳变。

### 新增 · 情绪事件机（`affect/src/episode.ts`）

- **OCC 分类器**：22 类标签里判据互斥的子集，纯函数，不调 LLM。
- **五态状态机** `open → acknowledged → attended → resolved / dormant`。
- **规则 1**：`open` 状态强度只增不减（`peak + 0.05·ln(1+Δt/H)`）——这就是"不遗忘"的机制保证。
- **规则 2**：`neglectQueue()` 提供独立高优先槽，不参与 4±1 竞争。
- **规则 3**：`derivePolicy()` 在效价 < −0.3 或存在未平复事件时强制
  `requireAcknowledgment`、禁止发散、至少问一句。`AffectPolicy` 新增两个可选字段。

### 变更 · 面板（`ui`）

- **横屏布局**：`@container (min-width: 760px)` 把顶部页签换成左侧导航栏 + 双列内容；
  窄于 760 px 自动退回 v0.3 形态。判据是**容器宽度**而不是视口宽度。
- **新增「保留度」页签**：六档分布、逐条七因子柱状分解、DA/ACh/NE/CORT 四信号与检索温度、
  再巩固日志。旧快照（无 `retention` 字段）降级为说明页，不会白屏。
- 总览页在宽屏走双列，四列"最近"面板跨两栏。
- `KIND_LABEL` 补上 `6: 叙事`（v0.3 漏了，面板上显示成"事实"）。

### 修复 · 存储与性能

- `resolveByPrefix` 从"每条边一次全表扫描"改为 `Store.findByPrefix()` +
  `CREATE INDEX idx_cells_prefix ON cells(substr(cell_id, 9))`（低 32 位 = 末 8 位 hex）。
  2000 cell / 4 条边：425 ms → 亚毫秒级。MemoryStore 同步实现。
- `service.ts` 清理：`demoteDue` 只取一次边表建度数索引，不再每条 cell 单独查。

### 测试

- 新增 `test/v04-retention.test.mjs`（20 条）：ACT-R 单调性、90 天重要事实仍在 P4 以上、
  情感记忆拉回热层、六道闸逐条命中、逐级降档、再巩固的置信度下降与硬化、
  神经调制的图跳数与温度、抽象判据的"同一天说三遍不算规律"、
  未回应情绪强度上升、前缀查询（MemoryStore + SqliteStore）、面板快照带保留度。
- `panel-ssr.test.mjs` 增加保留度页（含无 `retention` 字段的旧快照）。
- 总数 115 → **135**，全绿。

### 文档

- 新增 `docs/design/V0.4-PLAN.md`：三份输入文档 → 可执行条款的映射、对标项目取舍、
  模块设计、任务分配、**明确不做什么**。
- 新增 `docs/releases/v0.4.0.md`。
- README（英/中）重写面板章节，补三张截图、v0.4 亮点表、与 Mem0/Zep/Letta 的对照。

---

## [0.3.1] — 2026-10-29

修 v0.3.0 的**发布事故**与两次外部审查指出的问题。v0.3.0 在技术上是进步的，
但它**装不上**：`npm ci` 直接失败，`npm install` 后编译报错——一个 8 处字符串的问题
让整个版本不可用。这一版先把它修好，再补安全与正确性。

### 发布工程（v0.3.0 不可安装）

- **修 8 个 `package.json` 的兄弟依赖**：`^0.2.0` → `^0.3.1`。semver 里 `^0.2.0` 不含 0.3.0，
  于是 `npm ci` 报 "Missing from lock file"、`npm install` 会从 registry 拉真正的 0.2.0
  副本装进子包，affect/consolidator 就近解析到旧 core → `TS2339: 'upsertMeta' does not exist`。
- **重新生成 `package-lock.json`**，并在干净目录实测 `npm ci && npm run build` 10 包全过。
- **新增 `scripts/ci-check-publish.mjs`**：校验 10 个包版本一致、兄弟依赖范围恰好是 `^<同版本>`、
  lockfile 同步。已接进 CI 与 `npm run publish:all`——这类问题不该再靠人记得。
- `engines.node` 从 `>=22.5` 改为 `>=22.13`（22.5–22.12 的 `node:sqlite` 需要
  `--experimental-sqlite` 标志，按 README 装 22.5 会直接跑不起来），并在加载失败时给明确报错。

### 安全（两条 P0 连续两版未修）

- **PII 脱敏贯穿全部派生字段**。`buildCell` 里的实体抽取、槽位填充、向量、话题指纹
  原来读的都是**原文**，只有 digest 用了脱敏文本——于是"摘要里是 «SECRET:1»、
  旁边的槽位里是完整手机号"，而槽位会经 `kvPairs()` 直接渲染进模型上下文。
  现在从入口起只用脱敏文本，槽位出口还有一道 `scrubSlots()` 兜底。
- **PII 规则从 7 类扩到 11 类**：补 IP、银行卡（Luhn 校验，避免误伤订单号）、
  PEM 私钥块、Bearer token、URL query token。
- **影子日志也脱敏**：`session_log` 存的是重建依据，重建用的编码器读脱敏文本，所以存脱敏版本等价且不落第二份明文。
- **`forget(hard)` 真删残差**：新增 `releaseResidualRef()`，按 sha 检查是否还有 cell 引用
  （残差按轮共享，不能用 `ref_cnt` 判断），没有则物理删除；`deleteCell` 自动调用。
  `doctor` 新增"孤儿残差"检查与 `--fix` 清理。**GDPR 删除权在这条路径上才真正成立。**
- **`memory_forget` 走审批**：物理删除永远要审批，没有审批面时直接拒绝（v0.3 之前
  `requireApprovalFor` 默认含它但 execute 从不检查，模型一句 `mode:"hard"` 就能删）。
  `mnemo_command` 工具通道**禁止** `forget --hard`（模型能自己发 `--yes`）。
- **egress 守卫改 fail-closed**：白名单之外一律扫（含不认识的工具名）。
  旧正则只认下划线分词，`webSearch` / `WebSearch` / `execute_shell` / `write_file` / `send_email` 全部漏过。
- **去掉 UI 的 XSS 面**：`Timeline` 的解释器渲染不再用 `dangerouslySetInnerHTML`，
  改为构造 React 节点（旧实现只转义 `&` 和 `<`，`>` 与引号没转义，而解释器文本含用户可控内容）。
- `memory_assert` 入库前脱敏（之前只有 encoder 路径脱敏）。

### 正确性

- **主动开口的只读接口不再有写副作用**（审查用一个最小场景证伪了 v0.3 的"修法"）：
  `snapshot()` 里调 `blockedBy()` 会顺手把 `todayCount` 清零，于是**用户打开面板看一眼，
  当日配额就没了**。现在读写分离：跨日滚动只在 `fire()` / `tick()` 里发生，
  `blockedBy()` 变成纯函数。补了显式的跨午夜回归用例（不再靠"把测试日期改成今天"绕开）。
- **主动开口状态落盘**：`lastAt` / `todayCount` / `mutedUntil` 写进 `meta`，重启不再清零
  （之前重启即绕过每日上限与静音）。`fire()` 自己也会校验频率/静音/上限。
- **`dayKey` 改用本地日期**：原来用 `toISOString()`（UTC）而静默时段用本地小时，跨时区日限错乱。
- **`tick` 门槛 0.45 → 0.3（可配）**：`pickMemory`(0.42) 与 `pickSilence`(0.3) 之前永远走不到 tick，是死路径。
- **边界词静音**：头注释承诺过"boundaries 命中静音词 → 静音"，一直没有实现，现在实现了（7 天）。
- **打分里 `moodW` 被乘了两次**：`rawParts.affect` 与 `weights.affect` 各乘一次，
  得到 `wAffect × moodW² × congruence`，心境影响被平方放大，面板上"0.62 × 1.00"与实际贡献对不上。
  现在只在 weights 里乘一次。
- **写入 seq 差一**：`buildCell(..., seq++)` 配 `ingest(..., { seq })`，cellId 用自增前的值、
  来源记录用自增后的值——从 `session_log` 重放会算出**不同的 cellId**，直接违反"写入可复现"。
- **三处 `Math.random` 改确定性**：REM 联想采样（改为 `hash(passId, seed, target)`）、
  `queryId`（改为文本+时间+库大小的哈希）、主动开口挑记忆（改为哈希取模）。
  同一段日志跑两遍 `rebuild` 现在得到同一组边。
- **边改存完整 64 位 `dst`**：32 位前缀在 10 万 cell 下期望碰撞 ≈1.2 对，而 `resolveByPrefix`
  只取第一个匹配——边可能静默指向另一条 cell，且每条边一次全表扫描。创建边的地方本来就知道完整 id。
- **`runRecall` 返回真实 `snapshotId`**：之前是硬编码空串，只有经 `service.recall()` 才被填上，
  裸调拿不到可重放的 id。现在两侧共用内容寻址函数 `snapshotIdOf()`。
- **英文句号切分**：`SPLIT_RE` 不含 `.`，`I use pnpm. I like dark mode.` 会粘成一条命题。
  补上 `.` 并排除小数点/缩写/省略号。
- `compete()` 接进并列裁决（定义了从未调用），删除 `cellToRow` / `rowToCell` / `hash64Local` 三处死代码。

### 性能

审查实测指出"99.9% 的耗时不在 Jaccard，而在存储层"，并给了三个常数因子。逐条修：

- **prepared statement 缓存**（38 处 `prepare()` 全部无缓存）。
- **`forEachCell` 单查询 + `.iterate()` 流式**：之前是 `SELECT cell_id, blob` + 每行一次
  `hydrate` 点查（N+1 条 SQL）。
- **`getCell` 合并为单趟 SQL**（blob 与列承载字段一起取）。
- **`PRAGMA busy_timeout = 5000`**：WAL 下并发写不再直接抛 `SQLITE_BUSY`。
- **面板快照节流**：`publishPanel()` 之前**每次召回**都同步重建整份快照（全量 cell 视图 +
  doctor 两次全扫 + 标签 + 分类），2000 cell 时一次召回 444 ms。现在 400 ms 合并一次，
  需要立即落盘的路径显式 `force`。
- 实测（本机，真实 SQLite 路径）：500 cell 召回 p50 **90 ms → 26 ms**，1000 cell **43 ms**，
  `forEachCell` 2000 cell **111 ms → 34 ms**。新增 `scripts/bench-scale.mjs` 专门测这条路径，
  并在 `scripts/bench.mjs` 的输出里标注"驱动 MemoryStore，非 SQLite"。
- 诚实说明：**写入仍是 O(n)**（去重 + 冲突检测各一次全扫），这一版只削了常数因子。

### 面板

- 样式重做：统一四档字号与 4 的倍数间距、暗色模式重新取色（不是反色）、
  去掉重投影、页签改胶囊高亮、小节标题加 3px 强调条、滚动条与焦点环。
- 标签云改为只取 PATIENT / MANNER / QTY 三个槽位——之前从 digest 抓 2–6 字片段，
  产出的是「别写进代码」「的缓存方案先」这种分词失败的半截话。
- 窄侧栏（≤340px）单独一档布局；预览支持 `#tab,dark,tall` 便于一次截两套主题。
- 「待整合」改为「单证据」（原词会被误读成巩固队列）。

### 测试

115 条（+6 条主动开口：跨午夜只读、跨日滚动、`fire` 校验、状态落盘、边界静音、tick 门槛）。
新增 `scripts/bench-scale.mjs` 与 `scripts/ci-check-publish.mjs`。

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
