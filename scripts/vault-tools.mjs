#!/usr/bin/env node
/**
 * v0.7.2 · 运维工具链 CLI（评判报告 §13 / §14：E2 / E6 / D6 / D11）
 *
 * 用法：
 *   node scripts/vault-tools.mjs export   --db <vault.db> --out <bundle.json> [--no-raw]
 *   node scripts/vault-tools.mjs validate --in  <bundle.json>
 *   node scripts/vault-tools.mjs verify   --db <vault.db> [--session <id>]
 *   node scripts/vault-tools.mjs metrics  --db <vault.db>
 *   node scripts/vault-tools.mjs backup   --db <vault.db> --dir <backupDir>
 *   node scripts/vault-tools.mjs restore  --from <backupDir> --db <vault.db> --yes
 *
 * 设计边界：
 *   · export 走 core 的 exportBundle（只读、全量、带校验和），不是 listCells(5000)
 *   · backup/restore 是**文件级**复制（vault.db + wal + shm + blob/），
 *     因此是真正无损的，RPO = 最后一次备份；restore 要求库已关闭且不覆盖无确认的库
 *   · 不做"把 JSON 导回成同 id 晶格"，那是 rebuild --from-log 的职责
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync, statSync, renameSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createHarness } = await import('../packages/devkit/lib/index.js')
const { exportBundle, validateBundle, verifyPurge, metricsText } = await import('../packages/core/lib/vault-tools.js')

const argv = process.argv.slice(2)
const cmd = argv[0] ?? ''
const flag = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback
}
const has = (name) => argv.includes('--' + name)
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const withMemory = async (dbPath, fn) => {
  if (!dbPath || !existsSync(dbPath)) throw new Error(`找不到库文件：${dbPath ?? '(未指定 --db)'}`)
  const h = await createHarness({ config: { dbPath }, plugins: ['core'] })
  try {
    return await fn(h.memory)
  } finally {
    await h.dispose()
  }
}

const fail = (msg) => {
  console.error(`ERROR ${msg}`)
  process.exitCode = 1
}

switch (cmd) {
  case 'export': {
    const db = flag('db')
    const out = flag('out', 'artifacts/vault-bundle.json')
    const bundle = await withMemory(db, (mem) => exportBundle(mem, { includeRaw: !has('no-raw') }))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(bundle, null, 2), 'utf8')
    console.log(`导出完成：${out}`)
    console.log(`  cells=${bundle.counts.cells} edges=${bundle.counts.edges} logs=${bundle.counts.logs} residuals=${bundle.counts.residuals} snapshots=${bundle.counts.snapshots}`)
    console.log(`  checksum=${bundle.checksum}`)
    break
  }
  case 'validate': {
    const input = flag('in')
    if (!input || !existsSync(input)) throw new Error(`找不到文件：${input ?? '(未指定 --in)'}`)
    const raw = JSON.parse(readFileSync(input, 'utf8'))
    const r = validateBundle(raw)
    console.log(`format=${raw.format} schema=${raw.schema} cells=${raw.cells?.length ?? '?'} checksum=${r.checksum}`)
    if (r.ok) console.log('校验通过：格式、条数、完整性一致')
    else {
      for (const i of r.issues) console.error('  - ' + i)
      process.exitCode = 1
    }
    break
  }
  case 'verify': {
    const db = flag('db')
    const session = flag('session')
    const a = await withMemory(db, (mem) => verifyPurge(mem.store, session ? { session } : {}))
    console.log(JSON.stringify(a, null, 2))
    if (!a.ok) console.log(`\n未清空：${a.issues.join('；')}`)
    break
  }
  case 'metrics': {
    const db = flag('db')
    const text = await withMemory(db, (mem) => metricsText(mem))
    process.stdout.write(text)
    break
  }
  case 'backup': {
    const db = flag('db')
    const dir = flag('dir', 'artifacts/backup-' + new Date().toISOString().replace(/[:.]/g, '-'))
    if (!db || !existsSync(db)) throw new Error(`找不到库文件：${db ?? '(未指定 --db)'}`)
    mkdirSync(dir, { recursive: true })
    // SQLite WAL 模式下 -wal/-shm 与 db 同属一份逻辑数据，必须一起复制。
    const files = [db, db + '-wal', db + '-shm'].filter((p) => existsSync(p))
    const manifest = { createdAt: new Date().toISOString(), version: '0.7.2', source: resolve(db), files: [] }
    for (const p of files) {
      const dst = join(dir, basename(p))
      copyFileSync(p, dst)
      manifest.files.push({ name: basename(p), bytes: statSync(dst).size, sha256: sha256(dst) })
    }
    // 残差独立目录（若宿主配置了外置 blob）也一并带走
    const blobDir = join(dirname(db), 'blob')
    if (existsSync(blobDir)) {
      const dstDir = join(dir, 'blob')
      mkdirSync(dstDir, { recursive: true })
      for (const f of readdirSync(blobDir)) {
        copyFileSync(join(blobDir, f), join(dstDir, f))
        manifest.files.push({ name: 'blob/' + f, bytes: statSync(join(dstDir, f)).size, sha256: sha256(join(dstDir, f)) })
      }
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
    console.log(`备份完成：${dir}（${manifest.files.length} 个文件）`)
    console.log('  RPO = 本次备份时刻；恢复前请停止写入进程。')
    break
  }
  case 'restore': {
    const from = flag('from')
    const db = flag('db')
    if (!has('yes')) {
      fail('恢复会覆盖现有库，确认请加 --yes（先自行备份当前库）')
      break
    }
    if (!from || !existsSync(join(from, 'manifest.json'))) throw new Error(`找不到备份清单：${from}/manifest.json`)
    const m = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'))
    for (const f of m.files) {
      const src = join(from, f.name)
      if (!existsSync(src)) throw new Error(`备份文件缺失：${src}`)
      if (sha256(src) !== f.sha256) throw new Error(`备份文件校验失败：${f.name}`)
    }
    // 先写临时文件再原子替换，避免中途失败留下半份库
    mkdirSync(dirname(db), { recursive: true })
    for (const f of m.files) {
      const suffix = f.name.endsWith('-wal') ? '-wal' : f.name.endsWith('-shm') ? '-shm' : ''
      const dst = f.name.startsWith('blob/') ? join(dirname(db), f.name) : db + suffix
      mkdirSync(dirname(dst), { recursive: true })
      const tmp = dst + '.restoring'
      copyFileSync(join(from, f.name), tmp)
      renameSync(tmp, dst)
    }
    // 恢复后清掉可能残留的临时文件
    for (const f of readdirSync(dirname(db))) {
      if (f.endsWith('.restoring')) rmSync(join(dirname(db), f), { force: true })
    }
    console.log(`恢复完成：${db}（${m.files.length} 个文件，校验和全部匹配）`)
    break
  }
  default:
    fail(`未知子命令 ${cmd || '(空)'}。可用：export / validate / verify / metrics / backup / restore`)
}
