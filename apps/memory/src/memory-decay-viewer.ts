import type { MemoryDecayItem, MemoryDecayReport } from "./memory-decay.js";
import { escapeHtmlNoSingleQuote as escapeHtml, jsonForScriptEscapedLessThan as jsonForScript, metricWithMetaSpan as metric } from "./viewer-utils.js";

export interface MemoryDecayViewerArtifact {
  name: "memory.decay.viewer";
  contract: {
    version: "memory.decay.viewer.v1";
    consumes: "memory.decay_plan.v1";
  };
  report: MemoryDecayReport;
  html: string;
}

export function buildMemoryDecayViewerArtifact(
  report: MemoryDecayReport,
): MemoryDecayViewerArtifact {
  return {
    name: "memory.decay.viewer",
    contract: {
      version: "memory.decay.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: render(report),
  };
}

function render(report: MemoryDecayReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory Decay Plan</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f7f8; color: #1d232a; }
    body { margin: 0; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 1px solid #d8dee4; padding-bottom: 18px; }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; margin-top: 28px; }
    h3 { font-size: 15px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space: pre-wrap; background: #fff; border: 1px solid #d8dee4; padding: 16px; overflow: auto; }
    .meta { color: #667085; font-size: 13px; }
    .pill { border: 1px solid #b8c0cc; border-radius: 999px; padding: 4px 9px; font-size: 12px; background: #fff; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; margin: 20px 0; }
    .metric, li { background: #fff; border: 1px solid #d8dee4; border-radius: 8px; padding: 12px; }
    .metric strong { display: block; font-size: 24px; }
    ul { display: grid; gap: 10px; list-style: none; padding: 0; margin: 12px 0 0; }
    li { display: flex; justify-content: space-between; gap: 16px; }
    .action-expire { border-left: 4px solid #b42318; }
    .action-deprecate { border-left: 4px solid #b54708; }
    .action-review { border-left: 4px solid #026aa2; }
    .action-keep { border-left: 4px solid #027a48; }
    @media (prefers-color-scheme: dark) {
      :root { background: #111418; color: #e6edf3; }
      header { border-color: #30363d; }
      .metric, li, pre, .pill { background: #161b22; border-color: #30363d; }
      .meta { color: #9ba7b4; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Decay Plan</h1>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code> - ${escapeHtml(report.generated_at)}</p>
      </div>
      <span class="pill">${escapeHtml(report.status)}</span>
    </header>
    <section class="metrics">
      ${metric("Keep", report.summary.keep)}
      ${metric("Review", report.summary.review)}
      ${metric("Deprecate", report.summary.deprecate)}
      ${metric("Expire", report.summary.expire)}
      ${metric("Protected", report.summary.protected)}
      ${metric("Superseded", report.summary.superseded)}
    </section>
    ${section("Expire", report.expire)}
    ${section("Deprecate", report.deprecate)}
    ${section("Review", report.review)}
    ${section("Keep", report.keep.slice(0, 10))}
    <h2>Markdown</h2>
    <pre>${escapeHtml(report.markdown)}</pre>
    <script id="memory-decay-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}


function section(title: string, items: MemoryDecayItem[]): string {
  const body =
    items.length === 0
      ? `<p class="meta">No ${escapeHtml(title.toLowerCase())} candidates.</p>`
      : `<ul>${items.map(item).join("")}</ul>`;
  return `<section><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

function item(entry: MemoryDecayItem): string {
  return `<li class="action-${entry.action}">
  <div>
    <h3>${escapeHtml(entry.title)}</h3>
    <p class="meta"><code>${escapeHtml(entry.citation)}</code> - ${escapeHtml(entry.tier)} - ${entry.age_days}d old - access ${entry.access_count}</p>
    <p>${escapeHtml(entry.recommendation)}</p>
    <p class="meta">${escapeHtml(entry.reasons.join("; "))}</p>
  </div>
  <span class="pill">${entry.score.toFixed(2)}</span>
</li>`;
}
