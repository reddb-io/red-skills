import { escapeHtml, jsonForScript, metric, warningsSection } from "./viewer-utils.js";
import type {
  DocReferenceGraphEdge,
  DocReferenceGraphNode,
  DocReferenceGraphReport,
} from "./doc-reference-graph.js";

export interface DocReferenceGraphViewerArtifact {
  contract: {
    name: "memory.doc_reference_graph.viewer";
    version: "memory.doc_reference_graph.viewer.v1";
    consumes: "memory.doc_reference_graph.v1";
  };
  report: DocReferenceGraphReport;
  html: string;
}

export function buildDocReferenceGraphViewerArtifact(
  report: DocReferenceGraphReport,
): DocReferenceGraphViewerArtifact {
  return {
    contract: {
      name: "memory.doc_reference_graph.viewer",
      version: "memory.doc_reference_graph.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderDocReferenceGraphViewer(report),
  };
}

function renderDocReferenceGraphViewer(report: DocReferenceGraphReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory doc reference graph viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #202421;
      --muted: #626d66;
      --line: #d5dad2;
      --panel: #ffffff;
      --accent: #0c6f68;
      --ref: #594b8f;
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
    main { width: min(1220px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 42px; }
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
    .layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr); gap: 14px; }
    .stack { display: grid; gap: 12px; }
    .graph-frame {
      width: 100%;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfcf8;
    }
    svg { display: block; min-width: 760px; }
    .edge { stroke: #aeb8ae; stroke-width: 1.4; opacity: .78; }
    .doc-node { fill: var(--accent); }
    .ref-node { fill: var(--ref); }
    .node-label {
      fill: var(--ink);
      font: 12px ui-sans-serif, system-ui, sans-serif;
    }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .warn { color: var(--warn); }
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
        <h1>Documentation Reference Graph</h1>
        <p class="meta">Generated from ${escapeHtml(report.schema_version)} RedDB graph evidence.</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Documents", report.total_docs)}
      ${metric("Grounded", `${report.grounded_docs}/${report.total_docs}`)}
      ${metric("Referenced Nodes", report.reference_nodes)}
      ${metric("Reference Edges", report.reference_edges)}
    </div>
    <div class="layout">
      <div class="stack">
        <section>
          <h2>Graph</h2>
          <p class="meta">Shows ingested docs linked to their most referenced extracted nodes.</p>
          <div class="graph-frame">${graphSvg(report)}</div>
        </section>
        ${edgeSection(report.edges)}
      </div>
      <div class="stack">
        ${topReferencesSection(report)}
        ${warningsSection(report.warnings, "No reference graph warnings.")}
      </div>
    </div>
    <script id="doc-reference-graph-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>
`;
}

function graphSvg(report: DocReferenceGraphReport): string {
  const docs = report.nodes.filter((node) => node.kind === "doc").slice(0, 32);
  const refs = report.top_references.map((item) => item.node).slice(0, 32);
  const visible = new Set([...docs, ...refs].map((node) => node.id));
  const edges = report.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));
  const rowHeight = 42;
  const height = Math.max(360, Math.max(docs.length, refs.length) * rowHeight + 80);
  const docPositions = positions(docs, 120, rowHeight, 52);
  const refPositions = positions(refs, 660, rowHeight, 52);
  return `<svg viewBox="0 0 820 ${height}" role="img" aria-label="Documentation reference graph">
    ${edges.map((edge) => edgeLine(edge, docPositions, refPositions)).join("")}
    ${docs.map((node) => graphNode(node, docPositions, "doc-node", 18)).join("")}
    ${refs.map((node) => graphNode(node, refPositions, "ref-node", -18)).join("")}
  </svg>`;
}

function positions(
  nodes: DocReferenceGraphNode[],
  x: number,
  rowHeight: number,
  top: number,
): Map<string, { x: number; y: number }> {
  return new Map(nodes.map((node, index) => [node.id, { x, y: top + index * rowHeight }]));
}

function edgeLine(
  edge: DocReferenceGraphEdge,
  docPositions: Map<string, { x: number; y: number }>,
  refPositions: Map<string, { x: number; y: number }>,
): string {
  const from = docPositions.get(edge.from);
  const to = refPositions.get(edge.to);
  if (!from || !to) return "";
  return `<line class="edge" x1="${from.x + 9}" y1="${from.y}" x2="${to.x - 9}" y2="${to.y}" />`;
}

function graphNode(
  node: DocReferenceGraphNode,
  nodePositions: Map<string, { x: number; y: number }>,
  className: string,
  labelOffset: number,
): string {
  const position = nodePositions.get(node.id);
  if (!position) return "";
  const labelX = labelOffset > 0 ? position.x + labelOffset : position.x + labelOffset - 300;
  const label = truncate(node.title, 42);
  return `<g>
    <circle class="${className}" cx="${position.x}" cy="${position.y}" r="7" />
    <text class="node-label" x="${labelX}" y="${position.y + 4}">${escapeHtml(label)}</text>
  </g>`;
}

function edgeSection(edges: DocReferenceGraphEdge[]): string {
  const visible = edges.slice(0, 80);
  return `<section>
    <h2>Reference Edges</h2>
    ${
      visible.length === 0
        ? `<p class="empty">No extracted doc reference edges.</p>`
        : `<ul>${visible.map((edge) => `<li><strong>${escapeHtml(edge.source_doc_path)}</strong><p class="meta"><code>${escapeHtml(edge.from)}</code> REFERENCES <code>${escapeHtml(edge.to)}</code></p></li>`).join("")}</ul>`
    }
  </section>`;
}

function topReferencesSection(report: DocReferenceGraphReport): string {
  return `<section>
    <h2>Top References</h2>
    ${
      report.top_references.length === 0
        ? `<p class="empty">No referenced nodes found.</p>`
        : `<ul>${report.top_references.map((ref) => `<li><strong>${escapeHtml(ref.node.title)}</strong><p class="meta">${ref.incoming_docs} doc(s) - <code>${escapeHtml(ref.node.label)}</code></p></li>`).join("")}</ul>`
    }
  </section>`;
}



function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
