import type { DocCoverageItem, DocCoverageReport } from "./doc-coverage.js";
import { escapeHtml, jsonForScript, metricWithMeta as metric, warningsSection } from "./viewer-utils.js";

export interface DocCoverageViewerArtifact {
  contract: {
    name: "memory.doc_coverage.viewer";
    version: "memory.doc_coverage.viewer.v1";
    consumes: "memory.doc_coverage.v1";
  };
  report: DocCoverageReport;
  html: string;
}

export function buildDocCoverageViewerArtifact(
  report: DocCoverageReport,
): DocCoverageViewerArtifact {
  return {
    contract: {
      name: "memory.doc_coverage.viewer",
      version: "memory.doc_coverage.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderDocCoverageViewer(report),
  };
}

function renderDocCoverageViewer(report: DocCoverageReport): string {
  const groundedPct =
    report.total_docs === 0
      ? "0%"
      : `${Math.round((report.grounded_docs / report.total_docs) * 100)}%`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory doc coverage viewer</title>
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
      --code: #242923;
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
    .metric, section, .doc {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 14px;
    }
    .metric strong { display: block; font-size: 22px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(300px, .75fr); gap: 14px; }
    .stack { display: grid; gap: 12px; }
    .doc-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
      color: var(--code);
    }
    .status {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .ok { color: var(--accent); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    @media (max-width: 880px) {
      header, .metrics, .layout, .doc-header { grid-template-columns: 1fr; }
      .badge, .status { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Documentation Coverage</h1>
        <p class="meta">Generated from ${escapeHtml(report.schema_version)} graph and vector evidence.</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Documents", report.total_docs)}
      ${metric("Grounded", `${report.grounded_docs}/${report.total_docs}`, groundedPct)}
      ${metric("References", report.total_references, `${report.docs_with_references} doc(s)`)}
      ${metric("Vectors", report.vector.ready, `${report.vector.overall} / ${report.vector.total} total`)}
    </div>
    <div class="layout">
      <div class="stack">${report.docs.length === 0 ? emptyDocs() : report.docs.map(docItem).join("")}</div>
      <div class="stack">
        ${warningsSection(report.warnings, "No coverage warnings.")}
        ${vectorSection(report)}
      </div>
    </div>
    <script id="doc-coverage-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>
`;
}


function emptyDocs(): string {
  return `<section><h2>Documents</h2><p class="empty">No ingested documents available.</p></section>`;
}

function docItem(doc: DocCoverageItem): string {
  const statusClass = doc.graph_status === "grounded" ? "ok" : "bad";
  const vectorClass = doc.vector_status === "ready" ? "ok" : doc.vector_status === "failed" ? "bad" : "warn";
  const title = doc.title ? `${doc.path} - ${doc.title}` : doc.path;
  return `<article class="doc">
    <div class="doc-header">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="meta"><code>memory_docs:${doc.rid}</code> - ${doc.body_bytes} bytes${doc.truncated ? " - truncated" : ""}</p>
      </div>
      <div class="status ${statusClass}">${escapeHtml(doc.graph_status)}</div>
    </div>
    <p class="meta">Root: ${doc.root_node ? escapeHtml(doc.root_node.title) : "none"} - Vector: <span class="${vectorClass}">${escapeHtml(doc.vector_status)}</span></p>
    ${references(doc)}
  </article>`;
}

function references(doc: DocCoverageItem): string {
  if (doc.references.count === 0) {
    return `<p class="empty">No extracted references.</p>`;
  }
  return `<section>
    <h3>${doc.references.count} extracted reference(s)</h3>
    <ul>${doc.references.examples.map((ref) => `<li><strong>${escapeHtml(ref.title)}</strong><p class="meta"><code>${escapeHtml(ref.label)}</code> - ${escapeHtml(ref.node_type)}</p></li>`).join("")}</ul>
  </section>`;
}


function vectorSection(report: DocCoverageReport): string {
  return `<section>
    <h2>Vector Projection</h2>
    <ul>
      <li><strong>${escapeHtml(report.vector.overall)}</strong><p class="meta">${report.vector.ready}/${report.vector.total} ready</p></li>
      <li><strong>${report.vector.stale}</strong><p class="meta">stale</p></li>
      <li><strong>${report.vector.unavailable}</strong><p class="meta">unavailable</p></li>
      <li><strong>${report.vector.failed}</strong><p class="meta">failed</p></li>
    </ul>
  </section>`;
}
