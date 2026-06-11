import type { DocRelatedDoc, DocRelatedReport } from "./doc-related.js";
import type { DocReferenceGraphNode } from "./doc-reference-graph.js";
import { escapeHtml, jsonForScript, metric, warningsSection } from "./viewer-utils.js";

export interface DocRelatedViewerArtifact {
  contract: {
    name: "memory.doc_related.viewer";
    version: "memory.doc_related.viewer.v1";
    consumes: "memory.doc_related.v1";
  };
  report: DocRelatedReport;
  html: string;
}

export function buildDocRelatedViewerArtifact(
  report: DocRelatedReport,
): DocRelatedViewerArtifact {
  return {
    contract: {
      name: "memory.doc_related.viewer",
      version: "memory.doc_related.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderDocRelatedViewer(report),
  };
}

function renderDocRelatedViewer(report: DocRelatedReport): string {
  const title = report.target?.title ?? "Document not found";
  const path = report.target?.path ?? report.target?.label ?? "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory doc related viewer</title>
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
    h1 { font-size: 28px; letter-spacing: 0; overflow-wrap: anywhere; }
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .85fr); gap: 14px; }
    .stack { display: grid; gap: 12px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    @media (max-width: 900px) {
      header, .metrics, .layout { grid-template-columns: 1fr; }
      .badge { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Related Documentation</h1>
        <p class="meta">${escapeHtml(title)}</p>
        ${path ? `<p class="meta"><code>${escapeHtml(path)}</code></p>` : ""}
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Found", report.found ? "yes" : "no")}
      ${metric("References", report.references.length)}
      ${metric("Related Docs", report.related_docs.length)}
      ${metric("Matched By", report.matched_by ?? "none")}
    </div>
    <div class="layout">
      <div class="stack">
        ${relatedDocsSection(report.related_docs)}
      </div>
      <div class="stack">
        ${referencesSection(report.references)}
        ${warningsSection(report.warnings, "No related-doc warnings.")}
      </div>
    </div>
    <script id="doc-related-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>
`;
}

function relatedDocsSection(docs: DocRelatedDoc[]): string {
  return `<section>
    <h2>Related Docs</h2>
    ${
      docs.length === 0
        ? `<p class="empty">No related docs found through shared references.</p>`
        : `<ul>${docs.map(relatedDocItem).join("")}</ul>`
    }
  </section>`;
}

function relatedDocItem(doc: DocRelatedDoc): string {
  return `<li>
    <h3>${escapeHtml(doc.title)}</h3>
    <p class="meta"><code>${escapeHtml(doc.path)}</code></p>
    <p class="meta">${doc.shared_references} shared reference(s)</p>
    ${doc.references.length === 0 ? "" : `<p class="meta">${doc.references.slice(0, 6).map((ref) => escapeHtml(ref.title)).join(", ")}</p>`}
  </li>`;
}

function referencesSection(references: DocReferenceGraphNode[]): string {
  return `<section>
    <h2>References</h2>
    ${
      references.length === 0
        ? `<p class="empty">No extracted references for this doc.</p>`
        : `<ul>${references.slice(0, 80).map((ref) => `<li><strong>${escapeHtml(ref.title)}</strong><p class="meta"><code>${escapeHtml(ref.label)}</code> - ${escapeHtml(ref.node_type)}</p></li>`).join("")}</ul>`
    }
  </section>`;
}
