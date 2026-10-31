/**
 * client 侧打包：把 tsc 产出的 ESM 模块折成宿主认识的单个 `client.js`（v0.5.3）
 *
 * ── 为什么必须自己打包 ────────────────────────────────────────────
 * DSH 的浏览器插件只有**一种**加载方式：`dsh-client-modules` 读取
 * `exports["./client"]` 指向的**单个文件**，原样伺服到
 * `/plugins/<id>/client.js`，浏览器里由内核 `import()` 它。该文件必须调用
 *
 *     window.__ModuleLoader__.load({ id, factory: (require) => { … return module.exports } })
 *
 * 也就是说：**它必须自带一个 `require` 形状的模块表**。
 *
 * v0.5.2 的 `packages/ui/lib/client.js` 根本不存在（tsc 只会产出
 * `lib/client/index.js`），而 `lib/client/index.js` 是普通 ESM，里面有
 * `import ... from './Panel.js'` 这种**相对路径**。宿主只伺服一个文件，
 * 相对导入会 404；即使不 404，没调用 `load()` 的模块也不会被登记。
 * 结果：面板在宿主里**一次都没出现过**，而单测、SSR 快照、`npm run panel`
 * 预览全都正常——因为它们直接 import 编译产物，走的是另一条路。
 *
 * ── 为什么不用 esbuild ───────────────────────────────────────────
 * v0.4 把它删掉是有理由的：esbuild 带平台限定的 optionalDependency，
 * lockfile 只锁当前平台，npm ≥11 在别的平台 `npm ci` 直接失败
 * （见 `scripts/ci-check-publish.mjs` 的第 ④ 条门禁）。
 * 为了一个 100 KB 的 bundle 把发布矩阵弄崩不值得。
 *
 * ── 这个转换器为什么够用 ─────────────────────────────────────────
 * 输入是 **tsc 的产物**，不是手写源码：import/export 语句形态高度规整
 * （全部单行、只有具名导入、没有 default/namespace/`export *`）。
 * 遇到不认识的形态**直接报错**，不猜——宁可构建失败，也不要产出一个
 * 在浏览器里静默半死的 bundle。
 *
 *   node scripts/client-build.mjs
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const PACKAGE_ID = '@rain13sad/dsh-mnemo-ui'

/** 收集 `lib/client` 下的所有 .js（跳过 .map）。 */
function collect(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collect(full, base))
    else if (entry.endsWith('.js')) out.push({ full, id: relative(base, full).split('\\').join('/') })
  }
  return out
}

/** `import { a as b, c } from 'x'` → 解构赋值。 */
function destructure(clause) {
  const parts = clause
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(s)
      return m ? `${m[1]}: ${m[2]}` : s
    })
  return `{ ${parts.join(', ')} }`
}

/** 把一个 tsc ESM 模块转换成 `function (exports, __imp) { … }` 的函数体。 */
function transform(id, source) {
  const exported = []
  const out = []
  let counter = 0

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim()

    // import { … } from '…'
    let m = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?$/.exec(trimmed)
    if (m) {
      out.push(`const ${destructure(m[1])} = __imp(${JSON.stringify(m[2])});`)
      continue
    }
    // import '…'
    m = /^import\s*['"]([^'"]+)['"];?$/.exec(trimmed)
    if (m) {
      out.push(`__imp(${JSON.stringify(m[1])});`)
      continue
    }

    // export { a, b } / export { a } from '…'
    m = /^export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?;?$/.exec(trimmed)
    if (m) {
      const names = m[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (m[2]) {
        const tmp = `__re${++counter}`
        out.push(`const ${tmp} = __imp(${JSON.stringify(m[2])});`)
        for (const n of names) {
          const as = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(n)
          const from = as ? as[1] : n
          const to = as ? as[2] : n
          out.push(`exports.${to} = ${tmp}.${from};`)
        }
      } else {
        for (const n of names) {
          const as = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(n)
          exported.push({ local: as ? as[1] : n, name: as ? as[2] : n })
        }
      }
      continue
    }

    // export default
    m = /^export\s+default\s+(.*)$/.exec(trimmed)
    if (m) {
      out.push(`exports.default = ${m[1]}`)
      continue
    }

    // export [async] function / class / const / let / var
    m = /^export\s+(async\s+function|function|class|const|let|var)\s+([A-Za-z0-9_$]+)/.exec(trimmed)
    if (m) {
      out.push(line.replace(/^(\s*)export\s+/, '$1'))
      exported.push({ local: m[2], name: m[2] })
      continue
    }

    if (/^\s*export\s/.test(line)) {
      throw new Error(`client-build: ${id}: 无法转换的 export 形态 —— ${trimmed}`)
    }
    if (/^\s*import\s/.test(line)) {
      throw new Error(`client-build: ${id}: 无法转换的 import 形态 —— ${trimmed}`)
    }
    out.push(line)
  }

  if (exported.length) {
    const pairs = exported.map((e) => (e.local === e.name ? e.local : `${e.name}: ${e.local}`))
    out.push(`Object.assign(exports, { ${pairs.join(', ')} });`)
  }
  return out.join('\n')
}

/**
 * 相对路径解析（只用 posix 语义，bundle 里的路径永远是 `/`）。
 * 同一段实现要进 bundle，所以写成源码字符串，两边不各写一份。
 */
const NORMALIZE_SRC = `function __norm(baseId, spec) {
			var dir = baseId.split('/'); dir.pop();
			var seg = spec.split('/');
			var out = dir;
			for (var i = 0; i < seg.length; i++) {
				var s = seg[i];
				if (s === '' || s === '.') continue;
				if (s === '..') { out.pop(); continue; }
				out.push(s);
			}
			return out.join('/');
		}`

/**
 * 生成 bundle 文本。
 * @param {string} clientDir `packages/ui/lib/client` 的绝对路径
 * @returns {{ code: string, modules: string[] }}
 */
export function buildClientBundle(clientDir) {
  if (!existsSync(clientDir)) throw new Error(`client-build: 找不到 ${clientDir}，先 npm run build`)
  const modules = collect(clientDir).sort((a, b) => a.id.localeCompare(b.id))
  const entry = modules.find((m) => m.id === 'index.js')
  if (!entry) throw new Error('client-build: lib/client/index.js 不存在，无法确定入口')

  const parts = []
  for (const mod of modules) {
    const body = transform(mod.id, readFileSync(mod.full, 'utf8'))
    parts.push(`__defs[${JSON.stringify(mod.id)}] = function (exports, __imp) {\n${body}\n};`)
  }

  const code = `/* ${PACKAGE_ID} — generated by scripts/client-build.mjs; do not edit. */
window.__ModuleLoader__.load({
	id: ${JSON.stringify(PACKAGE_ID)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var __defs = {};
		var __cache = {};
		${NORMALIZE_SRC}
		function __load(id) {
			var hit = __cache[id];
			if (hit !== void 0) return hit.exports;
			var m = { exports: {} };
			__cache[id] = m;
			var def = __defs[id];
			if (def === void 0) throw new Error('mnemo-ui: unknown client module ' + id);
			def(m.exports, function (spec) {
				if (spec.charAt(0) === '.') return __load(__norm(id, spec));
				return require(spec);
			});
			return m.exports;
		}
${parts.map((p) => p.replace(/^/gm, '\t\t')).join('\n')}
		Object.assign(module.exports, __load('index.js'));
		return module.exports;
	}
});
`
  return { code, modules: modules.map((m) => m.id) }
}

/** 把 bundle 写进 `lib/client.js`（与 `lib/client/` 目录并存，互不影响）。 */
export function writeClientBundle(pkgDir) {
  const { code, modules } = buildClientBundle(join(pkgDir, 'lib', 'client'))
  const out = join(pkgDir, 'lib', 'client.js')
  writeFileSync(out, code, 'utf8')
  return { out, modules, bytes: Buffer.byteLength(code) }
}
