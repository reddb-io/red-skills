export function buildDocReferenceGraphViewerArtifact(report) {
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
function renderDocReferenceGraphViewer(report) {
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
        ${warningSection(report.warnings)}
      </div>
    </div>
    <script id="doc-reference-graph-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>
`;
}
function graphSvg(report) {
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
function positions(nodes, x, rowHeight, top) {
    return new Map(nodes.map((node, index) => [node.id, { x, y: top + index * rowHeight }]));
}
function edgeLine(edge, docPositions, refPositions) {
    const from = docPositions.get(edge.from);
    const to = refPositions.get(edge.to);
    if (!from || !to)
        return "";
    return `<line class="edge" x1="${from.x + 9}" y1="${from.y}" x2="${to.x - 9}" y2="${to.y}" />`;
}
function graphNode(node, nodePositions, className, labelOffset) {
    const position = nodePositions.get(node.id);
    if (!position)
        return "";
    const labelX = labelOffset > 0 ? position.x + labelOffset : position.x + labelOffset - 300;
    const label = truncate(node.title, 42);
    return `<g>
    <circle class="${className}" cx="${position.x}" cy="${position.y}" r="7" />
    <text class="node-label" x="${labelX}" y="${position.y + 4}">${escapeHtml(label)}</text>
  </g>`;
}
function edgeSection(edges) {
    const visible = edges.slice(0, 80);
    return `<section>
    <h2>Reference Edges</h2>
    ${visible.length === 0
        ? `<p class="empty">No extracted doc reference edges.</p>`
        : `<ul>${visible.map((edge) => `<li><strong>${escapeHtml(edge.source_doc_path)}</strong><p class="meta"><code>${escapeHtml(edge.from)}</code> REFERENCES <code>${escapeHtml(edge.to)}</code></p></li>`).join("")}</ul>`}
  </section>`;
}
function topReferencesSection(report) {
    return `<section>
    <h2>Top References</h2>
    ${report.top_references.length === 0
        ? `<p class="empty">No referenced nodes found.</p>`
        : `<ul>${report.top_references.map((ref) => `<li><strong>${escapeHtml(ref.node.title)}</strong><p class="meta">${ref.incoming_docs} doc(s) - <code>${escapeHtml(ref.node.label)}</code></p></li>`).join("")}</ul>`}
  </section>`;
}
function warningSection(warnings) {
    return `<section>
    <h2>Warnings</h2>
    ${warnings.length === 0
        ? `<p class="empty">No reference graph warnings.</p>`
        : `<ul>${warnings.map((warning) => `<li class="warn">${escapeHtml(warning)}</li>`).join("")}</ul>`}
  </section>`;
}
function metric(label, value) {
    return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}
function truncate(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}
function jsonForScript(value) {
    return JSON.stringify(value, null, 2).replaceAll("</", "<\\/");
}
