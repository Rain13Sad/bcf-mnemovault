/**
 * 记忆生命周期（v0.4.0 新增，对应 v0.4 方案 §1.1 / §1.2）
 *
 * 现有巩固只做两件事：合并相似 cell、按比例降权。缺的是**从多条情景抽象出一条语义**
 * 这条通道——没有它，"巩固"就只是省空间，而不是"把经历变成经验"。
 *
 * 本模块只提供判据与类型，不自己跑 pass：
 *   · `abstractCandidates()` —— 找出可以抽象成图式（kind=3）的情景组
 *   · `nextTier()` —— 六档处置 → 存储层的纯映射
 *
 * 判据（可回归）：≥3 条情景 + 同 (AGENT, PRED) 骨架 + 同话题指纹 + 时间跨度 > 1 天。
 * 加"跨度 > 1 天"是为了排除"同一轮里说了三遍"——那是重复，不是规律。
 */

import { KIND, SLOT_ROLE, type MemCell } from './cell.js'

const DAY = 86_400_000

export type LifecycleStage =
  | 'encode'
  | 'stabilize'
  | 'consolidate'
  | 'store'
  | 'retrieve'
  | 'reconsolidate'
  | 'forget'

export interface ConsolidationOutcome {
  /** 从 n 条情景抽象出的语义/图式 */
  abstracted: Array<{ schema: MemCell; fromIds: bigint[]; support: number }>
  /** 未达抽象门槛但重复出现的：合并提权 */
  merged: Array<{ target: bigint; absorbed: bigint[] }>
  /** 抽象完成后，源情景降为"被索引的细节" */
  demoted: bigint[]
}

export interface AbstractCandidate {
  /** 分组键：`AGENT|PRED|topic` */
  key: string
  agent: string
  pred: string
  topic: string
  cells: MemCell[]
  support: number
  spanDays: number
}

export interface AbstractOptions {
  minSupport?: number
  /** 时间跨度下限（毫秒）。默认 1 天。 */
  minSpanMs?: number
  /** 只考虑仍然有效的情景（默认 true） */
  onlyValid?: boolean
}

/** 取槽位字面量（不用 service 的 slotValue，避免 core 内部循环依赖）。 */
export function slotLiteral(cell: MemCell, roleName: keyof typeof SLOT_ROLE): string | undefined {
  const role = SLOT_ROLE[roleName]
  const s = cell.slots.find((x) => x.role === role && x.type !== 'UNK')
  return s?.value
}

/**
 * 找出可抽象的组。
 *
 * 只吃**情景记忆**（kind=0）：语义记忆再抽象就是空转，程序记忆的抽象对象是动作序列，
 * 与"从经历里抽规律"不是一回事。
 */
export function abstractCandidates(cells: readonly MemCell[], opts: AbstractOptions = {}): AbstractCandidate[] {
  const minSupport = Math.max(2, opts.minSupport ?? 3)
  const minSpan = Math.max(0, opts.minSpanMs ?? DAY)
  const onlyValid = opts.onlyValid ?? true

  const groups = new Map<string, MemCell[]>()
  for (const c of cells) {
    if (c.kind !== KIND.episodic) continue
    if (onlyValid && Number(c.tInvalid ?? 0) !== 0) continue
    const agent = slotLiteral(c, 'AGENT') ?? ''
    const pred = slotLiteral(c, 'PRED') ?? ''
    if (!agent || !pred) continue
    const key = `${agent}|${pred}|${c.topic || ''}`
    const arr = groups.get(key)
    if (arr) arr.push(c)
    else groups.set(key, [c])
  }

  const out: AbstractCandidate[] = []
  for (const [key, arr] of groups) {
    if (arr.length < minSupport) continue
    const times = arr.map((c) => Number(c.tFrom))
    const span = Math.max(...times) - Math.min(...times)
    if (span < minSpan) continue
    const first = arr[0]
    out.push({
      key,
      agent: slotLiteral(first, 'AGENT') ?? '',
      pred: slotLiteral(first, 'PRED') ?? '',
      topic: first.topic || '',
      cells: [...arr].sort((a, b) => Number(a.tFrom) - Number(b.tFrom)),
      support: arr.length,
      spanDays: Math.round((span / DAY) * 10) / 10,
    })
  }
  return out.sort((a, b) => b.support - a.support || b.spanDays - a.spanDays)
}

/**
 * 六档 → tier 的纯映射（`retention.ts` 的 tierForDisposition 在这里再导出一份，
 * 让"生命周期"这一层不必 import 保留度模块）。
 */
export function nextTier(current: number, target: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
  // 只允许逐级移动：热 → 温 → 冷 → 归档，一次 pass 不跨两级。
  // 跨级会让"为什么它突然从热层掉到归档"无法解释，也让面板的 diff 变得难读。
  if (target > current) return Math.min(3, current + 1) as 0 | 1 | 2 | 3
  if (target < current) return Math.max(0, current - 1) as 0 | 1 | 2 | 3
  return current as 0 | 1 | 2 | 3
}

/** 生命周期七阶段的显示顺序（面板/文档共用）。 */
export const LIFECYCLE_ORDER: LifecycleStage[] = [
  'encode',
  'stabilize',
  'consolidate',
  'store',
  'retrieve',
  'reconsolidate',
  'forget',
]

export const LIFECYCLE_LABEL: Record<LifecycleStage, string> = {
  encode: '编码',
  stabilize: '稳定',
  consolidate: '巩固',
  store: '存储',
  retrieve: '提取',
  reconsolidate: '再巩固',
  forget: '降档',
}
