# 参与贡献

先读 [`docs/PROJECT-GUIDE.md`](docs/PROJECT-GUIDE.md)。它写清了这套东西**哪些地方靠得住、哪些靠不住**，
以及 15 条已知缺点和 12 条改进意见（按 P0/P1/P2 排过序）。从那里挑活比从零想需求高效得多。

> **语言**：代码注释与长文档是中文，README 有英/中/日/韩/西五个版本（`README.md` 为英文首页）。
> 提 PR 时中文或英文都可以；如果改了对外可见的行为，请顺手更新 `README.md` 与 `README.zh-CN.md`
> 两处——其余语言版本是摘要，可以滞后一轮。

---

## 环境

| 项 | 要求 | 说明 |
| :--- | :--- | :--- |
| Node | `>= 22.5.0` | 依赖内置的 `node:sqlite`（WAL + `BEGIN IMMEDIATE`）与 `node:zlib`（brotli） |
| npm | `>= 10` | 用 workspaces；锁文件是 lockfileVersion 3 |
| DSH | `0.2.1-rc.3`（`next` 通道） | 仅用于真机装载验证；**跑测试不需要装 DSH** |

```bash
npm ci
npm run build      # 按依赖顺序编译 10 个包（没有 bundler，逐包 tsc）
npm test           # 93 条
npm run check      # SDR 性质校验：错了就全盘失效的那一层
npm run bench:eval # Recall@8 / MRR / 去重 / 时间推理 / token 成本
npm run verify     # 以上四件事一次跑完（CI 跑的就是它）
```

面板：`npm run demo` 生成快照 → `npm run panel` 起预览（<http://127.0.0.1:5178/>）。
`npm run panel:build` 只产出 `artifacts/panel/`，不占端口——`npm test` 里有一个用例直接 import 这份产物。

---

## 代码地图

```
packages/
├── core/          晶格服务：cell 编解码 / sqlite 存储 / SDR / 召回打分 / MRS 渲染 / 遗忘曲线
├── affect/        情感内核：评价 → PAD → 心境 → 关系 → 人格锚（落盘为 kind=3/4/5 cell）
├── encoder/       写侧：订阅 session/event，L0 切分 + 8 槽填充 + 冲突消解（L1 端口在 l1.ts）
├── recall/        读侧：agent/pre-step 门控与 4±1 槽位注入
├── consolidator/  离线：NREM 抽象 / REM 发散 / 遗忘（幂律）
├── proactive/     主动开口：四道闸 + 五类由头，产出"给模型的提示"而不是台词
├── tools/         6 个工具 + 15 条 /mnemo 子命令 + egress 守卫
├── settings/      设置 schema、三个预设档、生效矩阵
├── ui/            侧栏面板（client 侧，React）：时间线 / 图谱 / 情感 / 诊断
└── devkit/        无宿主运行器：真 Cordis fiber + 可推进时钟，供 demo 与测试
```

依赖方向是单向的：`core → affect → encoder → recall → consolidator → tools`，
`ui` 只依赖类型，`devkit` 在末端。拆包不是为了洁癖——Cordis 的 `inject` 是依赖驱动的，
只要记忆不要情感的用户可以只装 `core + encoder + recall + tools`。

---

## 改代码前需要接受的硬约束

1. **注入 token 有预算。** 每轮稳态约 110–120 token，任何新增渲染字段都要说清这笔账怎么平。
2. **写入必须可复现。** 同样的输入必须产出同样的 cell 字节。不要引入 `Date.now()` 做事件时间、
   不要用未播种的随机数。时间一律走 `harness.now()` 或事件的 `tFrom`。
3. **存储层字节级无损，表面层语义级有损可回溯。** 原文残差必须能取回；渲染可以压。
4. **不引入 `@deepseek-ai/*` 之外的运行时依赖。** 现在运行期只有一个外部包
   （`@deepseek-ai/schemastery`，用于 schema 校验与设置表单），其余是 Node 内置
   （`node:sqlite` / `node:zlib`）。写"零运行时依赖"是错的——评审用一个 grep 就能推翻它。
   新增一个 npm 依赖需要先说服维护者它比内置方案好在哪。
5. **不声称现象意识。** 情感输出一律是状态变量的投影，工具返回数值并自带免责声明。

---

## 提交规范

```
<type>(<scope>): <一句话>

type: feat | fix | perf | refactor | test | docs | chore | ci
scope: core | affect | encoder | recall | consolidator | proactive | tools | settings | ui | devkit | scripts | docs
```

例：`fix(encoder): 宾语抽取把"用户用 pnpm"切成"户用"，导致两条事实被误合并`

改行为必须带测试。这个项目里有一类缺陷是类型检查和 code review 都抓不到的
（例如"合并时用新 cell 覆盖会留旧 cell，同一事实两条记录"），只有跑起来才现形——
所以测试是唯一的防线，不是形式。

---

## 数值类改动

README 与项目说明书里的每个数字都来自 `artifacts/bench.json`。改算法后如果指标变了：

1. 跑 `npm run bench:eval`，把新数字贴进 PR；
2. 同步更新 README 的实测表（**不要**只改一处）；
3. 若指标下降但仍达标，说明原因；若不达标，先写进 README 的「已知限制」再合并——
   未经测量的数字不算结论，未如实记录的退步不算改进。

---

## 新增一个包

包族的骨架由脚本生成，别手抄：

```bash
node scripts/scaffold.mjs   # 生成 package.json / tsconfig.json 骨架（按 §14.2 的包族定义）
node scripts/patches.mjs    # 生成各包的 cordis.patch.yml
```

然后把它加进 `scripts/build.mjs` 的 `order` 数组（顺序即编译顺序），并在 `packages/devkit`
的装载清单里注册。

---

## 不要做的事

- 不要提交 `node_modules/`、`packages/*/lib/`、`artifacts/panel/`、任何 `*.db`（本地记忆库里有真实对话）
- 不要为了让 CI 变绿而放宽 `scripts/ci-assert-bench.mjs` 的门槛
- 不要在面板里抢 `sidebar.panellist.actions`（那是整个 More 菜单体）
- 不要用 `ctx.foo = x` 暴露能力，Cordis 的 `ctx` 是 Proxy，必须 `ctx.provide()`

---

## 许可

提交即表示同意以 [MIT](LICENSE) 授权你的贡献。
