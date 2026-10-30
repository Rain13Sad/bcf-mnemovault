# 集成契约核对（对照 DSH `0.2.1-rc.3` 实际发布包）

文档 §14 有四处 ⚠ 标注"必须以实机为准"。这份文件记录**实际核对的结果**：
哪些按文档写法就能用，哪些必须改，以及改成了什么。

核对方法：直接下载 npm 上的 `@deepseek-ai/dsh@0.2.1-rc.3` 及其依赖包，
读 `lib/types/**/*.d.ts` 与 `lib/client.js`（编译产物里的调用形状），
再用真实 `@deepseek-ai/cordis@4.0.5` 装载全部插件跑通（见 `test/integration.test.mjs`）。

---

## 1. 宿主侧（host）

### 1.1 Service / 生命周期 ✅ 与文档一致

```ts
export class MemoryService extends Service {
  constructor(ctx: Context, opts) { super(ctx, 'memory') }
}
```

- `@deepseek-ai/cordis` 的 `Service` 构造函数即注册：`super(ctx, name)` → `ctx.memory` 立刻可用，随 fiber 卸载自动注销。
- `ctx.effect(() => disposer, label)` 的 `execute` **同步执行**，返回的 disposer 在卸载时逆序执行——文档 §14.7 的热重载契约直接成立。
- `ctx` 是 **Proxy，禁止任意赋值**。`ctx.foo = x` 会抛 `cannot set property "foo" without provide`。
  → 要暴露额外能力必须 `ctx.provide('name', value)`。本项目在 `recall`（`mnemoRecallGate`）与 `consolidator`（`mnemoConsolidator`）两处踩过这个坑。

### 1.2 事件：`session/event` ✅ 与文档一致

```ts
ctx.on('session/event', (session, event) => { /* event.type, event.seq, event.time, event.turn */ })
```

事件名与载荷来自 `@deepseek-ai/dsh-session` 的 `SessionEventMap`：
`turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`…
本项目只依赖这 6 个，其余不碰。

### 1.3 `agent/pre-step` ⚠ → 已核实，与文档写法一致

```ts
ctx.on('agent/pre-step', async (payload, next) => {
  // payload: { agent, messages: UserMessage[], turn, step, signal }
  // next: () => Promise<PreStepDecision>
  payload.messages.splice(idx, 0, msg)   // 可变数组，文档写法成立
  return next()
})
```

三个必须注意的点：

1. `messages` 是 `UserMessage[]`，**不是** `Record<string, unknown>[]`。注入对象要构造出
   `{ id, role:'user', content:[{type:'text',text}], source }`。
2. `source` 用 `{ kind: 'plugin', plugin: '@rain13sad/dsh-mnemo-recall', form: 'recall' }`。
   `form: 'recall'` 是官方语义（"Material lifted out of another session's log"），
   比自定义一个 kind 更贴合，也让 UI 能把注入内容与用户真实发言区分开。
3. `next()` 返回 `PreStepDecision`（`{kind:'enter',messages}` | `{kind:'reject'}`）。
   监听器必须把 `next()` 的返回值原样返回，否则会吞掉下游的拒绝。

### 1.4 `agent/request`（temperature 调制）✅ 但默认关闭

`LlmCallConfig` 有 `temperature?: number`，waterfall 返回替换对象即可。
本项目把它放在 `recall.applyTemperature`（默认 `false`）后面：情感调温度是**风险项**，
不该默认生效；开启后也只在 `typeof cfg.temperature === 'number'` 时才改。

### 1.5 `agent/turn-stopping` ⚠ 与文档不同：它是 **serial**，不是 waterfall

文档 §15.8 写的是 `ctx.on('agent/turn-stopping', async (payload, next) => { ... next() })`。
实际签名是 `(payload: {agent,turn,signal}) => void | Promise<void>`，**没有 `next`**。
本项目按实际签名实现（`consolidator/src/index.ts`）。

### 1.6 工具注册 ⚠ 文档未写形状，实际是 `ctx.tools.register(definition)`

```ts
ctx.tools.register({
  name, description, parameters,        // parameters 是 JSON Schema
  output: { schema, render(args, value) },  // output 是**必填**的
  execute: async (args, exec) => value,     // 只返回 canonical JSON 值
})
```

- 少了 `output` 会直接注册失败——这是文档没写、但必须补的一块。
- `render(args, value)` 返回 `ContentBlock[]`（`[{type:'text',text}]`），模型看到的是它。
- egress 守卫用 `ctx.tools.guard(exec => reason | undefined)`，返回字符串即拒绝。
- `execute(args, exec)` 的 `exec` 是 `ToolRunContext`，**带 `agent`**（`exec.agent.session.id`）。
  这是做"按会话作用域"与"条件审批"的唯一入口——没有它，审批请求无法路由到具体会话。

### 1.6.1 审批：`ctx.approval`（服务名就是 `approval`）

```ts
const approval = ctx.get('approval') as { request(req: ApprovalRequest): Promise<ApprovalOutcome> } | undefined
const outcome = await approval.request({
  agent,                       // 必须是活着的 agent，否则拒绝
  toolName: 'memory_assert',
  callId: exec.callId,         // 可选，让 UI 挂到已流式的调用上
  reason: '写入长期记忆：…',
  signal: exec.signal,
})
if (outcome !== 'allowed-once') { /* 拒绝或取消，什么都不写 */ }
```

要点：
- 唯一授权值是 `'allowed-once'`；其余（`denied` / `cancelled` / `unavailable`）都当拒绝处理。
- **必须有打开的 turn**，否则请求会被拒（审计事件要落在 turn 的提交边界内）。
- 没有 answerer 时返回 `'unavailable'`（fail-closed），所以调用方必须准备好"没有审批面"的分支。
  本实现在这种情况下返回 `{ action: 'needs_approval' }` 并**不写入**，把决定权交回给对话。

### 1.7 配置：schemastery ✅

`z.object({...})` 的推断类型对字面量联合（`z.union([z.const('a'),...])`）会收紧成 `'a'|'b'`，
与手写 `interface Config { preset: string }` 不兼容。
→ 不要给 schema 加 `: z<Config>` 标注，让它自己推断；需要类型时用 `type Config = MnemoConfig`。

---

## 2. 客户端侧（client，侧栏面板）

文档 §12 只说"侧栏面板是 client 侧插件"，没给 API。实际契约如下（核对自
`@deepseek-ai/dsh-client-ui-slots`、`dsh-client-ui-layout`、`dsh-client-ui-sidebar`，
以及 `dsh-client-ui-agent-preset` 的 `lib/client.js` 编译产物）：

### 2.1 模块形状

```js
// lib/client.js（宿主打包后的形态，源码等价于下面）
export const name = 'mnemo-ui'
export const inject = ['slots', 'layout']       // client 服务名，不带 @scope
export function apply(ctx) { /* ... */ }
```

`package.json` 里声明它需要哪些 client 包：

```json
"dsh": { "client": { "platform": "web", "inject": [
  "@deepseek-ai/dsh-client-connection",
  "@deepseek-ai/dsh-client-ui-renderer",
  "@deepseek-ai/dsh-client-ui-session",
  "@deepseek-ai/dsh-client-ui-sidebar",
  "@deepseek-ai/dsh-client-ui-layout",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-api-remotes"
] } }
```

### 2.2 面板注册：`main` 槽（keyed, root）

```ts
ctx.slots.register(
  { name: 'main', key: 'mnemo', registrant: '@rain13sad/dsh-mnemo-ui' },
  (props) => h(MnemoPanel, { ... }),
)
```

`main` 的 `key` 就是 `MainPanelId`；`ctx.layout.selectPanel('mnemo')` 切换到它。
`register()` 返回 disposer，必须放进 `ctx.effect`，否则热重载后旧面板还在。

### 2.3 侧栏入口：`sidebar.panellist`（list, root）

```ts
ctx.slots.register(
  { name: 'sidebar.panellist', id: 'mnemo', order: 60, label: () => '记忆' },
  (props) => h(PanelIcon, { size: props.size, active: props.active }),
)
```

- `id` 必须与 `main` 的 `key` 一致——侧栏据此把图标按钮和面板对应起来。
- 注册后它会**自动出现在「更多」菜单**里（`sidebar.panellist.actions` 的 `entries` 由面板注册表投影而来），
  正是文档 §12.1 要求的入口。
- 不要直接往 `sidebar.panellist.actions` 注册：那个槽是**整个 More 菜单的菜单体**，
  抢它会把别的面板入口挤掉。

### 2.4 组件 props

注册的组件会收到：owner props（如 `size` / `active`）、`inject` 工厂返回的业务面、
声明 `locale` 时合成的 `t`，以及全局标准 props（含 `usePanelInfo`）。
本项目只用了 owner props，其余保持可选，避免绑定过深。

### 2.5 类型策略：窄接口 + 显式校验

client 包族没有装进 devDependencies（会把 react 与十几个 ui-* 包一起拖进来）。
`ui/src/client/index.ts` 用一个结构化的 `ClientContext` 描述真正用到的面，
逐条对照上面几个 `.d.ts`。契约变更时**编译期就炸**，而不是运行时白屏。

---

## 2.6 主动开口包（`mnemo-proactive`）

```ts
export const inject = ['memory', 'sessions']
export function apply(ctx, config) {
  const svc = new ProactiveService(ctx, ctx.get('memory'), config)
  ctx.provide('mnemoProactive', svc)          // 面板与命令都从这里取
  ctx.on('session/event', …)                  // 记 lastUserAt（空闲判定）
  setInterval(() => svc.tick(), 60_000)       // 每分钟判断一次
}
```

- `candidate(now?, {ignoreSchedule?})` 只**产出**，不发送；`fire(c)` 才记账并 `emit('mnemo/proactive')`。
- 事件载荷：`{ kind, text, reason, cellIds, urgency, at }`。
- `text` 是**给模型的提示**，不是台词。宿主拿到后用自己的开口通道（steering / inbox）。
- 没有该通道时，降级为"用户下次说话时作为 notice 注入"——这是文档化的降级，不是静默失败。
- 面板操作走 `memory.applyAction({kind:'proactive', action:'now'|'mute'|'unmute'|'config'})`。

## 3. 数据面：面板怎么拿到 host 的数据

v0.3 之前这里写的是"`ctx.remote` 需要部署方注册 contribution，面板走只读事件源"。
现在 **host 侧自己接线**，面板按四级顺序取数据源：

| 顺序 | 来源 | 能力 |
| :--- | :--- | :--- |
| 1 | `ctx.get('mnemoRemote')`（host 侧 `ctx.provide`） | 全量读写（快照 + 动作 + 搜索 + 订阅） |
| 2 | `ctx.get('remote').mnemo`（宿主注册表） | 同上，若宿主支持 |
| 3 | `ctx.get('mnemoSnapshot')` | 只读（能看本轮召回与情感状态） |
| 4 | `demo` fixtures | 独立预览 / 回归测试 |

host 侧注册（`packages/tools/src/bridge.ts`）：

```ts
const face = {
  snapshot: async () => memory.panelSnapshot(),
  act: async (a) => memory.applyAction(a),
  search: async (q) => memory.search(q, 50),
  subscribe: (fn) => memory.onPanelUpdate(fn),
}
ctx.provide('mnemoRemote', face)          // 面板优先读这个

// 宿主的 remote 注册表形状在 rc 间不固定，四种逐个探测，认不出就跳过：
const remote = ctx.get('remote')
remote?.register?.('mnemo', face)          // A
remote?.contribute?.({ name: 'mnemo', ...face })  // B
remote?.define?.('mnemo', face)            // C
remote?.contributions?.set?.('mnemo', face) // D
```

`PanelSnapshot` / `PanelAction` 的形状在 `@rain13sad/dsh-mnemo-core` 的 `types.ts` 里，
是 host 与 client 唯一共享的契约——两边都只依赖它，不互相 import 实现。

### 3.1 v0.4 新增的可选字段

| 字段 | 类型 | 兼容策略 |
| :--- | :--- | :--- |
| `snapshot.retention` | `PanelRetentionView` | **可选**。旧 host 不提供时，面板「保留度」页降级为说明页而不是白屏 |
| `affect.policy.requireAcknowledgment` | `boolean?` | 可选。旧 host 不提供时按 `false` 处理 |
| `affect.policy.neglect` | `number?` | 可选。未平复情绪事件数 |
| `affect.episodeDetail` | `Array<...>?` | 可选。情绪事件五态全量（含 resolved/dormant），旧字段 `episodes` 保留 |
| `affect.neglect` | `string[]?` | 可选。强制关怀槽的注入行 |

`PanelRetentionView` 的结构：

```ts
{
  byDisposition: Record<'P5'|'P4'|'P3'|'P2'|'P1', number>
  floors: { P5: number; P4: number; P3: number; P2: number }
  entries: Array<{
    cellId: string; shortId: string; digest: string; kind: number; tier: number
    score: number; disposition: 'P5'|'P4'|'P3'|'P2'|'P1'
    protectedBy: string | null
    parts: Record<string, number>          // 七因子原始值
    contributions: Record<string, number>  // 七因子已乘权重（冗余为负）
    anniversary: number; why: string
  }>
  neuromod: { da: number; ach: number; ne: number; cort: number }
  mode: 'encode' | 'retrieve'
  temperature: number
  weights: Record<string, number>
  reconsolidation: Array<{ at: number; cellId: string; dStability: number; dConfidence: number; dValence: number; plastic: boolean }>
}
```

口径：`entries` 只含最近 120 条里保留度最高的 40 条，`byDisposition` 统计的是那 120 条。
面板上写明了这一点——**不假装是全域统计**。

### 3.2 v0.5 变更

| 变更 | 形状 | 兼容策略 |
| :--- | :--- | :--- |
| `PanelRetentionEntry.invalid` | `boolean` | **必填**。旧的 `retention` 快照没有它 → 视图按 `false` 处理 |
| `PanelRetentionEntry.stale` | `number` | **必填**，0.15..1 的陈旧包络 |
| `PanelRetentionEntry.disposition` | 现在给的是**实际处置**（`effective`） | 与 `tier` 一致；分数仍单独给 `score` |
| `PanelAction.restore` | `{ kind: 'restore'; cellId: string }` | 新增。墓碑复活（原文已释放，只能拿回摘要） |
| `RecallQuery.readOnly` | `boolean?` | 新增。面板 / doctor / 解释器必须置真 |
| `RecallQuery.includeTombstones` | `boolean?` | 新增。默认 false——墓碑不参与召回 |
| `AffectPolicy.regulation` | `RegulationStrategy?` | 新增，Gross 五策略之一 |
| `affect.trait` | `{ O,C,E,A,N, attachment }?` | 新增，从人格锚与关系模型投影 |
| `DoctorReport.invalidNotDemoted` / `.tombstones` / `.tombstoneBytes` | `number?` | 新增，增长与迁移报告 |

**tier 语义变更**：`3 = archive`（仍参与召回）、`4 = tombstone`（不参与召回、内容已压实）。
v0.4 里 P1 与 P2 都落在 3，存储层无法区分——这是 v0.5 修掉的缺陷之一。

---

## 4. 运行时状态：`ctx.provide('mnemoRuntime', …)`

这是 v0.3 新加的。**文档里每一个"未实机验证"的能力，都必须有一个运行时可读的状态**，
否则"已接线"和"在降级"在外部看起来完全一样。

```ts
interface L1Status {
  enabled: boolean
  mode: 'port' | 'lite' | 'l0'
  entry: string | null      // 识别到的宿主入口名（chat / complete / client.invoke …）
  ok: boolean               // 最近一次调用是否解析出命题
  lastMs: number
  note: string              // 人话说明，面板直接显示
}
```

写入方：`core`（ANN 模式）、`encoder`（L1 自检与每次调用）、`tools`（命令面 / remote 面 / 工具清单）。
读取方：`memory.panelSnapshot().runtime`、`/mnemo doctor`、面板「设置 → 编码与索引」。

---

## 5. L1 端口：`fromHostLlm` 认什么

v0.2 只认 `complete` / `generate` / `chat` 三个入口、且假设第一个参数是字符串。v0.3 改成：

- **入口**（按顺序探测）：`complete` `chat` `generate` `invoke` `run` `call` `respond` `createCompletion`，
  并在 `client` / `provider` / `model` / `models` 四个嵌套路径下各试一遍。
- **入参形状**：`chat` → `{ messages: [{role:'user', content}] }`；`complete` → `(prompt, {maxTokens})`；
  其余 → `{ prompt, messages, maxTokens }`（宽对象，多数宿主能接受其一）。
- **返回归一**：字符串 / `{text}` / `{output_text}` / `{content}` / `{content:[{text}]}` /
  `{choices:[{message:{content}}]}` / `{choices:[{text}]}` / `{output}` / 异步迭代器（流式增量拼接）。
- **自检**：`probeLlmPort(port)` 真打一次最小调用，4 秒超时。失败**不抛错**，
  只把 `ok:false` 与原因写进 `RuntimeStatus.l1.note`，编码器降级到 lite。

一次都没识别到时 `fromHostLlm` 返回 `null`——不做猜测性调用，这是刻意的。

---

## 6. 向量索引：HNSW 的分档

```ts
// core/src/ann.ts
interface VectorIndex {
  add(id: bigint, vec: Int8Array): void
  remove(id: bigint): void
  search(vec: Int8Array, k: number, ef?: number): VectorHit[]
}
```

- `cell < recall.annThreshold`（默认 2000）→ 精确扫描：更快，且没有近似误差。
- 超过阈值 → `HnswIndex`（`M=16` / `efConstruction=200` / `efSearch=64`）。
- 层高由 **id 的哈希**决定，不用 `Math.random`：同一批 cell 重建索引得到同一张图，
  召回可复现（`test/ann.test.mjs` 断言逐条一致）。
- 删除用墓碑标记，墓碑超过 20% 整图重建（HNSW 的删除本身是研究问题）。
- `memory.annOverlap(k)` 抽样比对 ANN 与精确扫描的 top-k 重合度，面板/doctor 可自检。

---

## 7. 命令面：四种形状

```ts
cmdline.command('mnemo').command('<command> [args...]').description(d).action(fn)  // A
cmdline.register({ name, description, usage, handler })                             // B
cmdline.define('mnemo', '<command> [args...]', handler)                             // C
ctx.get('commands').register(...)                                                   // D
```

全部不中才降级为 `mnemo_command` 工具（同一套 `runCommand`）。落在哪一种，
`RuntimeStatus.commandFace` 记录，面板「设置 → 命令面」显示。
另外始终提供 `ctx.provide('mnemoCommands', { run(line) })` 给面板按钮用——
**"面板上能点的"和"命令行能敲的"必须走同一个实现**。

---

## 8. 仍然没有实机验证的部分

| 项 | 状态 | 影响 |
| :--- | :--- | :--- |
| `ctx.remote` 宿主注册表 | 四种形状都试了，但仓库里没有真宿主可验证 | 认不出时面板走 `mnemoRemote` 本地服务，功能不缺 |
| L1 端口真调用 | 形状与自检都做了，未在真宿主上跑过 | 面板显示"lite 规则切分"，这是诚实的当前状态 |
| `compaction/summary` 事件名 | 用宽类型入口 + 运行时校验订阅，拿不到就静默降级 | 遮蔽检测可能失效（不影响主链路） |
| 百万级 cell 的 ANN 收益 | HNSW 已实现且有重合度测试，但 bench 没有百万级数据集 | 没有"快多少"的数字，只有"准不准"的数字 |

### 1.8 卡片渲染：`presentCall` / `presentResult`（§12.7）

```ts
presentCall(args)            // → { card:'generic', title, kind:'search' }
presentResult(args, value)   // → { card:'generic', title, content:[ContentBlock] }
```

- `card` 是标签联合（`generic` / `terminal` / `diff` / `search` / `read` / `web`），UI 按 `card` 分派。
- 纯函数：同 `args`/`value` 必须得到同结果（会话回放时会再调一次）。
- 只影响 UI，**不进模型上下文**；模型看到的仍然是 `output.render()` 的文本。
