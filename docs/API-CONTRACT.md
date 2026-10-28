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

`@deepseek-ai/dsh-api-remotes` 是官方通道（BFF + Gateway + Cordis 事件源），
但它的接线在 rc 之间最不稳定，且需要部署方注册 contribution。
因此面板面向 `MnemoDataSource` 编程，三个适配器：

| 适配器 | 何时用 | 能力 |
| :--- | :--- | :--- |
| `remote` | 宿主注册了 `ctx.remote.mnemo` | 全量读写 |
| `event` | 只订阅了会话事件 | 只读（能看本轮召回与情感状态） |
| `demo` | 独立预览 / 回归测试 | 内存 fixtures |

host 侧要接 remote，只需实现三个方法：

```ts
export interface MnemoRemoteFace {
  snapshot(): Promise<PanelSnapshot>     // memory.panelSnapshot()
  act(a: PanelAction): Promise<{ok, message}>  // memory.applyAction(a)
  subscribe?(fn): () => void
}
```

`PanelSnapshot` / `PanelAction` 的形状在 `@rain13sad/dsh-mnemo-core` 的 `types.ts` 里，
是 host 与 client 唯一共享的契约——两边都只依赖它，不互相 import 实现。

---

## 4. 尚未接线的部分

| 项 | 状态 | 影响 |
| :--- | :--- | :--- |
| `ctx.remote.mnemo` contribution | 未实现，只定义了接口 | 面板走只读事件源 |
| `ctx.cmdline` 命令注册 | 已按 `command(name).command(spec).description().action()` 写，宿主无此服务时降级为工具 | 命令面不缺功能 |
| L1 切分（宿主 LLM） | 端口就绪，`ctx.llm` 调用形状未实机验证；同步链路用 `segmentLite` | 切分质量介于 L0 与真 L1 之间 |
| `compaction/summary` 事件名 | 用宽类型入口 + 运行时校验订阅，拿不到就静默降级 | 遮蔽检测可能失效（不影响主链路） |

### 1.8 卡片渲染：`presentCall` / `presentResult`（§12.7）

```ts
presentCall(args)            // → { card:'generic', title, kind:'search' }
presentResult(args, value)   // → { card:'generic', title, content:[ContentBlock] }
```

- `card` 是标签联合（`generic` / `terminal` / `diff` / `search` / `read` / `web`），UI 按 `card` 分派。
- 纯函数：同 `args`/`value` 必须得到同结果（会话回放时会再调一次）。
- 只影响 UI，**不进模型上下文**；模型看到的仍然是 `output.render()` 的文本。

### 1.9 作用域隔离（§14.10）

- `cell.scope`（`'user:local'` / `'user:<id>'` / `'global'`）与 `cell.session` 作为**列**承载，
  不进 MC02 头（头是 v0.2 定死的）。
- 检索时：`scopeKey` 不匹配且不是 `'global'` → 不可见；`kind=0`（情景）且会话不同 → 不可见。
- `recall({ scope: 'global' })` 是唯一的放宽口，必须由调用方显式传。

### 1.10 重建（§14.11）

`session_log` 是插件自己的影子日志（session, seq, turn, role, text, at），
只存重建所需的最小信息，不替代 DSH Session Log。
`/mnemo rebuild --from-log --yes` → `clearLattice([3,4,5])`（保留图式/人格锚/关系）→ 按轮重放 → 重新编码。

已接线（上一版列在这里，这一版做完了）：

| 项 | 做法 |
| :--- | :--- |
| 残差压缩 | `node:zlib` brotli（质量 5），`codec` 字段留 zstd 扩展位；轮级共享 |
| 条件审批 | `ctx.approval.request()`，用户明说"记住"时免审 |
| 人格锚 / 关系模型持久化 | `kind=4` / `kind=5` cell，启动时 `restoreFromMemory()` |
| 双时态 | `t_invalid` 列（不进 MC02 头，避免破版） |
| 作用域隔离 | `scope` / `session` 列 + 检索期过滤（情景按会话，语义全局） |
| 晶格重建 | `session_log` 影子日志 + 编码器重建钩子 |
| 重放一致性 | `recall_snapshots` 内容寻址 + `replayRecall(id)` |
| 对话流卡片 | `presentCall` / `presentResult`（generic） |
| L1 端口 | `LlmPort` + `fromHostLlm`（未实机验证，认不出就降级） |

这四项都是"接线"而不是"缺设计"：接口在，实现是纯工程量。
把它们列出来，是因为文档反复强调的一件事——**未经测量的能力不该被说成已有**。
