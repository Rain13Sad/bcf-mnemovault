# 文档地图

这个项目的文档不是"越多越好"堆出来的，每份都有明确读者。按你的目的挑一份读，不用从头看。

## 按目的找

| 你想… | 读这份 | 长度 |
| :--- | :--- | ---: |
| **先知道这是什么** | 根目录 [`README.md`](../README.md)（英文）或 [`README.zh-CN.md`](../README.zh-CN.md)（中文，最详细） | 15 分钟 |
| **把它跑起来** | 同上，第「Quick start」节；不需要装 DSH | 5 分钟 |
| **接手维护 / 判断能不能用** | [`PROJECT-GUIDE.md`](PROJECT-GUIDE.md) — 系统怎么运作、28 条缺点（D1–D28）、12 条改进意见（P0–P2） | 40 分钟 |
| **改代码 / 加插件** | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — 环境、代码地图、硬约束、提交规范 | 15 分钟 |
| **对着宿主版本核对接口** | [`API-CONTRACT.md`](API-CONTRACT.md) — DSH `0.2.1-rc.3` 实际发布包与设计文档写法的差异 | 20 分钟 |
| **理解算法为什么这么定** | [`design/MNEMOVAULT-DESIGN.md`](design/MNEMOVAULT-DESIGN.md) — 稀疏码代数、四路召回、MRS 渲染、双相巩固的推导与参数依据 | 3 小时 |
| **追根到神经科学依据** | [`design/BRAIN-MEMORY-RESEARCH.md`](design/BRAIN-MEMORY-RESEARCH.md)、[`design/AI-AFFECT-RESEARCH.md`](design/AI-AFFECT-RESEARCH.md) | 各 1 小时 |
| **发布 / 建仓 / 打 tag** | [`PUBLISH.md`](PUBLISH.md) | 5 分钟 |
| **看这版改了什么** | [`../CHANGELOG.md`](../CHANGELOG.md) | 5 分钟 |
| **看某一版的范围与取舍** | [`design/V0.5.2-PLAN.md`](design/V0.5.2-PLAN.md)（当前）、[`design/V0.5-PLAN.md`](design/V0.5-PLAN.md)、[`design/V0.4-PLAN.md`](design/V0.4-PLAN.md) | 各 20 分钟 |
| **看某一版的发布说明** | [`releases/`](releases/) — `v0.5.3.md` / `v0.5.2.md` / `v0.5.1.md` / … | 各 10 分钟 |

## 语言

仓库首页有五个语言版本，内容深度不同——**中文版最详细，是术语与数字的权威来源**：

| 文件 | 语言 | 定位 |
| :--- | :--- | :--- |
| [`README.md`](../README.md) | English | 首页默认版本，面向第一次看到这个仓库的人 |
| [`README.zh-CN.md`](../README.zh-CN.md) | 简体中文 | 完整版：能力清单、缺陷记录、参考项目对照、目录树 |
| [`README.ja.md`](../README.ja.md) / [`README.ko.md`](../README.ko.md) / [`README.es.md`](../README.es.md) | 日本語 / 한국어 / Español | 摘要版，均指向中文长文档 |

配图在 [`assets/`](assets/)：`banner.svg`（首页横幅）、`pipeline.svg`（写入/读取/离线三条链路）、
`social-preview.svg`（1280×640 版式，用于 GitHub 仓库的 Social preview；GitHub 只收 PNG，需导出后上传，见 [`PUBLISH.md`](PUBLISH.md)）。

## 四份核心文档的分工

```
design/BRAIN-MEMORY-RESEARCH.md   ─┐
design/AI-AFFECT-RESEARCH.md      ─┼─→ design/MNEMOVAULT-DESIGN.md ─→ PROJECT-GUIDE.md
                                   │       （为什么这么设计）           （代码实际做了什么）
                                   │                                        │
                                   └──────────── 理论依据                    ├─→ API-CONTRACT.md
                                                                            │    （宿主接缝核对）
                                                                            └─→ CONTRIBUTING.md
                                                                                 （怎么改）
```

- **研究报告**（两份）：人类记忆的机制、AI 情感与意识的神经基础。它们是设计的**依据**，不是规范。
- **设计文档**（v0.2，2551 行）：从依据推到工程方案——为什么是 2048 位稀疏码而不是向量库、
  为什么绑定用置换而不是 XOR、为什么检索用 containment 而不是 Jaccard。所有参数都有出处。
  它写于实现之前，因此**与实现有出入**；出入之处以 `API-CONTRACT.md` 与代码为准。
- **项目说明书**：写于实现之后，只讲代码实际做了什么，并把 28 条缺点与 12 条改进意见
  按证据与影响排了序。**接手的人应该先读这份。**
- **集成契约核对**：设计文档里有 4 处 ⚠ 标注"必须以实机为准"。这份文件记录了核对结果：
  哪几处照文档写就能用、哪几处必须改、改成了什么。

## 数字的时效性

文档里的数字都有日期，且只有一处是权威来源：

| 数字 | 权威来源 | 当前值 |
| :--- | :--- | :--- |
| 测试条数 | `npm test` | 176 |
| 召回质量 / token 成本 / 存储比 | `artifacts/bench.json`（`npm run bench:eval` 生成） | Recall@8 0.941 / 106.4 token / 0.839× |
| 规模（延迟 / 索引内存） | `artifacts/bench-scale.json`（`npm run bench:corpus` 生成） | 1 万 cell p95 25 ms / 索引 1.6 MB |
| SDR 性质（噪声底、容量、解绑准确率） | `npm run check` 的终端输出 | 13 项断言 |
| 代码行数 / 命令数 / 缺点条数 | `npm run check:readme` | 59 文件 / 18,678 行 / 22 命令 / 28 缺点 |

设计文档里引用的数字是**设计时的估算**（例如"存储比 0.45–0.60×"），与实测不一致时
以实测为准，并在 README 的「一个没达标的指标」里说明差异来源。
