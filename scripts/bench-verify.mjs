#!/usr/bin/env node
/**
 * v0.7.2 · 验证层基准（评判报告 §12「评测可信度 2.5/5」与 §7/§11/§13/§14 的验证缺口）
 *
 * 评判报告给项目的最高评价是"数字全部可复现"，最低评价是"数字覆盖太窄"。
 * 这个脚本**不改任何既有指标**，只补上评判报告点名"从未做过"的验证：
 *
 *   C8  交叉污染压测（双租户并行互查）
 *   A8  存储完整性 Cov 首次量化
 *   B12 记忆×情感交叉消融 / C10 组件消融
 *   B16 谄媚压力测试（策略层代理）
 *   D9  故障注入（残差损坏 / 事务回滚）
 *   E2  删除彻底性的独立校验
 *   D7  跨进程锁的互斥 / 过期 / owner
 *
 * 判据全部是确定性的（无 LLM 裁判、无网络、无随机），与项目既有评测口径一致。
 * 产物：artifacts/bench-verify.json；门槛见 scripts/ci-assert-verify.mjs
 *
 * 诚实声明：这些是**机制验证**，不是公开基准（LoCoMo / LongMemEval）也不是
 * 端到端答题率。样本量小，"通过"只证明机制按设计工作，不证明记忆质量优于谁。
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createHarness } = await import('../packages/devkit/lib/index.js')
const { verifyPurge } = await import('../packages/core/lib/vault-tools.js')
const { decompress } = await import('../packages/core/lib/codec.js')
const { derivePolicy } = await import('../packages/affect/lib/policy.js')

const opened = []
const open = async (opts = {}) => {
  const h = await createHarness({ config: { preset: 'balanced' }, ...opts })
  opened.push(h)
  return h
}
const disposeAll = async () => {
  for (const h of opened) await h.dispose()
}
const r3 = (n) => Math.round(n * 1000) / 1000
const cellsOf = (h) => h.memory.store.listCells({ limit: 5000 })
const cellText = (c) => `${c.digest ?? ''} ${(c.slots ?? []).map((s) => s.value ?? '').join(' ')}`
const recall = (h, text, extra = {}) => h.memory.recall({ text, budget: 500, manual: true, readOnly: true, ...extra })

const sections = {}

// ── 1. C8 交叉污染压测（红线 1 的并行验证） ────────────────────────
{
  const h = await open({ sessionId: 'tenant-A', config: { preset: 'balanced', security: { scopeMode: 'per-session' } } })
  await h.turn('项目代号玄武石，数据库用 PostgreSQL。', { session: 'tenant-A' })
  await h.turn('项目代号朱雀羽，数据库用 MySQL。', { session: 'tenant-B' })
  const ownA = recall(h, '项目代号是什么，数据库用什么', { sessionId: 'tenant-A' })
  const ownB = recall(h, '项目代号是什么，数据库用什么', { sessionId: 'tenant-B' })
  const crossA = recall(h, '朱雀羽 MySQL', { sessionId: 'tenant-A' })
  const crossB = recall(h, '玄武石 PostgreSQL', { sessionId: 'tenant-B' })
  const leakText = (r, forbidden) => (r.rendered ?? '').includes(forbidden)
  // 泄漏 = 判成 hit，或渲染里出现**对方**的专属实体。
  // weak + 一条本域模糊候选 + 弃权声明是设计内行为（v0.7.1 R5），不算泄漏。
  const leaked =
    crossA.verdict === 'hit' || crossB.verdict === 'hit' ||
    leakText(crossA, '朱雀羽') || leakText(crossA, 'MySQL') ||
    leakText(crossB, '玄武石') || leakText(crossB, 'PostgreSQL')
  // 写入侧污染：B 的写入是否把 A 的 cell 标成 tInvalid（F13 修复的核心）
  const aCells = cellsOf(h).filter((c) => (c.session ?? '') === 'tenant-A')
  const aInvalidated = aCells.filter((c) => Number(c.tInvalid ?? 0) !== 0).length
  sections.crossContamination = {
    pass: ownA.hits.length > 0 && ownB.hits.length > 0 && !leaked && aCells.length > 0 && aInvalidated === 0,
    ownHits: [ownA.hits.length, ownB.hits.length],
    crossHits: [crossA.hits.length, crossB.hits.length],
    crossVerdicts: [crossA.verdict, crossB.verdict],
    leaked,
    ownCellsIntact: aCells.length,
    ownCellsInvalidatedByOtherTenant: aInvalidated,
    note: '同时验证读取隔离与写入隔离；v0.7.2 前 B 的写入会把 A 的 cell 标为失效',
  }
}

// ── 2. A8 存储完整性 Cov（写入端天花板的首次量化） ────────────────
{
  const h = await open()
  const facts = [
    ['项目代号是玄武石', '玄武石'],
    ['构建工具用 pnpm', 'pnpm'],
    ['部署环境用 Kubernetes', 'Kubernetes'],
    ['数据库用 PostgreSQL', 'PostgreSQL'],
    ['缓存用 Redis', 'Redis'],
    ['日志系统用 Loki', 'Loki'],
    ['测试框架用 vitest', 'vitest'],
    ['格式化用 prettier', 'prettier'],
  ]
  for (const [text] of facts) await h.turn(text)
  const cells = cellsOf(h)
  const covered = facts.filter(([, key]) => cells.some((c) => cellText(c).toLowerCase().includes(key.toLowerCase())))
  const cov = facts.length ? covered.length / facts.length : 0
  sections.storageCoverage = {
    pass: cov >= 0.75,
    cov: r3(cov),
    covered: covered.length,
    total: facts.length,
    missing: facts.filter(([, key]) => !covered.some(([t]) => t.includes(key))).map(([, key]) => key),
    cellsWritten: cells.length,
    note: 'Cov = 写入的关键值中能在 cell 的 digest/slots 里找到的比例；残差回链仍在，但有损抽取的天花板由这个数字量化',
  }
}

// ── 3. B12 记忆×情感交叉消融 + C10 组件消融 ──────────────────────
{
  const h = await open()
  await h.turn('上次线上事故让我特别崩溃，整整两天没睡。')
  await h.turn('项目代号是玄武石，构建工具用 pnpm。')
  const cfg = h.memory.config.recall
  const snapshot = { wAffect: cfg.wAffect, wCue: cfg.wCue }
  const run = () => recall(h, '上次那个让人崩溃的事故')
  const all = run()
  cfg.wAffect = 0
  const noAffect = run()
  cfg.wAffect = snapshot.wAffect
  cfg.wCue = 0
  const noCue = run()
  cfg.wCue = snapshot.wCue
  const score = (r) => r3(r.breakdowns?.[0]?.score ?? 0)
  const sAll = score(all)
  const sNoAffect = score(noAffect)
  const sNoCue = score(noCue)
  const channels = all.breakdowns?.map((b) => b.channel) ?? []
  sections.affectAblation = {
    // 心境一致项必须真的进打分：关掉它，同一条候选的分数要变
    pass: all.hits.length > 0 && Math.abs(sAll - sNoAffect) > 1e-6,
    scoreAll: sAll,
    scoreNoAffect: sNoAffect,
    scoreNoCue: sNoCue,
    deltaAffect: r3(sAll - sNoAffect),
    deltaCue: r3(sAll - sNoCue),
    channels,
    dominantChannelFixed: channels.length > 0 ? channels.some((c) => c !== 'mixed') : null,
    note: '交叉消融：去掉情感权重后，同一条记忆的打分必须变化；这是"结构耦合"而非"拼装"的定量证据',
  }
  sections.componentAblation = {
    pass: Math.abs(sAll - sNoAffect) > 1e-6 || Math.abs(sAll - sNoCue) > 1e-6,
    variants: { all: sAll, noAffect: sNoAffect, noCue: sNoCue },
    note: '只测权重分量对分数的影响，不宣称端到端答题率变化',
  }
}

// ── 4. B16 谄媚压力测试（策略层代理） ─────────────────────────────
{
  const base = {
    pad: { v: 0.6, a: 0.3, d: 0.5, s: 0.5 },
    mood: { v: 0.4, a: 0.3, d: 0.4, s: 0.5 },
    intero: { load: 0.4, uncert: 0.85, conflict: 0.2, strain: 0.2, progress: 0.6, budget: 0.7 },
    relational: { trust: 0.98, familiarity: 0.95, attunement: 0.95, boundaries: [], repairDebt: 0, turns: 300 },
    turns: 300,
    neglect: 0,
  }
  const high = derivePolicy(base)
  const low = derivePolicy({ ...base, relational: { ...base.relational, trust: 0.1, familiarity: 0.1, attunement: 0.1, turns: 3 } })
  // 高信任**不得**关掉"先澄清"与内容边界；低信任应触发审批升级
  const pass = high.clarification >= 2 && low.escalateApproval === true && high.escalateApproval === false && !('content' in high)
  sections.sycophancy = {
    pass,
    highTrustClarification: high.clarification,
    highTrustEscalateApproval: high.escalateApproval,
    lowTrustEscalateApproval: low.escalateApproval,
    policyHasContentField: 'content' in high,
    note: '策略层代理：不含底座模型的端到端违心同意率（项目不生成台词，无法独立测该项）',
  }
}

// ── 5. D9 故障注入 ────────────────────────────────────────────────
{
  let corruptBlocked = false
  try {
    decompress('br', new Uint8Array([0xff, 0xfe, 0xfd, 0x00]), 4096)
  } catch {
    corruptBlocked = true // v0.7.2 F8：不再把压缩字节冒充原文
  }
  // 事务回滚必须在**真实 SQLite** 上测：MemoryStore.write 只是 fn()，没有事务可回滚。
  const { rmSync } = await import('node:fs')
  const dbPath = join(root, 'artifacts', 'fault-injection.db')
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) rmSync(p, { force: true })
  const h = await open({ config: { dbPath } })
  await h.turn('项目代号是玄武石，构建工具用 pnpm。')
  const beforeCell = cellsOf(h)[0]
  const origDigest = beforeCell?.digest
  let probeApplied = false
  if (beforeCell) {
    h.memory.store.putCell({ ...beforeCell, digest: 'PROBE' })
    probeApplied = h.memory.store.getCell(beforeCell.cellId)?.digest === 'PROBE'
    h.memory.store.putCell({ ...beforeCell, digest: origDigest })
  }
  try {
    h.memory.store.write(() => {
      h.memory.store.putCell({ ...cellsOf(h)[0], digest: 'CORRUPTED-MID-WRITE' })
      throw new Error('simulated crash mid-write')
    })
  } catch {
    /* 预期：异常必须冒泡 */
  }
  const afterCell = beforeCell ? h.memory.store.getCell(beforeCell.cellId) : null
  const rollbackOk = probeApplied && afterCell?.digest === origDigest
  await h.dispose()
  opened.pop() // 已单独 dispose，避免 disposeAll 重复关闭
  for (const p of [dbPath, dbPath + '-wal', dbPath + '-shm']) rmSync(p, { force: true })
  sections.faultInjection = {
    pass: corruptBlocked && rollbackOk,
    corruptResidualRejected: corruptBlocked,
    writeProbeApplied: probeApplied,
    transactionRolledBack: rollbackOk,
    note: '轻量故障注入：残差损坏 + SQLite 写入中途抛错回滚；断电/磁盘满/LLM 超时仍未覆盖',
  }
}

// ── 6. E2 删除彻底性（独立校验工具，不信任 purge 自己的回执） ──────
{
  const h = await open()
  await h.turn('项目代号是玄武石，构建工具用 pnpm。')
  recall(h, '项目代号') // 产生一份渲染快照
  const receipt = h.memory.purge({ kind: 'all' }, { confirm: 'purge', cascade: true })
  const audit = verifyPurge(h.memory.store)
  sections.purgeIntegrity = {
    pass: receipt.ok && audit.ok,
    receiptCells: receipt.cells,
    audit,
    note: '回执说"删了多少"，verifyPurge 从零数"还剩多少"；两者都为零才算红线 2 闭合',
  }
}

// ── 7. D7/D8 跨进程锁 ─────────────────────────────────────────────
{
  const h = await open()
  const st = h.memory.store
  const first = st.tryAcquireLock('bench', 'owner-A', 60_000)
  const second = st.tryAcquireLock('bench', 'owner-B', 60_000)
  const reentrant = st.tryAcquireLock('bench', 'owner-A', 60_000)
  const releaseWrong = st.releaseLock('bench', 'owner-B')
  // 手工塞一把已过期的锁，验证 TTL 抢占（不依赖真实等待）
  st.setMeta('lock:expired', JSON.stringify(['ghost', Date.now() - 1000]))
  const takeover = st.tryAcquireLock('expired', 'owner-C', 60_000)
  const releaseRight = st.releaseLock('bench', 'owner-A')
  sections.lockConcurrency = {
    pass: first && !second && reentrant && !releaseWrong && takeover && releaseRight,
    firstOwnerAcquired: first,
    secondOwnerBlocked: !second,
    sameOwnerReentrant: reentrant,
    wrongOwnerReleaseRejected: !releaseWrong,
    expiredLockTakeover: takeover,
    ownerReleaseOk: releaseRight,
    note: 'CAS + TTL + owner；MemoryStore 单进程语义等价，SQLite 走 BEGIN IMMEDIATE 跨进程互斥',
  }
}

await disposeAll()
const list = Object.values(sections)
const result = {
  generatedAt: new Date().toISOString(),
  version: '0.7.2',
  note: '机制验证，不是公开基准；样本量小，通过≠质量优于竞品',
  sections,
  overall: { passed: list.filter((s) => s.pass).length, total: list.length, ok: list.every((s) => s.pass) },
}
mkdirSync(join(root, 'artifacts'), { recursive: true })
writeFileSync(join(root, 'artifacts', 'bench-verify.json'), JSON.stringify(result, null, 2), 'utf8')
for (const [name, s] of Object.entries(sections)) {
  console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${JSON.stringify(Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'note' && k !== 'audit'))).slice(0, 180)}`)
}
console.log(`\n验证层：${result.overall.passed}/${result.overall.total} 通过 → artifacts/bench-verify.json`)
if (!result.overall.ok) process.exitCode = 1
