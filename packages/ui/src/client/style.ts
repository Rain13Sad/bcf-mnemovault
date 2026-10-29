/**
 * 面板样式。以 <style> 注入一次（幂等），全部类名带 mnv- 前缀，避免污染宿主。
 *
 * 主题：优先跟随宿主 `data-theme`，没有则跟随系统 prefers-color-scheme。
 * 颜色用 CSS 变量集中定义，视图里不写死颜色——暗色模式下文字必须可读，
 * 这是硬要求，不是审美偏好。
 */

export const STYLE_ID = 'mnv-style'

export const CSS = `
.mnv-root {
  --mnv-bg: #ffffff;
  --mnv-bg-soft: #f6f7f9;
  --mnv-bg-sunken: #eef0f4;
  --mnv-fg: #1b1f24;
  --mnv-fg-soft: #5b6472;
  --mnv-fg-faint: #8b95a5;
  --mnv-border: #e3e6ec;
  --mnv-accent: #2f6feb;
  --mnv-pos: #d1495b;
  --mnv-neg: #2f8f5b;
  --mnv-warn: #b7791f;
  --mnv-danger: #c0392b;
  --mnv-radius: 10px;
  color: var(--mnv-fg);
  background: var(--mnv-bg);
  font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  /* 关键：作为 flex 子项时 min-width 默认是 min-content，侧栏 320–420 px 会被内容顶宽，
     表现为"面板比宿主给的宽度宽、右边被裁掉"。三个容器都要显式放开。 */
  min-width: 0;
}
@media (prefers-color-scheme: dark) {
  .mnv-root {
    --mnv-bg: #14171c;
    --mnv-bg-soft: #1b1f26;
    --mnv-bg-sunken: #232830;
    --mnv-fg: #e6e9ef;
    --mnv-fg-soft: #a9b2c0;
    --mnv-fg-faint: #7b8494;
    --mnv-border: #2b313a;
    --mnv-accent: #6f9bff;
    --mnv-pos: #ef6b7b;
    --mnv-neg: #4fbf85;
    --mnv-warn: #d9a441;
    --mnv-danger: #e06c5a;
  }
}
[data-theme="dark"] .mnv-root {
  --mnv-bg: #14171c;
  --mnv-bg-soft: #1b1f26;
  --mnv-bg-sunken: #232830;
  --mnv-fg: #e6e9ef;
  --mnv-fg-soft: #a9b2c0;
  --mnv-fg-faint: #7b8494;
  --mnv-border: #2b313a;
  --mnv-accent: #6f9bff;
  --mnv-pos: #ef6b7b;
  --mnv-neg: #4fbf85;
  --mnv-warn: #d9a441;
  --mnv-danger: #e06c5a;
}
[data-theme="light"] .mnv-root {
  --mnv-bg: #ffffff;
  --mnv-bg-soft: #f6f7f9;
  --mnv-bg-sunken: #eef0f4;
  --mnv-fg: #1b1f24;
  --mnv-fg-soft: #5b6472;
  --mnv-fg-faint: #8b95a5;
  --mnv-border: #e3e6ec;
}

.mnv-header { min-width: 0; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px 8px; border-bottom: 1px solid var(--mnv-border); }
.mnv-header-row { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; }
.mnv-title { font-weight: 600; font-size: 13px; letter-spacing: .2px; white-space: nowrap; flex: none; }
.mnv-spacer { flex: 1; }
.mnv-badge { font-size: 11px; color: var(--mnv-fg-soft); background: var(--mnv-bg-sunken); border-radius: 999px; padding: 2px 8px; white-space: nowrap; flex: none; }
.mnv-tabs { min-width: 0; display: flex; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--mnv-border); }
.mnv-tab { border: 0; background: transparent; color: var(--mnv-fg-soft); font: inherit; font-size: 12px; padding: 5px 9px; border-radius: 7px; cursor: pointer; white-space: nowrap; flex: none; }
.mnv-tab:hover { background: var(--mnv-bg-soft); color: var(--mnv-fg); }
.mnv-tab[data-active="true"] { background: var(--mnv-bg-sunken); color: var(--mnv-fg); font-weight: 600; }
.mnv-body { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 8px 10px 16px; }
.mnv-toolbar { display: flex; gap: 6px; padding: 8px 10px; align-items: center; border-bottom: 1px solid var(--mnv-border); }
.mnv-input { flex: 1; min-width: 0; border: 1px solid var(--mnv-border); background: var(--mnv-bg-soft); color: var(--mnv-fg); border-radius: 8px; padding: 5px 9px; font: inherit; }
.mnv-input:focus { outline: 2px solid color-mix(in srgb, var(--mnv-accent) 40%, transparent); outline-offset: 1px; }
.mnv-select { border: 1px solid var(--mnv-border); background: var(--mnv-bg-soft); color: var(--mnv-fg); border-radius: 8px; padding: 5px 6px; font: inherit; }
.mnv-btn { border: 1px solid var(--mnv-border); background: var(--mnv-bg-soft); color: var(--mnv-fg); border-radius: 8px; padding: 4px 9px; font: inherit; cursor: pointer; }
.mnv-btn:hover { border-color: var(--mnv-accent); }
.mnv-btn[data-tone="danger"] { color: var(--mnv-danger); }
.mnv-btn[data-tone="ghost"] { border-color: transparent; background: transparent; color: var(--mnv-fg-soft); }
.mnv-btn:disabled { opacity: .45; cursor: not-allowed; }

.mnv-day { font-size: 11px; color: var(--mnv-fg-faint); margin: 12px 2px 4px; letter-spacing: .4px; }
.mnv-row { border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius); background: var(--mnv-bg-soft); padding: 8px 10px; margin-bottom: 6px; }
.mnv-row[data-selected="true"] { border-color: var(--mnv-accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--mnv-accent) 18%, transparent); }
.mnv-row[data-dim="true"] { opacity: .55; }
.mnv-row-head { display: flex; align-items: center; gap: 6px; }
.mnv-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mnv-accent); flex: none; }
.mnv-kind { font-size: 11px; padding: 1px 6px; border-radius: 5px; background: var(--mnv-bg-sunken); color: var(--mnv-fg-soft); }
.mnv-kv { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mnv-num { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--mnv-fg-soft); }
.mnv-flag { font-size: 11px; color: var(--mnv-warn); }
.mnv-sub { font-size: 11px; color: var(--mnv-fg-faint); margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap; }
.mnv-actions { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
.mnv-slider { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--mnv-fg-soft); }
.mnv-slider input[type="range"] { width: 92px; accent-color: var(--mnv-accent); }

.mnv-empty { color: var(--mnv-fg-faint); text-align: center; padding: 28px 12px; font-size: 12px; line-height: 1.8; }
.mnv-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.mnv-card { border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius); background: var(--mnv-bg-soft); padding: 8px 10px; }
.mnv-card h4 { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: var(--mnv-fg-faint); letter-spacing: .3px; }
.mnv-metric { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.mnv-metric small { font-size: 11px; font-weight: 400; color: var(--mnv-fg-faint); margin-left: 3px; }

.mnv-bar { height: 5px; border-radius: 3px; background: var(--mnv-bg-sunken); overflow: hidden; }
.mnv-bar > i { display: block; height: 100%; background: var(--mnv-accent); }
.mnv-legend { display: flex; gap: 10px; font-size: 11px; color: var(--mnv-fg-faint); margin: 4px 2px 10px; flex-wrap: wrap; }
.mnv-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--mnv-bg-sunken); color: var(--mnv-fg-soft); }
.mnv-swatch { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }

.mnv-explain { border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius); background: var(--mnv-bg-sunken); padding: 8px 10px; margin: 6px 0 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.65; white-space: pre-wrap; }
.mnv-explain b { color: var(--mnv-accent); font-weight: 600; }
.mnv-note { font-size: 11px; color: var(--mnv-fg-faint); line-height: 1.7; }
.mnv-error { color: var(--mnv-danger); font-size: 12px; padding: 8px 2px; }
.mnv-scroll-sentinel { height: 1px; }
.mnv-graph { width: 100%; height: 320px; display: block; }
.mnv-graph text { fill: var(--mnv-fg-soft); font-size: 10px; }
.mnv-affect-scatter { width: 100%; height: 200px; display: block; }
.mnv-pillrow { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }

/* ── v0.3：对齐 DSH 记忆插件的版式 ───────────────────────────────── */

.mnv-subhead { display: flex; align-items: center; gap: 8px; margin: 14px 2px 8px; }
.mnv-subhead > b { font-size: 12px; font-weight: 600; color: var(--mnv-fg); letter-spacing: .2px; }
.mnv-subhead > span { font-size: 11px; color: var(--mnv-fg-faint); }
.mnv-subhead::after { content: ''; flex: 1; height: 1px; background: var(--mnv-border); }

.mnv-panel { min-width: 0; border: 1px solid var(--mnv-border); border-radius: var(--mnv-radius); background: var(--mnv-bg); padding: 10px 12px; margin-bottom: 10px; }
.mnv-panel[data-tone="sunken"] { background: var(--mnv-bg-soft); }

.mnv-code {
  display: block; width: 100%; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; color: var(--mnv-fg-soft); background: var(--mnv-bg-sunken);
  border-radius: 6px; padding: 5px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* 指标格：参考界面是 4–8 列等宽，数字大、标签小 */
.mnv-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(76px, 1fr)); gap: 2px 8px; }
.mnv-stat { padding: 6px 2px; text-align: center; border-radius: 8px; }
.mnv-stat:hover { background: var(--mnv-bg-soft); }
.mnv-stat > b { display: block; font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.25; }
.mnv-stat > span { display: block; font-size: 11px; color: var(--mnv-fg-faint); margin-top: 2px; }
.mnv-stat[data-tone="warn"] > b { color: var(--mnv-warn); }
.mnv-stat[data-tone="danger"] > b { color: var(--mnv-danger); }
.mnv-stat[data-tone="accent"] > b { color: var(--mnv-accent); }

/* 四列最近列表 */
.mnv-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.mnv-col { min-width: 0; }
.mnv-col > h5 { margin: 0 0 6px; font-size: 11px; font-weight: 600; color: var(--mnv-fg-soft); letter-spacing: .3px; }
.mnv-mini {
  border: 1px solid var(--mnv-border); border-radius: 8px; background: var(--mnv-bg-soft);
  padding: 6px 8px; margin-bottom: 5px; cursor: pointer;
}
.mnv-mini:hover { border-color: var(--mnv-accent); }
.mnv-mini > div:first-child { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mnv-mini > div:last-child { font-size: 10px; color: var(--mnv-fg-faint); margin-top: 2px; display: flex; gap: 6px; }

.mnv-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.mnv-tag {
  font-size: 11px; padding: 2px 8px; border-radius: 999px; cursor: default;
  background: var(--mnv-bg-sunken); color: var(--mnv-fg-soft); border: 1px solid transparent;
}
.mnv-tag > i { font-style: normal; color: var(--mnv-fg-faint); margin-left: 4px; font-size: 10px; }

.mnv-kvrow { display: grid; grid-template-columns: 96px 1fr; gap: 8px; font-size: 11px; padding: 3px 0; align-items: baseline; }
.mnv-kvrow > span:first-child { color: var(--mnv-fg-faint); }
.mnv-kvrow > span:last-child { color: var(--mnv-fg-soft); word-break: break-all; }
.mnv-kvrow code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; }

.mnv-status { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }
.mnv-status::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--mnv-fg-faint); }
.mnv-status[data-ok="true"] { color: var(--mnv-neg); }
.mnv-status[data-ok="true"]::before { background: var(--mnv-neg); }
.mnv-status[data-ok="false"] { color: var(--mnv-warn); }
.mnv-status[data-ok="false"]::before { background: var(--mnv-warn); }

.mnv-tabs { overflow-x: auto; scrollbar-width: none; }
.mnv-tabs::-webkit-scrollbar { display: none; }

/* 设置项 */
.mnv-setting { display: flex; align-items: center; gap: 10px; padding: 7px 2px; border-bottom: 1px dashed var(--mnv-border); }
.mnv-setting:last-child { border-bottom: 0; }
.mnv-setting > div:first-child { flex: 1; min-width: 0; }
.mnv-setting b { display: block; font-size: 12px; font-weight: 500; }
.mnv-setting small { display: block; font-size: 10.5px; color: var(--mnv-fg-faint); margin-top: 1px; }
.mnv-seg { display: inline-flex; border: 1px solid var(--mnv-border); border-radius: 8px; overflow: hidden; }
.mnv-seg > button { border: 0; background: transparent; color: var(--mnv-fg-soft); font: inherit; font-size: 11px; padding: 4px 9px; cursor: pointer; }
.mnv-seg > button[data-active="true"] { background: var(--mnv-accent); color: #fff; }

.mnv-danger { border-color: color-mix(in srgb, var(--mnv-danger) 40%, var(--mnv-border)); }
.mnv-danger > b { color: var(--mnv-danger); }

.mnv-hit { display: flex; align-items: center; gap: 8px; }
.mnv-score { font-variant-numeric: tabular-nums; font-size: 11px; color: var(--mnv-accent); min-width: 34px; text-align: right; }
.mnv-muted { color: var(--mnv-fg-faint); font-size: 11px; }
.mnv-loading { padding: 28px 12px; text-align: center; color: var(--mnv-fg-faint); font-size: 12px; }
.mnv-skeleton { height: 10px; border-radius: 5px; background: var(--mnv-bg-sunken); margin: 6px 0; animation: mnv-pulse 1.4s ease-in-out infinite; }
@keyframes mnv-pulse { 0%,100% { opacity: .55 } 50% { opacity: 1 } }
`
