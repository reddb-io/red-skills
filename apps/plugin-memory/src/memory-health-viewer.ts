import type { MemoryHealthReport } from "./memory-health.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface MemoryHealthViewerArtifact {
  contract: {
    name: "memory.health.viewer";
    version: "memory.health.viewer.v1";
    consumes: "memory.health.v1";
  };
  report: MemoryHealthReport;
  html: string;
}

export function buildMemoryHealthViewerArtifact(
  report: MemoryHealthReport,
): MemoryHealthViewerArtifact {
  return {
    contract: {
      name: "memory.health.viewer",
      version: "memory.health.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderMemoryHealthViewer(report),
  };
}

function renderMemoryHealthViewer(report: MemoryHealthReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory health viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --ink: #202421;
      --muted: #657067;
      --line: #d8ddd4;
      --panel: #ffffff;
      --accent: #0b6f5d;
      --warn: #8a5a12;
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
    .attention { color: var(--warn); }
    .degraded { color: var(--bad); }
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .75fr); gap: 14px; }
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
        <h1>Memory Health</h1>
        <p class="meta">Read-only operational health over graph stats, vector readiness, stale evidence, and Skill telemetry availability.</p>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code></p>
      </div>
      <div class="badge ${stateClass(report.state)}">${escapeHtml(report.state)}</div>
    </header>
    <div class="metrics">
      ${metric("Nodes", report.stats.nodes)}
      ${metric("Edges", report.stats.edges)}
      ${metric("Vector Ready", `${report.vector.ready}/${report.vector.total}`)}
      ${metric("Stale", `${report.stale.stale}/${report.stale.total}`)}
      ${metric("Telemetry", report.skill_telemetry.status)}
      ${metric("Actions", report.recommended_next_actions.length)}
    </div>
    <div class="layout">
      <div class="stack">
        <section>
          <h2>Signals</h2>
          <ul>
            ${signalItem("Graph stats", `${report.stats.nodes} node(s), ${report.stats.edges} edge(s)`, "ready")}
            ${signalItem("Vector projection", `${report.vector.overall}: ${report.vector.ready}/${report.vector.total} ready, ${report.vector.failed} failed`, report.vector.overall)}
            ${signalItem("Stale evidence", `${report.stale.stale}/${report.stale.total} stale node(s)`, report.stale.stale > 0 ? "attention" : "ready")}
            ${signalItem("Skill telemetry", `${report.skill_telemetry.status}, ${report.skill_telemetry.rollups} rollup(s)`, report.skill_telemetry.status === "available" ? "ready" : "degraded")}
            ${signalItem(
              "Engine events",
              `${report.engine_events.status}, ${report.engine_events.total} event(s) — recall hit rate ${(report.engine_events.recall_hit_rate * 100).toFixed(0)}%, ${report.engine_events.conflict_count} conflict(s), ${report.engine_events.promotion_count} promotion(s), ${report.engine_events.eviction_count} eviction(s)`,
              report.engine_events.status === "available" ? "ready" : "degraded",
            )}
          </ul>
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Recommended Next Actions</h2>
          ${report.recommended_next_actions.length === 0 ? `<p class="empty">No recommended next actions.</p>` : `<ul>${report.recommended_next_actions.map((action) => `<li><div><p class="meta">${escapeHtml(action)}</p></div></li>`).join("")}</ul>`}
        </section>
      </div>
    </div>
    <script id="memory-health-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function signalItem(title: string, detail: string, status: string): string {
  return `<li>
    <div>
      <h3>${escapeHtml(title)}</h3>
      <p class="meta">${escapeHtml(detail)}</p>
    </div>
    <span class="pill ${stateClass(status)}">${escapeHtml(status)}</span>
  </li>`;
}


function stateClass(status: string): string {
  if (status === "ready" || status === "available") return "";
  if (status === "attention" || status === "stale" || status === "unavailable") return "attention";
  return "degraded";
}
