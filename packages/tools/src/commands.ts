/**
 * 命令面（对应 §12.6）
 *
 * `/compact` 已在 0.2.x 内建，因此所有命令走 `/mnemo` 命名空间，避免命名冲突。
 *
 * 破坏性命令的三条 UI 规则在这里落地：
 *   1. 预览先行：`forget --before` 先列条目数与 3 条示例，确认后才执行
 *   2. 二次确认：`--hard` 需带 `--yes`（交互式 confirm 不可用时降级为这条）
 *   3. 可审计：所有破坏性操作写 memory/evict，面板可查最近 50 条
 *
 * 命令实现与宿主解耦：`runCommand()` 是纯函数式的文本协议，
 * 既能挂到 ctx.cmdline，也能在测试与 demo 里直接调。
 */

import { KIND_NAME, formatBreakdown, toHex, type MemoryService, type Preset } from '@rain13sad/dsh-mnemo-core'
import { AmbiguousCellIdError, resolveCellId } from './id.js'

export interface CommandDeps {
  memory: MemoryService
  affect?: {
    report(): Record<string, number | string>
    current(): { v: number; a: number; d: number; s: number }
    currentIntero(): Record<string, number>
    setIntero(patch: Record<string, number>): unknown
    snapshot(): unknown
    personaState?(): { rev: number; vector: number[]; baseline: number[]; history: Array<{ rev: number; vector: number[] }> }
    rollbackPersona?(rev: number): { ok: boolean; message: string }
    schema?(): Array<{ topic: string; pattern: string; confidence: number; support: number }>
  }
  setPreset?: (p: Preset) => void
  setSurfaceMode?: (m: 'rows' | 'compact' | 'prose') => void
  rebuild?: () => Promise<string> | string
  proactive?: {
    config: { enabled: boolean; minIntervalMin: number; maxPerDay: number; quietStart: number; quietEnd: number; idleMin: number; requireReason: boolean }
    snapshot(): { blocked: string | null; todayCount: number; lastAt: number; nextEligibleAt: number; lastCandidate: unknown; skipped: Array<{ at: number; reason: string }> }
    candidate(now?: number, opts?: { ignoreSchedule?: boolean }): unknown
    fire(c: unknown): void
    muteFor(ms: number): void
    unmute(): void
  }
  openPanel?: () => void
}

const HELP = `MnemoVault 命令
  /mnemo                       打开侧栏面板
  /mnemo search <q>            检索并列出命中（含分数）
  /mnemo why <id>              解释某条为何被召回
  /mnemo trace <q>             摊开一次召回：走了哪几条路、各自贡献多少
  /mnemo pin <id> | unpin      固定 / 取消固定
  /mnemo forget <id> [--hard] [--yes]     遗忘（默认软删）
  /mnemo forget --before <date> [--yes]   按时间批量遗忘（先预览）
  /mnemo preset <lean|balanced|fidelity|custom>
  /mnemo mode <rows|compact|prose>
  /mnemo affect                显示当前 PAD 与六变量
  /mnemo affect set <var> <v>  手动改内稳态变量（调试）
  /mnemo persona [rollback <rev>]  人格锚与版本链
  /mnemo schema                离线环抽出的用户图式
  /mnemo asof <date> <q>       按"当时认为"的口径检索（双时态）
  /mnemo lens <fact|feeling|bond|story> <q>   换一个角度看记忆
  /mnemo emotional             列出情感记忆（不参与衰减的那些）
  /mnemo associate <id>        联想链：想到这件事还会想到什么
  /mnemo reappraise <id>       用当前心境重估一条记忆的效价
  /mnemo proactive [on|off|now|mute <min>|unmute]  主动开口
  /mnemo stats                 命中率、token 曲线、存储比
  /mnemo doctor [--fix] [--unlock]
  /mnemo rebuild --from-log [--yes]
  /mnemo export [--user <id>]`

/**
 * 命令入口。
 *
 * 只包一层 try/catch，但这一层是必要的：`resolveId` 在短 id 撞车时会抛
 * `AmbiguousCellIdError`（v0.5.2 修 D23）。命令面必须把它变成**一句人话**，
 * 而不是让异常穿过 ctx.cmdline ——那会变成"命令没反应"。
 * 其他异常照旧抛出：静默吞掉编程错误比崩溃更难查。
 */
export async function runCommand(argv: string[], deps: CommandDeps): Promise<string> {
  try {
    return await runCommandInner(argv, deps)
  } catch (err) {
    if (err instanceof AmbiguousCellIdError) return err.message
    throw err
  }
}

async function runCommandInner(argv: string[], deps: CommandDeps): Promise<string> {
  const [cmd, ...rest] = argv
  const mem = deps.memory
  switch (cmd) {
    case undefined:
    case '':
    case 'help':
      deps.openPanel?.()
      return HELP

    case 'search': {
      const q = rest.join(' ').trim()
      if (!q) return '用法：/mnemo search <query>'
      const r = mem.recall({ text: q, budget: 400, manual: true })
      if (r.hits.length === 0) return `未命中（候选池 ${r.candidates}）`
      const lines = r.hits.map((h) => `${h.shortId}  ${h.score.toFixed(2)}  槽${h.slot + 1}  ${h.channel}`)
      return [`命中 ${r.hits.length} 条（候选 ${r.candidates}，${r.elapsedMs}ms，${r.tokens} token）`, ...lines, '', r.rendered].join('\n')
    }

    case 'why': {
      const id = rest[0]
      if (!id) return '用法：/mnemo why <id>'
      return mem.explain(id)
    }

    /**
     * `trace` —— 把一次召回**摊开**给人看（v0.5.2 补上，之前只在文档里有）。
     *
     * `why` 回答"这条为什么被选中"，`trace` 回答"这一次检索走了哪几条路、
     * 各自贡献了多少候选、最后为什么是这几条"。两者的区别是**单条 vs 整次**。
     * 全部走 `readOnly`：观察不该改变被观察的东西。
     */
    case 'trace': {
      const q = rest.join(' ').trim()
      if (!q) return '用法：/mnemo trace <query>'
      const r = mem.recall({ text: q, budget: 600, manual: true, readOnly: true })
      const lines = [
        `query  ${q}`,
        `策略   ${r.strategy}   候选 ${r.candidates}   耗时 ${r.elapsedMs} ms   token ${r.tokens}`,
        `槽位   ${r.slotsUsed} 已用 / ${r.emptySlots} 空（空槽合法，宁可少给也不凑）`,
        '',
      ]
      if (r.hits.length === 0) {
        lines.push('没有命中：ignition 阈值没到，或这条信息从未被写入。')
      } else {
        for (const h of r.hits) {
          lines.push(`  ${h.shortId}  ${h.score.toFixed(3)}  槽 ${h.slot + 1}  通道 ${h.channel}`)
        }
        lines.push('', '—— 得分最高的那条，分解如下 ——', formatBreakdown(r.breakdowns[0], mem.config.recall.ignition))
      }
      const idx = mem.indexInfo()
      lines.push('', `索引   ${idx.enabled ? 'SDR 倒排已启用' : '退回全扫'}  ${idx.note}`)
      return lines.join('\n')
    }

    case 'pin':
    case 'unpin': {
      const id = rest[0]
      if (!id) return '用法：/mnemo pin|unpin <id>'
      const r = mem.applyAction({ kind: 'pin', cellId: resolveId(mem, id), pinned: cmd === 'pin' })
      return r.message
    }

    case 'forget': {
      const hard = rest.includes('--hard')
      const yes = rest.includes('--yes')
      const beforeIdx = rest.indexOf('--before')
      if (beforeIdx >= 0) {
        const dateStr = rest[beforeIdx + 1]
        const ts = parseDate(dateStr)
        if (!ts) return '用法：/mnemo forget --before <YYYY-MM-DD>'
        const victims = mem.store.listCells({ until: ts, limit: 1000 })
        if (!yes) {
          const sample = victims.slice(0, 3).map((c) => `  ${toHex(c.cellId, 16).slice(-4)}  ${c.digest ?? ''}`).join('\n')
          return `将遗忘 ${victims.length} 条（早于 ${dateStr}）：\n${sample}\n\n确认请重跑并加 --yes`
        }
        for (const c of victims) mem.forget(toHex(c.cellId, 16), hard ? 'hard' : 'soft', 'user', `before ${dateStr}`)
        return `已遗忘 ${victims.length} 条（${hard ? 'hard' : 'soft'}）`
      }
      const id = rest.find((x) => !x.startsWith('--'))
      if (!id) return '用法：/mnemo forget <id> [--hard] [--yes]'
      if (hard && !yes) return '物理删除不可恢复。确认请重跑并加 --yes'
      const target = resolveId(mem, id)
      const cell = mem.store.getCell(BigInt('0x' + target))
      mem.forget(target, hard ? 'hard' : 'soft', 'user', 'command')
      return cell ? `已${hard ? '物理删除' : '软删除'} ${id}：${cell.digest ?? ''}` : `未找到 ${id}`
    }

    case 'preset': {
      const p = rest[0] as Preset | undefined
      if (!p) return '用法：/mnemo preset <lean|balanced|fidelity|custom>'
      if (!['lean', 'balanced', 'fidelity', 'custom'].includes(p)) return `未知预设档 ${p}`
      deps.setPreset?.(p)
      return `已切换到 ${p}（下一轮生效）`
    }

    case 'mode': {
      const m = rest[0] as 'rows' | 'compact' | 'prose' | undefined
      if (!m || !['rows', 'compact', 'prose'].includes(m)) return '用法：/mnemo mode <rows|compact|prose>'
      deps.setSurfaceMode?.(m)
      return `渲染格式 → ${m}（下一轮生效）`
    }

    case 'affect': {
      if (!deps.affect) return '情感内核未安装（只装 core 的部署会走降级路径）'
      if (rest[0] === 'set') {
        const key = rest[1]
        const val = Number(rest[2])
        if (!key || Number.isNaN(val)) return '用法：/mnemo affect set <load|uncert|conflict|strain|progress|budget> <0..1>'
        deps.affect.setIntero({ [key]: val })
        return `${key} → ${val}`
      }
      const r = deps.affect.report()
      const pad = deps.affect.current()
      return [
        `PAD  ${pad.v.toFixed(2)} / ${pad.a.toFixed(2)} / ${pad.d.toFixed(2)}   salience ${pad.s.toFixed(2)}`,
        `内稳态 ${Object.entries(deps.affect.currentIntero()).map(([k, v]) => `${k}=${Number(v).toFixed(2)}`).join(' ')}`,
        `关系  trust=${r.trust} fam=${r.familiarity} attune=${r.attunement} debt=${r.repair_debt}`,
        `边界  ${r.boundaries || '（无）'}`,
        `说明  ${r.disclaimer}`,
      ].join('\n')
    }

    case 'persona': {
      if (!deps.affect?.personaState) return '情感内核未安装'
      const st = deps.affect.personaState()
      if (rest[0] === 'rollback') {
        const rev = Number(rest[1])
        if (Number.isNaN(rev)) return '用法：/mnemo persona rollback <rev>'
        return deps.affect.rollbackPersona?.(rev)?.message ?? '回滚失败'
      }
      const drift = Math.sqrt(st.vector.reduce((n, x, i) => n + (x - (st.baseline[i] ?? 0)) ** 2, 0))
      return [
        `rev ${st.rev}  漂移 ‖Δ‖=${drift.toFixed(3)}（上限 0.25，只在超界时收缩）`,
        `当前 ${st.vector.map((x) => x.toFixed(2)).join(' / ')}`,
        `基线 ${st.baseline.map((x) => x.toFixed(2)).join(' / ')}`,
        `历史 ${st.history.map((h) => 'r' + h.rev).join(' ')}`,
        '回滚：/mnemo persona rollback <rev>',
      ].join('\n')
    }

    case 'schema': {
      const patterns = deps.affect?.schema?.() ?? []
      if (patterns.length === 0) return '还没有足够样本（离线环每 40 轮抽一次，样本 < 12 不产结论）'
      return ['离线环抽出的图式：', ...patterns.map((p) => `  · ${p.pattern}（support ${p.support}，置信 ${p.confidence.toFixed(2)}）`)].join('\n')
    }

    case 'asof': {
      const dateStr = rest[0]
      const q = rest.slice(1).join(' ').trim()
      const ts = parseDate(dateStr)
      if (!ts || !q) return '用法：/mnemo asof <YYYY-MM-DD> <query>'
      const r = mem.recall({ text: q, budget: 400, manual: true, asOf: ts })
      const head = `截至 ${dateStr} 的口径：命中 ${r.hits.length} 条`
      return [head, r.rendered || '（当时没有相关记忆）'].join('\n')
    }

    case 'lens': {
      const which = rest[0]
      const q = rest.slice(1).join(' ').trim()
      if (!['fact', 'feeling', 'bond', 'story'].includes(which ?? '') || !q) {
        return '用法：/mnemo lens <fact|feeling|bond|story> <query>'
      }
      const r = mem.recall({ text: q, budget: 400, manual: true, lens: which as never })
      return [`视角「${which}」：命中 ${r.hits.length} 条`, r.rendered || '（这个视角下没有相关记忆）'].join('\n')
    }

    case 'emotional': {
      const all = mem.store.listCells({ limit: 500, order: 'recent' })
      const emo = all.filter((c) => ((c.flags ?? 0) & 64) !== 0)
      if (emo.length === 0) return '还没有情感记忆（|效价| ≥ 0.45 或 显著度 ≥ 0.75 的会被标记）'
      return [
        `情感记忆 ${emo.length} 条（不参与情绪衰减，最多降到温层）：`,
        ...emo.slice(0, 15).map((c) => `  ${toHex(c.cellId, 16).slice(-4)}  V${c.valence.toFixed(2)} S${c.salience.toFixed(2)}  ${c.digest ?? ''}`),
      ].join('\n')
    }

    case 'associate': {
      const id = rest[0]
      if (!id) return '用法：/mnemo associate <id>'
      const chain = mem.associate(resolveId(mem, id), { depth: 2, limit: 10 })
      if (chain.length === 0) return '这条记忆还没有联想（多聊几次、或跑一次巩固会让它们连起来）'
      return [
        `从 ${id} 出发的联想链：`,
        ...chain.map((x) => `  ${'→'.repeat(x.hop)} ${x.shortId}  ${x.score.toFixed(2)}  [${x.lens}]  ${x.digest}`),
      ].join('\n')
    }

    case 'reappraise': {
      const id = rest[0]
      if (!id) return '用法：/mnemo reappraise <id>'
      const affect = deps.affect as { reappraise?(x: string): { ok: boolean; message: string } } | undefined
      if (!affect?.reappraise) return '情感内核未安装'
      return affect.reappraise(resolveId(mem, id)).message
    }

    case 'proactive': {
      const pro = deps.proactive
      if (!pro) return '未安装 mnemo-proactive'
      const sub = rest[0]
      if (sub === 'on' || sub === 'off') {
        pro.config.enabled = sub === 'on'
        return `主动开口已${sub === 'on' ? '开启' : '关闭'}`
      }
      if (sub === 'mute') {
        const min = Number(rest[1] ?? 120)
        pro.muteFor(min * 60_000)
        return `已静音 ${min} 分钟`
      }
      if (sub === 'unmute') {
        pro.unmute()
        return '已解除静音'
      }
      if (sub === 'now') {
        const c = pro.candidate(Date.now(), { ignoreSchedule: true })
        if (!c) return '当前没有值得主动说的由头'
        pro.fire(c)
        const cand = c as { text: string; reason: string }
        return [`已生成主动开口（${cand.reason}）：`, cand.text].join('\n')
      }
      const st = pro.snapshot()
      const c = pro.config
      return [
        `状态 ${c.enabled ? '开启' : '关闭'}　今日 ${st.todayCount}/${c.maxPerDay}　${st.blocked ? '当前不会说话：' + st.blocked : '当前可以开口'}`,
        `间隔 ${c.minIntervalMin} 分　静默 ${c.quietStart}–${c.quietEnd} 点　空闲阈值 ${c.idleMin} 分`,
        st.lastCandidate ? `候选：${JSON.stringify(st.lastCandidate).slice(0, 160)}` : '候选：无',
        ...st.skipped.slice(-3).map((x) => `  跳过：${x.reason}`),
      ].join('\n')
    }

    case 'stats': {
      const s = mem.stats()
      const spark = sparkline(s.tokenSeries.map((x) => x.tokens))
      return [
        `cell ${s.cells}  edge ${s.edges}  存储 ${(s.bytes / 1024).toFixed(1)} KB  存储比 ${s.storageRatio.toFixed(2)}×`,
        `命中率 ${(s.hitRate * 100).toFixed(0)}%  tokens/轮 ${s.tokensPerTurn.toFixed(0)}  p95 ${s.recallP95Ms}ms`,
        `分层 ${Object.entries(s.byTier).map(([k, v]) => `${k}:${v}`).join(' ')}`,
        `类型 ${Object.entries(s.byKind).map(([k, v]) => `${k}:${v}`).join(' ')}`,
        `support=1 占比 ${((s.supportOne / Math.max(1, s.cells)) * 100).toFixed(0)}%  争议 ${s.disputed}  矛盾边 ${s.contradictions}`,
        `token 曲线 ${spark}`,
      ].join('\n')
    }

    case 'doctor': {
      const d = mem.doctor({ fix: rest.includes('--fix'), unlock: rest.includes('--unlock') })
      return [
        d.ok ? '✓ 体检通过' : '✗ 发现问题',
        `孤儿边 ${d.orphanEdges}  悬空槽 ${d.danglingSlots}  遗留锁 ${d.staleLocks}  布局 v${d.layoutVersion} D=${d.sdrDim}`,
        ...d.issues.map((i) => `  · ${i}`),
        ...d.fixed.map((f) => `  ✓ ${f}`),
      ].join('\n')
    }

    case 'rebuild': {
      if (!rest.includes('--from-log')) return '用法：/mnemo rebuild --from-log [--yes]'
      if (!rest.includes('--yes')) {
        const cells = mem.store.countCells()
        return `重建会丢弃现有晶格（${cells} 条 cell）并从会话日志重放。\n确认请加 --yes。`
      }
      if (!deps.rebuild) return '当前部署未提供 rebuild 钩子（需要 mnemo-encoder）'
      const out = await deps.rebuild()
      return out
    }

    case 'export': {
      const cells = mem.store.listCells({ limit: 5000 })
      const lines = cells.map((c) => {
        const kv = c.slots.filter((s) => s.type === 'LIT').map((s) => `${s.value}`).join(' / ')
        return `[${toHex(c.cellId, 16).slice(-4)}] ${new Date(Number(c.tFrom)).toISOString().slice(0, 10)} ${KIND_NAME[c.kind]}  ${kv}`
      })
      return [`共 ${cells.length} 条`, ...lines].join('\n')
    }

    default:
      return `未知命令 ${cmd}\n\n${HELP}`
  }
}

/**
 * id 解析：支持 4 位短 id 与完整 16 位 hex。
 *
 * v0.5.2：实现移到 `id.ts`，撞车时抛 `AmbiguousCellIdError` 而不是静默取第一个。
 * 这个函数保留原名只是为了不破坏既有调用点与测试。
 */
export function resolveId(mem: MemoryService, short: string): string {
  return resolveCellId(mem, short)
}

function parseDate(s: string | undefined): number | undefined {
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

function sparkline(xs: number[]): string {
  if (xs.length === 0) return '（无数据）'
  const chars = '▁▂▃▄▅▆▇█'
  const max = Math.max(...xs, 1)
  return xs.map((x) => chars[Math.min(chars.length - 1, Math.floor((x / max) * (chars.length - 1)))]).join('')
}

export { formatBreakdown }
