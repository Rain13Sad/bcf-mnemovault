/**
 * 面板样式。以 <style> 注入一次（幂等），全部类名带 mnv- 前缀，避免污染宿主。
 *
 * ── 设计约定（v0.3.1 打磨） ─────────────────────────────────────
 * 1. **字号只有四档**：11（辅助）/ 12（正文）/ 13（强调）/ 18（指标数字）。
 *    之前混用 10.5 / 12.5 这类半档，视觉上"到处差一点"，读起来累。
 * 2. **间距用 4 的倍数**：4 / 8 / 12 / 16。卡片内边距统一 12。
 * 3. **颜色全部走变量**，且暗色模式不是"反色"而是重新定的一套值——
 *    亮色下的 #2f6feb 放到深色背景上会发灰，暗色要提亮到 #6f9bff。
 * 4. **不用重阴影**。侧栏面板嵌在宿主里，投影过重会像弹窗；
 *    用 1px 边框 + 极浅投影表达层次。
 * 5. 任何容器都必须能承受 300px 宽度（DSH 侧栏最窄档），所以
 *    `min-width: 0` 与 `flex-wrap` 是硬要求，不是可选优化。
 */

export const STYLE_ID = 'mnv-style'

export const CSS = `
.mnv-root {
  /* ── 亮色 ── */
  --mnv-bg: #ffffff;
  --mnv-bg-soft: #f7f8fa;
  --mnv-bg-sunken: #eef0f4;
  --mnv-fg: #171a1f;
  --mnv-fg-soft: #5a6472;
  --mnv-fg-faint: #8d97a6;
  --mnv-border: #e4e7ec;
  --mnv-border-strong: #d3d8e0;
  --mnv-accent: #2f6feb;
  --mnv-accent-soft: rgba(47, 111, 235, 0.10);
  --mnv-accent-fg: #ffffff;
  --mnv-pos: #d1495b;
  --mnv-neg: #1f8a52;
  --mnv-warn: #a86a12;
  --mnv-danger: #c0392b;
  --mnv-radius: 12px;
  --mnv-radius-sm: 8px;
  --mnv-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
  --mnv-ring: 0 0 0 3px rgba(47, 111, 235, 0.18);
  --mnv-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  color: var(--mnv-fg);
  background: var(--mnv-bg);
  font: 12px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 作为 flex 子项时 min-width 默认是 min-content，侧栏 300–420 px 会被内容顶宽 */
  min-width: 0;
}
@media (prefers-color-scheme: dark) {
  .mnv-root {
    --mnv-bg: #15181d;
    --mnv-bg-soft: #1b1f26;
    --mnv-bg-sunken: #22262e;
    --mnv-fg: #e8ebf0;
    --mnv-fg-soft: #a8b1bf;
    --mnv-fg-faint: #7a8393;
    --mnv-border: #2a2f38;
    --mnv-border-strong: #363c47;
    --mnv-accent: #6f9bff;
    --mnv-accent-soft: rgba(111, 155, 255, 0.14);
    --mnv-accent-fg: #0f1218;
    --mnv-pos: #ef6b7b;
    --mnv-neg: #4fbf85;
    --mnv-warn: #d9a441;
    --mnv-danger: #e06c5a;
    --mnv-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    --mnv-ring: 0 0 0 3px rgba(111, 155, 255, 0.22);
  }
}
[data-theme="dark"] .mnv-root {
  --mnv-bg: #15181d;
  --mnv-bg-soft: #1b1f26;
  --mnv-bg-sunken: #22262e;
  --mnv-fg: #e8ebf0;
  --mnv-fg-soft: #a8b1bf;
  --mnv-fg-faint: #7a8393;
  --mnv-border: #2a2f38;
  --mnv-border-strong: #363c47;
  --mnv-accent: #6f9bff;
  --mnv-accent-soft: rgba(111, 155, 255, 0.14);
  --mnv-accent-fg: #0f1218;
  --mnv-pos: #ef6b7b;
  --mnv-neg: #4fbf85;
  --mnv-warn: #d9a441;
  --mnv-danger: #e06c5a;
  --mnv-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  --mnv-ring: 0 0 0 3px rgba(111, 155, 255, 0.22);
}
[data-theme="light"] .mnv-root {
  --mnv-bg: #ffffff;
  --mnv-bg-soft: #f7f8fa;
  --mnv-bg-sunken: #eef0f4;
  --mnv-fg: #171a1f;
  --mnv-fg-soft: #5a6472;
  --mnv-fg-faint: #8d97a6;
  --mnv-border: #e4e7ec;
  --mnv-border-strong: #d3d8e0;
}

/* ── 顶栏 ─────────────────────────────────────────────────────── */
.mnv-header { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 12px 12px 10px; border-bottom: 1px solid var(--mnv-border); }
.mnv-header-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.mnv-title { font-weight: 600; font-size: 13px; letter-spacing: .1px; white-space: nowrap; flex: none; }
.mnv-spacer { flex: 1; }
.mnv-badge {
  font-size: 11px; line-height: 1.5; color: var(--mnv-fg-soft); background: var(--mnv-bg-sunken);
  border-radius: 999px; padding: 2px 8px; white-space: nowrap; flex: none; border: 1px solid transparent;
}

/* ── 页签 ─────────────────────────────────────────────────────── */
.mnv-tabs {
  min-width: 0; display: flex; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--mnv-border);
  overflow-x: auto; scrollbar-width: none;
}
.mnv-tabs::-webkit-scrollbar { display: none; }
.mnv-tab {
  border: 0; background: transparent; color: var(--mnv-fg-soft); font: inherit; font-size: 12px;
  padding: 5px 10px; border-radius: var(--mnv-radius-sm); cursor: pointer; white-space: nowrap; flex: none;
  transition: background .14s ease, color .14s ease;
}
.mnv-tab:hover { background: var(--mnv-bg-soft); color: var(--mnv-fg); }
.mnv-tab[data-active="true"] { background: var(--mnv-accent-soft); color: var(--mnv-accent); font-weight: 600; }
.mnv-flag { font-size: 11px; color: var(--mnv-warn); }

/* ── 内容区 ───────────────────────────────────────────────────── */
.mnv-body { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 12px; }
.mnv-body::-webkit-scrollbar { width: 8px; }
.mnv-body::-webkit-scrollbar-thumb { background: var(--mnv-border-strong); border-radius: 4px; }
.mnv-body::-webkit-scrollbar-track { background: transparent; }
.mnv-toolbar { display: flex; gap: 6px; padding: 8px 12px; align-items: center; border-bottom: 1px solid var(--mnv-border); }

/* ── 控件 ─────────────────────────────────────────────────────── */
.mnv-input {
  width: 100%; box-sizing: border-box; border: 1px solid var(--mnv-border);
  background: var(--mnv-bg-soft); color: var(--mnv-fg); border-radius: var(--mnv-radius-sm);
  padding: 6px 10px; font: inherit; transition: border-color .14s ease, box-shadow .14s ease;
}
.mnv-input::placeholder { color: var(--mnv-fg-faint); }
.mnv-input:focus { outline: none; border-color: var(--mnv-accent); box-shadow: var(--mnv-ring); background: var(--mnv-bg); }
.mnv-select {
  border: 1px solid var(--mnv-border); background: var(--mnv-bg-soft); color: var(--mnv-fg);
  border-radius: var(--mnv-radius-sm); padding: 5px 8px; font: inherit; font-size: 11px; max-width: 46%;
}
.mnv-select:focus { outline: none; border-color: var(--mnv-accent); box-shadow: var(--mnv-ring); }
.mnv-btn {
  border: 1px solid var(--mnv-border); background: var(--mnv-bg-soft); color: var(--mnv-fg);
  border-radius: var(--mnv-radius-sm); padding: 4px 10px; font: inherit; font-size: 11.5px;
  cursor: pointer; white-space: nowrap; transition: border-color .14s ease, background .14s ease, color .14s ease;
}
.mnv-btn:hover { border-color: var(--mnv-border-strong); background: var(--mnv-bg-sunken); }
.mnv-btn:focus-visible { outline: none; box-shadow: var(--mnv-ring); }
.mnv-btn[data-tone="primary"] { background: var(--mnv-accent); border-color: var(--mnv-accent); color: var(--mnv-accent-fg); }
.mnv-btn[data-tone="primary"]:hover { filter: brightness(1.05); }
.mnv-btn[data-tone="danger"] { color: var(--mnv-danger); border-color: color-mix(in srgb, var(--mnv-danger) 32%, var(--mnv-border)); }
.mnv-btn[data-tone="danger"]:hover { background: color-mix(in srgb, var(--mnv-danger) 10%, transparent); }
.mnv-btn[data-tone="ghost"] { border-color: transparent; background: transparent; color: var(--mnv-fg-soft); }
.mnv-btn[data-tone="ghost"]:hover { background: var(--mnv-bg-soft); color: var(--mnv-fg); }
.mnv-btn:disabled { opacity: .45; cursor: not-allowed; }

/* ── 行 / 卡片 ────────────────────────────────────────────────── */
.mnv-day { font-size: 11px; color: var(--mnv-fg-faint); margin: 14px 2px 6px; letter-spacing: .3px; }
.mnv-row {
  border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius); background: var(--mnv-bg);
  padding: 9px 11px; margin-bottom: 6px; box-shadow: var(--mnv-shadow);
  transition: border-color .14s ease, box-shadow .14s ease;
}
.mnv-row:hover { border-color: var(--mnv-border-strong); }
.mnv-row[data-selected="true"] { border-color: var(--mnv-accent); box-shadow: 0 0 0 3px var(--mnv-accent-soft); }
.mnv-row[data-dim="true"] { opacity: .62; }
.mnv-row-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.mnv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mnv-accent); flex: none; }
.mnv-kind {
  font-size: 10.5px; padding: 1px 6px; border-radius: 5px; background: var(--mnv-bg-sunken);
  color: var(--mnv-fg-soft); flex: none; letter-spacing: .2px;
}
.mnv-kv { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.mnv-num { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--mnv-fg-soft); white-space: nowrap; }
.mnv-sub { font-size: 11px; color: var(--mnv-fg-faint); margin-top: 4px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.mnv-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
.mnv-slider { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--mnv-fg-soft); }
.mnv-slider input[type="range"] { width: 92px; accent-color: var(--mnv-accent); }

/* ── 空态 / 加载态 ────────────────────────────────────────────── */
.mnv-empty { color: var(--mnv-fg-faint); text-align: center; padding: 36px 16px; font-size: 12px; line-height: 1.9; }
.mnv-loading { padding: 28px 12px 12px; text-align: center; color: var(--mnv-fg-faint); font-size: 12px; }
.mnv-skeleton { height: 10px; border-radius: 5px; background: var(--mnv-bg-sunken); margin: 8px 0; animation: mnv-pulse 1.4s ease-in-out infinite; }
@keyframes mnv-pulse { 0%, 100% { opacity: .5 } 50% { opacity: 1 } }

/* ── 网格与指标 ───────────────────────────────────────────────── */
.mnv-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.mnv-card {
  border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius); background: var(--mnv-bg);
  padding: 10px 12px; box-shadow: var(--mnv-shadow); min-width: 0;
}
.mnv-card h4 { margin: 0 0 6px; font-size: 11px; font-weight: 500; color: var(--mnv-fg-faint); letter-spacing: .2px; }
.mnv-metric { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; }
.mnv-metric small { font-size: 11px; font-weight: 400; color: var(--mnv-fg-faint); margin-left: 3px; }

.mnv-bar { height: 5px; border-radius: 3px; background: var(--mnv-bg-sunken); overflow: hidden; }
.mnv-bar > i { display: block; height: 100%; background: var(--mnv-accent); border-radius: 3px; transition: width .3s ease; }
.mnv-legend { display: flex; gap: 12px; font-size: 11px; color: var(--mnv-fg-faint); margin: 2px 2px 10px; flex-wrap: wrap; }
.mnv-chip {
  display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 8px;
  border-radius: 999px; background: var(--mnv-bg-sunken); color: var(--mnv-fg-soft); border: 1px solid transparent;
}
.mnv-swatch { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }

/* ── 解释器 ───────────────────────────────────────────────────── */
.mnv-explain {
  border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius-sm); background: var(--mnv-bg-soft);
  padding: 9px 11px; margin: 8px 0 4px; font-family: var(--mnv-mono); font-size: 11px;
  line-height: 1.7; white-space: pre-wrap; color: var(--mnv-fg-soft);
}
.mnv-explain b { color: var(--mnv-accent); font-weight: 600; }
.mnv-note { font-size: 11px; color: var(--mnv-fg-faint); line-height: 1.75; }
.mnv-error { color: var(--mnv-danger); font-size: 12px; padding: 10px 2px; }
.mnv-scroll-sentinel { height: 1px; }

/* ── 图谱 / 情感 ──────────────────────────────────────────────── */
.mnv-graph { width: 100%; height: 300px; display: block; }
.mnv-graph text { fill: var(--mnv-fg-soft); font-size: 10px; }
.mnv-affect-scatter { width: 100%; height: 200px; display: block; }
.mnv-pillrow { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }

/* ── 小节标题：左侧一根 3px 的强调条 ─────────────────────────── */
.mnv-subhead { display: flex; align-items: center; gap: 8px; margin: 16px 2px 8px; }
.mnv-subhead > b { font-size: 12px; font-weight: 600; color: var(--mnv-fg); letter-spacing: .2px; position: relative; padding-left: 9px; }
.mnv-subhead > b::before {
  content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  width: 3px; height: 11px; border-radius: 2px; background: var(--mnv-accent);
}
.mnv-subhead > span { font-size: 11px; color: var(--mnv-fg-faint); }
.mnv-subhead::after { content: ''; flex: 1; height: 1px; background: var(--mnv-border); }

.mnv-panel {
  min-width: 0; border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius);
  background: var(--mnv-bg); padding: 12px; margin-bottom: 10px; box-shadow: var(--mnv-shadow);
}
.mnv-panel[data-tone="sunken"] { background: var(--mnv-bg-soft); box-shadow: none; }

.mnv-code {
  display: block; width: 100%; box-sizing: border-box; font-family: var(--mnv-mono);
  font-size: 11px; color: var(--mnv-fg-soft); background: var(--mnv-bg-sunken);
  border-radius: var(--mnv-radius-sm); padding: 6px 9px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}

/* 指标格：4–8 列自适应，数字大、标签小 */
.mnv-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr)); gap: 2px 6px; }
.mnv-stat { padding: 7px 2px; text-align: center; border-radius: var(--mnv-radius-sm); transition: background .14s ease; }
.mnv-stat:hover { background: var(--mnv-bg-soft); }
.mnv-stat > b { display: block; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.3; }
.mnv-stat > span { display: block; font-size: 11px; color: var(--mnv-fg-faint); margin-top: 2px; }
.mnv-stat[data-tone="warn"] > b { color: var(--mnv-warn); }
.mnv-stat[data-tone="danger"] > b { color: var(--mnv-danger); }
.mnv-stat[data-tone="accent"] > b { color: var(--mnv-accent); }

/* 四列最近列表 */
.mnv-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 12px; }
.mnv-col { min-width: 0; }
.mnv-col > h5 { margin: 0 0 6px; font-size: 11px; font-weight: 600; color: var(--mnv-fg-soft); letter-spacing: .2px; }
.mnv-mini {
  border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius-sm); background: var(--mnv-bg-soft);
  padding: 7px 9px; margin-bottom: 6px; cursor: pointer; transition: border-color .14s ease, background .14s ease;
}
.mnv-mini:hover { border-color: var(--mnv-accent); background: var(--mnv-bg); }
.mnv-mini > div:first-child { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mnv-mini > div:last-child { font-size: 10.5px; color: var(--mnv-fg-faint); margin-top: 3px; display: flex; gap: 8px; }

.mnv-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.mnv-tag {
  font-size: 11px; padding: 2px 9px; border-radius: 999px; cursor: default;
  background: var(--mnv-bg-sunken); color: var(--mnv-fg-soft); border: 1px solid transparent;
  transition: border-color .14s ease;
}
.mnv-tag:hover { border-color: var(--mnv-border-strong); }
.mnv-tag > i { font-style: normal; color: var(--mnv-fg-faint); margin-left: 5px; font-size: 10px; }

.mnv-kvrow { display: grid; grid-template-columns: 92px 1fr; gap: 8px; font-size: 11.5px; padding: 4px 0; align-items: baseline; }
.mnv-kvrow > span:first-child { color: var(--mnv-fg-faint); }
.mnv-kvrow > span:last-child { color: var(--mnv-fg-soft); word-break: break-word; min-width: 0; }
.mnv-kvrow code { font-family: var(--mnv-mono); font-size: 11px; }

.mnv-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; }
.mnv-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--mnv-fg-faint); }
.mnv-status[data-ok="true"] { color: var(--mnv-neg); }
.mnv-status[data-ok="true"]::before { background: var(--mnv-neg); }
.mnv-status[data-ok="false"] { color: var(--mnv-warn); }
.mnv-status[data-ok="false"]::before { background: var(--mnv-warn); }

/* 设置项 */
.mnv-setting { display: flex; align-items: center; gap: 10px; padding: 8px 2px; border-bottom: 1px dashed var(--mnv-border); }
.mnv-setting:last-child { border-bottom: 0; }
.mnv-setting > div:first-child { flex: 1; min-width: 0; }
.mnv-setting b { display: block; font-size: 12px; font-weight: 500; }
.mnv-setting small { display: block; font-size: 10.5px; color: var(--mnv-fg-faint); margin-top: 2px; line-height: 1.5; }
.mnv-seg { display: inline-flex; border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius-sm); overflow: hidden; flex: none; }
.mnv-seg > button { border: 0; background: transparent; color: var(--mnv-fg-soft); font: inherit; font-size: 11px; padding: 4px 10px; cursor: pointer; transition: background .14s ease, color .14s ease; }
.mnv-seg > button:hover { background: var(--mnv-bg-soft); }
.mnv-seg > button[data-active="true"] { background: var(--mnv-accent); color: var(--mnv-accent-fg); font-weight: 500; }

.mnv-danger { border-color: color-mix(in srgb, var(--mnv-danger) 35%, var(--mnv-border)); }
.mnv-danger > b { color: var(--mnv-danger); }

.mnv-hit { display: flex; align-items: center; gap: 8px; }
.mnv-score { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--mnv-accent); min-width: 32px; text-align: right; }
.mnv-muted { color: var(--mnv-fg-faint); font-size: 11px; }

/* 窄侧栏（≤340px）：进一步压缩留白，保证一屏能看全 */
@media (max-width: 340px) {
  .mnv-body { padding: 10px 8px; }
  .mnv-panel { padding: 10px; }
  .mnv-stats { grid-template-columns: repeat(auto-fit, minmax(64px, 1fr)); }
  .mnv-kvrow { grid-template-columns: 80px 1fr; }
  .mnv-cols { grid-template-columns: 1fr; }
}
`
