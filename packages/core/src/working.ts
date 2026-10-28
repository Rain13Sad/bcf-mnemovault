/**
 * 感觉记忆与工作记忆（对应 §8.1 / §8.2）
 *
 * 这两层在文档里是"人类机制 → 工程对应物"的第一、第二行，但很容易被当成装饰跳过。
 * 它们各自解决一个具体问题：
 *
 *   SensoryRing —— 用户重复粘贴同一段内容时不要重复编码。靠内容哈希命中，TTL 2 轮，不落盘。
 *   WorkingSet  —— 本轮"摸过"的 cell 引用集。它不改数据，只改这一轮的打分：
 *                  刚被召回过的东西，下一轮再被想到的概率更高（启动效应，priming）。
 *
 * 关键区分（文档特意强调过）：WorkingSet 是"这轮摸过的所有东西"（上限 16），
 * 4±1 槽位是"这轮真正摆到模型眼前的四件事"。两者不是一回事，混在一起会让瓶颈失效。
 */

/** 固定容量的环形缓冲。TTL 以"轮"为单位，不是墙钟——用户可能几分钟才说一句话。 */
export class SensoryRing {
  private items: Array<{ hash: string; bytes: number; turn: number; text: string }> = []
  private total = 0

  constructor(
    private readonly capBytes = 64 * 1024,
    private readonly ttlTurns = 2,
    private readonly maxItems = 64,
  ) {}

  /** 记一条原始输入。返回是否与缓冲里仍然有效的内容重复。 */
  push(turn: number, text: string): { duplicate: boolean; hash: string } {
    const hash = fnv(text)
    this.expire(turn)
    const duplicate = this.items.some((it) => it.hash === hash)
    const bytes = byteLen(text)
    this.items.push({ hash, bytes, turn, text: text.slice(0, 4096) })
    this.total += bytes
    // 超出容量或条数就覆盖最旧的（§8.1：超出覆盖最旧，不是拒绝新的）
    while ((this.total > this.capBytes || this.items.length > this.maxItems) && this.items.length > 1) {
      const dropped = this.items.shift()!
      this.total -= dropped.bytes
    }
    return { duplicate, hash }
  }

  /** 只看不写：编码器用它做"这段是不是刚出现过"的判定。 */
  seen(text: string, turn: number): boolean {
    this.expire(turn)
    const h = fnv(text)
    return this.items.some((it) => it.hash === h)
  }

  expire(turn: number): void {
    const keep = this.items.filter((it) => turn - it.turn <= this.ttlTurns)
    if (keep.length === this.items.length) return
    this.total = keep.reduce((n, it) => n + it.bytes, 0)
    this.items = keep
  }

  /** 残差去重键：同一段内容在 TTL 内只压一次。 */
  hashOf(text: string): string {
    return fnv(text)
  }

  get size(): number {
    return this.items.length
  }
  get bytes(): number {
    return this.total
  }
  clear(): void {
    this.items = []
    this.total = 0
  }
}

/**
 * 工作记忆：Map<cellId, activation>，单 turn 生命周期，硬上限 16。
 * "释放引用"不等于"删除数据"——turn 结束后只是清空这张表。
 */
export class WorkingSet {
  private map = new Map<string, number>()

  constructor(private readonly cap = 16) {}

  touch(cellId: bigint, activation: number): void {
    const k = cellId.toString(16)
    const prev = this.map.get(k) ?? 0
    // 取 max 而不是累加：同一轮反复召回不该把 activation 堆到无限大
    this.map.set(k, Math.min(1, Math.max(prev, activation)))
    if (this.map.size > this.cap) {
      // 超出上限按 activation 截断，保留最强的 16 个
      const kept = [...this.map.entries()].sort((a, b) => b[1] - a[1]).slice(0, this.cap)
      this.map = new Map(kept)
    }
  }

  activation(cellId: bigint): number {
    return this.map.get(cellId.toString(16)) ?? 0
  }

  /** 面板/诊断用：这轮最热的几个。 */
  top(n = 8): Array<{ cellId: string; activation: number }> {
    return [...this.map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([cellId, activation]) => ({ cellId, activation }))
  }

  clearTurn(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

/** FNV-1a 32 位，够做内容去重键；不做加密用途。 */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

function byteLen(s: string): number {
  // 中文按 3 字节估算即可，这里只需要一个容量口径
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3
  }
  return n
}
