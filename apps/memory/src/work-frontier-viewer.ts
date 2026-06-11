import type { WorkFrontierItem, WorkFrontierReport } from "./work-frontier.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface WorkFrontierViewerArtifact {
  contract: {
    name: "memory.work_frontier.viewer";
    version: "memory.work_frontier.viewer.v1";
    consumes: "memory.work_frontier.v1";
  };
  report: WorkFrontierReport;
  html: string;
}

export function buildWorkFrontierViewerArtifact(
  report: WorkFrontierReport,
): WorkFrontierViewerArtifact {
  return {
    contract: {
      name: "memory.work_frontier.viewer",
      version: "memory.work_frontier.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderWorkFrontierViewer(report),
  };
}

function renderWorkFrontierViewer(report: WorkFrontierReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory work frontier</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f6f1;
      --ink: #202421;
      --muted: #667067;
      --line: #d7ddd3;
      --panel: #ffffff;
      --code: #f9faf5;
      --accent: #0b6f5d;
      --warn: #8a5a12;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.45; }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 42px; }
    header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; border-bottom: 1px solid var(--line); padding-bottom: 20px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; letter-spacing: 0; overflow-wrap: anywhere; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 14px; margin-bottom: 5px; overflow-wrap: anywhere; }
    .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge, .pill { border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; background: var(--panel); color: var(--accent); font-weight: 700; font-size: 12px; text-transform: uppercase; white-space: nowrap; }
    .warn { color: var(--warn); }
    .metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
    .metric, section { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 14px; }
    .metric strong { display: block; font-size: 22px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, .75fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; border-top: 1px solid var(--line); padding-top: 12px; }
    li:first-child { border-top: 0; padding-top: 0; }
    pre { margin: 0; max-height: 640px; overflow: auto; white-space: pre-wrap; background: var(--code); border: 1px solid var(--line); border-radius: 6px; padding: 12px; font-size: 12px; line-height: 1.5; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    @media (max-width: 900px) { header, .metrics, .layout, li { grid-template-columns: 1fr; } .badge, .pill { white-space: normal; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Work Frontier</h1>
        <p class="meta">${report.focus ? `Focus: ${escapeHtml(report.focus)}` : "Focus: all remembered work"}</p>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code> - ${escapeHtml(report.generated_at)}</p>
      </div>
      <div class="badge ${report.status === "ready" ? "" : "warn"}">${escapeHtml(report.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Candidates", report.summary.candidate_work)}
      ${metric("Ready", report.summary.ready)}
      ${metric("Blocked", report.summary.blocked)}
      ${metric("Completed", report.summary.completed)}
      ${metric("Considered", report.summary.considered_nodes)}
    </div>
    <div class="layout">
      <div class="stack">
        ${itemsSection("Ready Next", report.ready, "No ready work items matched.")}
        ${itemsSection("Blocked", report.blocked, "No blocked work items matched.")}
        ${itemsSection("Recently Completed", report.completed, "No completed work items matched.")}
      </div>
      <div class="stack">
        <section>
          <h2>Agent Markdown</h2>
          <pre>${escapeHtml(report.markdown)}</pre>
        </section>
        <section>
          <h2>Recommended Next Actions</h2>
          ${report.recommended_next_actions.length === 0 ? `<p class="empty">No recommended next actions.</p>` : `<ul>${report.recommended_next_actions.map((action) => `<li><div><p class="meta">${escapeHtml(action)}</p></div></li>`).join("")}</ul>`}
        </section>
      </div>
    </div>
    <script id="memory-work-frontier-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function itemsSection(title: string, items: WorkFrontierItem[], empty: string): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${items.length === 0 ? `<p class="empty">${escapeHtml(empty)}</p>` : `<ul>${items.map(itemHtml).join("")}</ul>`}
  </section>`;
}

function itemHtml(item: WorkFrontierItem): string {
  const blockers =
    item.blocked_by.length === 0
      ? ""
      : `<p class="meta">Blocked by ${escapeHtml(item.blocked_by.map((blocker) => blocker.citation).join(", "))}</p>`;
  return `<li><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p><p class="meta"><code>${escapeHtml(item.citation)}</code> - ${escapeHtml(item.status ?? "unknown")} - unlocks ${item.unlocks}</p>${blockers}</div><span class="pill">${item.priority.toFixed(2)}</span></li>`;
}
