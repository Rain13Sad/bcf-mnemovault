#!/usr/bin/env node
/**
 * v0.7.3 · 验证层 CI 门槛（与 ci-assert-bench.mjs 同一风格）
 *
 * 只断言**机制证据**，不把"机制通过"包装成"质量达标"：
 * 这些数字是自建语料上的确定性判据，不是公开基准分数。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const path = join(root, 'artifacts', 'bench-verify.json')
if (!existsSync(path)) {
  console.error('缺少 artifacts/bench-verify.json：先跑 npm run bench:verify')
  process.exit(1)
}
const r = JSON.parse(readFileSync(path, 'utf8'))
const s = r.sections ?? {}
const problems = []

if (r.version !== '0.7.3') problems.push(`版本标记是 ${r.version}，应为 0.7.3`)
if (!r.overall?.ok) problems.push(`验证层 ${r.overall?.passed ?? 0}/${r.overall?.total ?? 0} 通过`)
for (const [name, sec] of Object.entries(s)) if (!sec?.pass) problems.push(`${name} 未通过`)

// 红线 1：写入侧与读取侧都不许跨租户污染
if ((s.crossContamination?.ownCellsInvalidatedByOtherTenant ?? -1) !== 0) problems.push('跨租户写入把对方 cell 标为失效')
if (s.crossContamination?.leaked !== false) problems.push('交叉查询泄漏对方实体或判成 hit')

// A8：写入完整性首次量化，低于 0.75 视为规则抽取退化
if ((s.storageCoverage?.cov ?? 0) < 0.75) problems.push(`存储完整性 Cov ${s.storageCoverage?.cov} < 0.75`)

// B12 / C10：情感权重必须真的进打分（有代码没效果 = 0 差值）
if (Math.abs(s.affectAblation?.deltaAffect ?? 0) < 1e-6) problems.push('心境一致权重对打分无影响（结构耦合退化为拼装）')

// D9 / E2 / D7：三项工程底线
if (s.faultInjection?.transactionRolledBack !== true) problems.push('SQLite 写入中途失败没有回滚')
if (s.purgeIntegrity?.audit?.ok !== true) problems.push('purge 后仍有派生层残留')
if (s.lockConcurrency?.secondOwnerBlocked !== true || s.lockConcurrency?.expiredLockTakeover !== true) {
  problems.push('跨进程锁互斥或 TTL 抢占失效')
}

// v0.7.3 新增三节：安全红线、短 id 解析、词典配置化
if (s.securityRedLines?.tuneBlocked !== true || s.securityRedLines?.traversalBlocked !== true) {
  problems.push('运行时调参红线或恢复路径穿越防护失效')
}
if (s.idResolution?.explainResolvesFullId !== true || s.idResolution?.pinAppliesToRealCell !== true) {
  problems.push('短 id 解析仍会指向不存在的 cell')
}
if (s.extractionConfig?.lexiconInjectionEffective !== true || s.extractionConfig?.builtinRuleOrderPreserved !== true) {
  problems.push('抽取词典注入未生效或破坏了内置谓词顺序')
}

if (problems.length) {
  for (const p of problems) console.error(`FAIL  ${p}`)
  console.error(`\n验证层门槛未通过（${problems.length} 项）。详见 artifacts/bench-verify.json`)
  process.exit(1)
}
console.log(`验证层门槛通过：${r.overall.passed}/${r.overall.total} 节 · Cov ${s.storageCoverage.cov} · 情感消融 Δ ${s.affectAblation.deltaAffect}`)
