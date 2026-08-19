import type { MemoryHandoffReport } from "./handoff.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface MemoryHandoffViewerArtifact {
  contract: {
    name: "memory.handoff.viewer";
    version: "memory.handoff.viewer.v1";
    consumes: "memory.handoff.v1";
  };
  report: MemoryHandoffReport;
  html: string;
}

export function buildMemoryHandoffViewerArtifact(
  report: MemoryHandoffReport,
): MemoryHandoffViewerArtifact {
  return {
    contract: {
      name: "memory.handoff.viewer",
      version: "memory.handoff.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderMemoryHandoffViewer(report),
  };
}

function renderMemoryHandoffViewer(report: MemoryHandoffReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory handoff viewer</title>
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
    h1 { font-size: 28px; letter-spacing: 0; overflow-wrap: anywhere; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 14px; margin-bottom: 5px; overflow-wrap: anywhere; }
    .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge, .pill {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--panel);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .empty-state { color: var(--warn); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, .75fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    li:first-child { border-top: 0; padding-top: 0; }
    pre {
      margin: 0;
      max-height: 640px;
      overflow: auto;
      white-space: pre-wrap;
      background: var(--code);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 900px) {
      header, .metrics, .layout, li { grid-template-columns: 1fr; }
      .badge, .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Handoff</h1>
        <p class="meta">${report.focus ? `Focus: ${escapeHtml(report.focus)}` : "Focus: latest project memory"}</p>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code> - ${escapeHtml(report.generated_at)}</p>
      </div>
      <div class="badge ${report.status === "empty" ? "empty-state" : ""}">${escapeHtml(report.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Returned", report.summary.returned_items)}
      ${metric("Active Work", report.summary.active_work)}
      ${metric("Decisions", report.summary.decisions)}
      ${metric("Validations", report.summary.validations)}
      ${metric("Risks", report.summary.risks)}
      ${metric("Context", report.summary.context)}
    </div>
    <div class="layout">
      <div class="stack">
        ${report.sections.length === 0 ? `<section><p class="empty">No Memory evidence matched this handoff request.</p></section>` : report.sections.map(sectionHtml).join("")}
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
    <script id="memory-handoff-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function sectionHtml(section: MemoryHandoffReport["sections"][number]): string {
  return `<section>
    <h2>${escapeHtml(section.title)}</h2>
    <ul>${section.items.map((item) => `<li><div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.summary)}</p><p class="meta"><code>${escapeHtml(item.citation)}</code>${item.age_days == null ? "" : ` - ${item.age_days}d old`}${item.source ? ` - ${escapeHtml(item.source)}` : ""}</p></div><span class="pill">${escapeHtml(item.node_type)}</span></li>`).join("")}</ul>
  </section>`;
}
