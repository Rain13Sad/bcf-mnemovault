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

.mnv-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--mnv-border); }
.mnv-title { font-weight: 600; font-size: 13px; letter-spacing: .2px; }
.mnv-spacer { flex: 1; }
.mnv-badge { font-size: 11px; color: var(--mnv-fg-soft); background: var(--mnv-bg-sunken); border-radius: 999px; padding: 2px 8px; }
.mnv-tabs { display: flex; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--mnv-border); }
.mnv-tab { border: 0; background: transparent; color: var(--mnv-fg-soft); font: inherit; padding: 5px 10px; border-radius: 7px; cursor: pointer; }
.mnv-tab:hover { background: var(--mnv-bg-soft); color: var(--mnv-fg); }
.mnv-tab[data-active="true"] { background: var(--mnv-bg-sunken); color: var(--mnv-fg); font-weight: 600; }
.mnv-body { flex: 1; min-height: 0; overflow: auto; padding: 8px 10px 16px; }
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
`
