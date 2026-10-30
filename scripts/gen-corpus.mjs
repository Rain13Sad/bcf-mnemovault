/**
 * 合成语料生成器（v0.5.2，对应方案 §3.5 / D15 / D25）。
 *
 * ── 为什么不走真实 ingest ────────────────────────────────────────
 * 走 `ingest` 造 10 万 cell 要 6 小时以上（每轮都要去重 + 冲突检测 + 落残差）。
 * CI 里不可行，本地也等不起。
 *
 * ── 这个语料**不是**真实库 ──────────────────────────────────────
 * 它用批量 `putCell` + 合成边造出来，所以：
 *   · 边密度是**指定值**，不是对话里长出来的；
 *   · 访问历史是均匀的，没有"常用的那几条"；
 *   · 没有残差（原文），存储比在这里不可比。
 *
 * 因此：**Recall@8 在合成语料上的数字不能与真实库比较**。
 * 它只用来测**延迟与吞吐**（这才是规模问题），以及验证索引剪枝比。
 * 这个口径必须写进输出与 README——否则后代会拿它当真实数据引用，
 * 那正是 D13「bench 是自证的」走过的老路。
 *
 *   node scripts/gen-corpus.mjs 10000 --db /tmp/corpus.db
 */
import { SdrSpace, hashEmbedding, deriveCellId, createStore, KIND, REL } from '@rain13sad/dsh-mnemo-core'
import { rmSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const ROLE_NAMES = ['AGENT', 'PRED', 'PATIENT', 'MANNER', 'POLARITY', 'TOPIC']
const PREDS = ['uses', 'prefers', 'decides', 'deploys', 'dislikes', 'changes']
const WORDS = [
  'pnpm', 'bun', 'npm', 'yarn', 'vite', 'esbuild', 'rollup', 'jest', 'vitest', 'eslint',
  'typescript', 'react', 'preact', 'solid', 'svelte', 'node', 'deno', 'python', 'rust', 'go',
  'sqlite', 'postgres', 'redis', 'kafka', 'nginx', 'docker', 'k8s', 'terraform', 'grafana', 'sentry',
  'dark', 'light', 'mono', 'sans', 'serif', 'compact', 'rows', 'prose', 'i18n', 'a11y',
]

/** 确定性伪随机（mulberry32）：同一 seed 永远得到同一语料，bench 才可比。 */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 生成一个语料库。
 *
 * @param {object} opts
 * @param {number} opts.cells     cell 条数
 * @param {string} opts.dbPath    落盘路径（:memory: 也可）
 * @param {number} [opts.edgesPerCell] 每条 cell 的出边数（合成边）
 * @param {number} [opts.seed]
 * @param {boolean} [opts.verbose]
 */
export async function generateCorpus(opts) {
  const { cells, dbPath, edgesPerCell = 4, seed = 20261030 } = opts
  const space = new SdrSpace({ dim: 2048, k: 8 })
  const rand = rng(seed)
  const now = Date.now()
  const DAY = 86_400_000

  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true })
    try {
      rmSync(dbPath)
      rmSync(`${dbPath}-wal`)
      rmSync(`${dbPath}-shm`)
    } catch {
      /* 首次生成时文件不存在 */
    }
  }

  // 用 core 的 store 而不是自己拼 SQL：语料要能被服务层正常读取，
  // 手写 INSERT 一旦与 DDL 漂移，bench 会测到一个不存在的库。
  const store = createStore({ kind: 'sqlite', path: dbPath, space })
  store.open()

  const ids = []
  const t0 = Date.now()
  store.write(() => {
    for (let i = 0; i < cells; i++) {
      const w1 = WORDS[Math.floor(rand() * WORDS.length)]
      const w2 = WORDS[Math.floor(rand() * WORDS.length)]
      const pred = PREDS[Math.floor(rand() * PREDS.length)]
      const slots = [
        { role: 1, type: 'LIT', value: '用户' },
        { role: 2, type: 'LIT', value: pred },
        { role: 3, type: 'LIT', value: w1 },
        { role: 4, type: 'LIT', value: w2 },
      ]
      const sdr = space.bundle(
        slots.map((s) => space.bind(space.identity('V:' + s.value.toLowerCase()), space.role(ROLE_NAMES[s.role - 1]))),
      )
      const cellId = deriveCellId(`corpus:${i}`, [i], sdr)
      ids.push(cellId)
      const tFrom = now - Math.floor(rand() * 400) * DAY
      const access = 1 + Math.floor(rand() * 6)
      store.putCell({
        cellId,
        kind: i % 11 === 0 ? KIND.semantic : KIND.episodic,
        tier: i % 17 === 0 ? 1 : 0,
        flags: 0,
        tFrom: BigInt(tFrom),
        tTo: BigInt(tFrom + 3_600_000),
        tIngest: BigInt(tFrom),
        tAccess: BigInt(tFrom + Math.floor(rand() * 30) * DAY),
        accessCount: access,
        stability: 2 + rand() * 20,
        importance: 0.2 + rand() * 0.7,
        valence: rand() * 0.6 - 0.3,
        arousal: rand() * 0.5,
        dominance: rand() * 0.4,
        salience: 0.3 + rand() * 0.5,
        provenance: 0,
        trust: 240,
        sdr,
        emb: hashEmbedding(`${w1} ${pred} ${w2}`, 128),
        slots,
        edges: [],
        residual: null,
        confidence: 0.6 + rand() * 0.3,
        support: 1 + Math.floor(rand() * 3),
        topic: `${w1}-${pred}`,
        digest: `${pred} ${w1} ${w2}`,
        tInvalid: 0n,
        scope: 'user:local',
        session: 'corpus',
        lens: 'fact',
      })
    }

    // 合成边：按"话题相近"连，而不是纯随机——纯随机会让图路退化成噪声，
    // 测出来的 graph 通道耗时没有参考价值。
    const rels = [REL.ASSOC, REL.SAME_AS, REL.PART_OF, REL.EVIDENCE]
    for (let i = 0; i < ids.length; i++) {
      for (let k = 0; k < edgesPerCell; k++) {
        // 邻域连接 + 少量长程（模拟"想到这件事还会想到很久以前那件事"）
        const near = rand() < 0.75
        const j = near
          ? (i + 1 + Math.floor(rand() * 40)) % ids.length
          : Math.floor(rand() * ids.length)
        if (j === i) continue
        store.putEdge({ src: ids[i], dst: ids[j], rel: rels[k % rels.length], weight: 32 + Math.floor(rand() * 64) })
      }
    }
  })
  const buildMs = Date.now() - t0
  const stats = store.stats()
  store.close()

  return {
    cells: stats.cells,
    edges: stats.edges,
    buildMs,
    bytes: stats.bytes,
    /** 口径声明：这个库不是真实对话长出来的 */
    caveat: 'synthetic: batch putCell + synthetic edges; no residuals, uniform access history — latency only, not Recall',
  }
}

// ── CLI ────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('gen-corpus.mjs')) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const n = Number(args[0] ?? 10000)
  const dbArg = process.argv.find((a) => a.startsWith('--db='))?.slice(5)
  const dbPath = dbArg ?? `artifacts/corpus-${n}.db`
  const r = await generateCorpus({ cells: n, dbPath })
  console.log(`语料 ${r.cells} cell / ${r.edges} 边 / 造库 ${r.buildMs} ms / ${Math.round(r.bytes / 1024 / 1024)} MB`)
  console.log(`库：${dbPath}`)
  console.log(`口径：${r.caveat}`)
}
