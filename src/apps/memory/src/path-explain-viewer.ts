import type { PathExplainEdge, PathExplainReport } from "./path-explain.js";
import { escapeHtml, jsonForScript, metricWithStrongClass as metric } from "./viewer-utils.js";

export interface PathExplainViewerArtifact {
  contract: {
    name: "memory.path_explain.viewer";
    version: "memory.path_explain.viewer.v1";
    consumes: "memory.path_explain.v1";
  };
  report: PathExplainReport;
  html: string;
}

export function buildPathExplainViewerArtifact(
  report: PathExplainReport,
): PathExplainViewerArtifact {
  return {
    contract: {
      name: "memory.path_explain.viewer",
      version: "memory.path_explain.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderPathExplainViewer(report),
  };
}

function renderPathExplainViewer(report: PathExplainReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory path explanation viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #202421;
      --muted: #626d66;
      --line: #d5dad2;
      --panel: #ffffff;
      --accent: #0c6f68;
      --warn: #8c5d16;
      --bad: #a43a3a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 42px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 13px; margin-bottom: 4px; overflow-wrap: anywhere; }
    .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--panel);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 20px 0;
    }
    .metric, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 14px;
    }
    .metric strong { display: block; font-size: 22px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .7fr); gap: 14px; }
    .stack { display: grid; gap: 12px; }
    ol, ul { margin: 0; padding-left: 20px; }
    li { margin: 8px 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .path-step {
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .path-step:first-child { border-top: 0; padding-top: 0; }
    .ok { color: var(--accent); }
    .bad { color: var(--bad); }
    @media (max-width: 880px) {
      header, .metrics, .layout { grid-template-columns: 1fr; }
      .badge { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Path Explanation</h1>
        <p class="meta">From <code>${escapeHtml(report.request.from)}</code> to <code>${escapeHtml(report.request.to)}</code></p>
        <p class="meta">Generated from ${escapeHtml(report.schema_version)} graph evidence.</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Reachable", report.reachable ? "yes" : "no", report.reachable ? "ok" : "bad")}
      ${metric("Hop count", report.hop_count ?? "n/a")}
      ${metric("Path nodes", report.path.length)}
      ${metric("Path edges", report.edges.length)}
    </div>
    <div class="layout">
      <div class="stack">
        ${pathSection(report)}
      </div>
      <div class="stack">
        ${requestSection(report)}
        ${nextActionsSection(report)}
      </div>
    </div>
    <script id="path-explain-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>
`;
}


function pathSection(report: PathExplainReport): string {
  if (!report.reachable) {
    return `<section><h2>Path</h2><p class="empty">No directed path found within depth ${report.request.max_depth}.</p></section>`;
  }
  return `<section>
    <h2>Path</h2>
    <div class="stack">${report.edges.map(edgeStep).join("")}</div>
  </section>`;
}

function edgeStep(edge: PathExplainEdge): string {
  return `<div class="path-step">
    <h3>${escapeHtml(edge.from.title)} → ${escapeHtml(edge.to.title)}</h3>
    <p class="meta"><code>${escapeHtml(edge.from.label)}</code> --${escapeHtml(String(edge.label))}--> <code>${escapeHtml(edge.to.label)}</code></p>
  </div>`;
}

function requestSection(report: PathExplainReport): string {
  return `<section>
    <h2>Request</h2>
    <ul>
      <li><code>from=${escapeHtml(report.request.from)}</code></li>
      <li><code>to=${escapeHtml(report.request.to)}</code></li>
      <li><code>max_depth=${report.request.max_depth}</code></li>
    </ul>
  </section>`;
}

function nextActionsSection(report: PathExplainReport): string {
  return `<section>
    <h2>Next Actions</h2>
    ${
      report.recommended_next_actions.length === 0
        ? `<p class="empty">No recommendations.</p>`
        : `<ul>${report.recommended_next_actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`
    }
  </section>`;
}
