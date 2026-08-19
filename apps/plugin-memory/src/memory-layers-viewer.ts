import type { MemoryLayer, MemoryLayersReport } from "./memory-layers.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface MemoryLayersViewerArtifact {
  contract: {
    name: "memory.layers.viewer";
    version: "memory.layers.viewer.v1";
    consumes: "memory.memory_layers.v1";
  };
  report: MemoryLayersReport;
  html: string;
}

export function buildMemoryLayersViewerArtifact(
  report: MemoryLayersReport,
): MemoryLayersViewerArtifact {
  return {
    contract: {
      name: "memory.layers.viewer",
      version: "memory.layers.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderMemoryLayersViewer(report),
  };
}

function renderMemoryLayersViewer(report: MemoryLayersReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory layers viewer</title>
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
    .empty-status { color: var(--warn); }
    .degraded { color: var(--bad); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
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
    .counts {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .count {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 7px;
      color: var(--muted);
      font-size: 12px;
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
        <h1>Memory Layers</h1>
        <p class="meta">Read-only layered architecture report over RedDB session, durable, reasoning, docs/code, and vector evidence.</p>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code></p>
      </div>
      <div class="badge">${report.summary.red_db_backed_layers}/${report.summary.total_layers} RedDB-backed</div>
    </header>
    <div class="metrics">
      ${metric("Ready", report.summary.ready_layers)}
      ${metric("Available", report.summary.available_layers)}
      ${metric("Empty", report.summary.empty_layers)}
      ${metric("Degraded", report.summary.degraded_layers)}
      ${metric("Generated", report.generated_at)}
    </div>
    <div class="layout">
      <div class="stack">
        <section>
          <h2>Layers</h2>
          ${report.layers.length === 0 ? `<p class="empty">No layer evidence available.</p>` : `<ul>${report.layers.map(layerItem).join("")}</ul>`}
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Competitor Alignment</h2>
          ${report.reference_alignment.length === 0 ? `<p class="empty">No reference alignment.</p>` : `<ul>${report.reference_alignment.map(alignmentItem).join("")}</ul>`}
        </section>
        <section>
          <h2>Recommended Next Actions</h2>
          ${report.recommended_next_actions.length === 0 ? `<p class="empty">No recommended next actions.</p>` : `<ul>${report.recommended_next_actions.map((action) => `<li><div><p class="meta">${escapeHtml(action)}</p></div></li>`).join("")}</ul>`}
        </section>
      </div>
    </div>
    <script id="memory-layers-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function layerItem(layer: MemoryLayer): string {
  return `<li>
    <div>
      <h3>${escapeHtml(layer.title)}</h3>
      <p class="meta"><code>${escapeHtml(layer.id)}</code> - ${escapeHtml(layer.red_db_collections.join(", "))}</p>
      <p class="meta">${escapeHtml(layer.notes.join(" "))}</p>
      <div class="counts">${Object.entries(layer.counts).map(([key, value]) => `<span class="count">${escapeHtml(key)}=${escapeHtml(String(value))}</span>`).join("")}</div>
      <p class="meta">${escapeHtml(layer.evidence.join(", "))}</p>
    </div>
    <span class="pill ${statusClass(layer.status)}">${escapeHtml(layer.status)}</span>
  </li>`;
}

function alignmentItem(
  item: MemoryLayersReport["reference_alignment"][number],
): string {
  return `<li>
    <div>
      <h3>${escapeHtml(item.reference)}</h3>
      <p class="meta"><code>${escapeHtml(item.maps_to.join(", "))}</code></p>
      <p class="meta">${escapeHtml(item.advantage)}</p>
    </div>
  </li>`;
}


function statusClass(status: MemoryLayer["status"]): string {
  if (status === "degraded") return "degraded";
  if (status === "empty") return "empty-status";
  return "";
}
