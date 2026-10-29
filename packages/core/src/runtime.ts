/**
 * 运行时状态登记处（`ctx.provide('mnemoRuntime', ...)`）
 *
 * 存在的理由：文档里有一批"接口就绪、实机未验证"的能力——L1 端口、ANN、remote 面、
 * 命令面。它们的真实形态**只有运行时才知道**（宿主到底有没有 ctx.llm、长什么样、
 * 命令面注册成功没有）。把这些状态集中登记，面板与 doctor 都读同一份，
 * 就不会出现"README 说已接、实际在降级"的漂移。
 *
 * 写入方：core（ANN）、encoder（L1）、tools（命令面 / remote 面 / 工具清单）。
 * 读取方：面板快照、`/mnemo doctor`、bench 报告。
 */

export type CommandFace = 'cmdline' | 'tool' | 'none'
export type L1Mode = 'port' | 'lite' | 'l0'

export interface L1Status {
  enabled: boolean
  mode: L1Mode
  /** 识别到的宿主入口名（complete / chat / generate / …），未识别为 null */
  entry: string | null
  /** 最近一次调用是否成功解析出命题 */
  ok: boolean
  /** 最近一次调用耗时（ms） */
  lastMs: number
  /** 人话说明，面板直接显示 */
  note: string
}

export class RuntimeStatus {
  l1: L1Status = { enabled: false, mode: 'l0', entry: null, ok: false, lastMs: 0, note: '未启用 L1' }
  commandFace: CommandFace = 'none'
  remoteFace = false
  /** 已注册的模型可见工具名 */
  tools: string[] = []
  /** 面板"后端能力"的 chip 来源 */
  capabilities: string[] = []
  /** 诚实清单：当前明确没做/在降级的事 */
  limits: string[] = []

  setL1(patch: Partial<L1Status>): void {
    this.l1 = { ...this.l1, ...patch }
  }

  addTool(name: string): void {
    if (!this.tools.includes(name)) this.tools.push(name)
  }

  removeTool(name: string): void {
    this.tools = this.tools.filter((t) => t !== name)
  }

  view(): { l1: L1Status; commandFace: CommandFace; remoteFace: boolean; tools: string[]; capabilities: string[]; limits: string[] } {
    return {
      l1: { ...this.l1 },
      commandFace: this.commandFace,
      remoteFace: this.remoteFace,
      tools: [...this.tools],
      capabilities: [...this.capabilities],
      limits: [...this.limits],
    }
  }
}
