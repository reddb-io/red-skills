import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";
import type {
  VectorDocStatus,
  VectorNodeStatus,
  VectorStatusReport,
} from "./graph-store.js";

export interface VectorStatusViewerArtifact {
  contract: {
    name: "memory.vector_status.viewer";
    version: "memory.vector_status.viewer.v1";
    consumes: "memory.vector_status.v1";
  };
  report: VectorStatusReport;
  html: string;
}

export function buildVectorStatusViewerArtifact(
  report: VectorStatusReport,
): VectorStatusViewerArtifact {
  return {
    contract: {
      name: "memory.vector_status.viewer",
      version: "memory.vector_status.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderVectorStatusViewer(report),
  };
}

function renderVectorStatusViewer(report: VectorStatusReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory vector status viewer</title>
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
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
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
        <h1>Vector Status</h1>
        <p class="meta">Read-only projection readiness for RedDB-backed hybrid recall, docs, and assets.</p>
      </div>
      <div class="badge ${statusClass(report.overall)}">${escapeHtml(report.overall)}</div>
    </header>
    <div class="metrics">
      ${metric("Total", report.total)}
      ${metric("Ready", report.ready)}
      ${metric("Stale", report.stale)}
      ${metric("Unavailable", report.unavailable)}
      ${metric("Failed", report.failed)}
    </div>
    <div class="layout">
      <section>
        <h2>Memory Nodes</h2>
        ${report.nodes.length === 0 ? `<p class="empty">No Memory node vector targets.</p>` : `<ul>${report.nodes.map(nodeItem).join("")}</ul>`}
      </section>
      <section>
        <h2>Documentation Chunks</h2>
        ${report.docs.length === 0 ? `<p class="empty">No document vector targets.</p>` : `<ul>${report.docs.map(docItem).join("")}</ul>`}
      </section>
    </div>
    <script id="vector-status-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function nodeItem(node: VectorNodeStatus): string {
  return `<li>
    <div>
      <h3>${escapeHtml(node.label)}</h3>
      <p class="meta"><code>memory_nodes:${node.rid}</code> - ${escapeHtml(node.node_type)}</p>
      ${detail(node)}
    </div>
    <span class="pill ${statusClass(node.status)}">${escapeHtml(node.status)}</span>
  </li>`;
}

function docItem(doc: VectorDocStatus): string {
  return `<li>
    <div>
      <h3>${escapeHtml(doc.title ?? doc.path)}</h3>
      <p class="meta"><code>memory_docs:${doc.rid}</code> - ${escapeHtml(doc.path)}</p>
      ${detail(doc)}
    </div>
    <span class="pill ${statusClass(doc.status)}">${escapeHtml(doc.status)}</span>
  </li>`;
}

function detail(item: VectorNodeStatus | VectorDocStatus): string {
  const parts = [
    `hash ${item.text_hash.slice(0, 12)}`,
    item.projected_text_hash ? `projected ${item.projected_text_hash.slice(0, 12)}` : "",
    item.updated_at ? `updated ${new Date(item.updated_at).toISOString()}` : "",
    item.error ? `error ${item.error}` : "",
  ].filter(Boolean);
  return parts.length === 0 ? "" : `<p class="meta">${escapeHtml(parts.join(" - "))}</p>`;
}


function statusClass(status: string): string {
  if (status === "ready") return "";
  if (status === "stale" || status === "unavailable") return "warn";
  return "bad";
}
