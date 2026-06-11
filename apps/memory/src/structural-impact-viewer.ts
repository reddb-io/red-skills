import type { StructuralImpact, StructuralImpactTarget } from "./structural-impact-reader.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface StructuralImpactViewerArtifact {
  contract: {
    name: "memory.structural_impact.viewer";
    version: "memory.structural_impact.viewer.v1";
    consumes: "memory.structural-impact";
  };
  target: StructuralImpactTarget;
  impact: StructuralImpact;
  html: string;
}

export function buildStructuralImpactViewerArtifact(
  target: StructuralImpactTarget,
  impact: StructuralImpact,
): StructuralImpactViewerArtifact {
  return {
    contract: {
      name: "memory.structural_impact.viewer",
      version: "memory.structural_impact.viewer.v1",
      consumes: "memory.structural-impact",
    },
    target,
    impact,
    html: renderStructuralImpactViewer(target, impact),
  };
}

function renderStructuralImpactViewer(
  target: StructuralImpactTarget,
  impact: StructuralImpact,
): string {
  const title = [target.file ? `file ${target.file}` : "", target.symbol ? `symbol ${target.symbol}` : ""]
    .filter(Boolean)
    .join(" / ") || "unknown target";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory structural impact viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f2;
      --ink: #202521;
      --muted: #647068;
      --line: #d5d9d0;
      --panel: #ffffff;
      --accent: #0d6f6a;
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
    main {
      width: min(1180px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 42px;
    }
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
    h3 { font-size: 13px; margin-bottom: 4px; }
    .target, .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--panel);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
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
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
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
    @media (max-width: 860px) {
      header, .metrics, .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Structural Impact</h1>
        <p class="target">${escapeHtml(title)}</p>
        <p class="meta">Generated from memory.structural-impact graph evidence.</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Defined symbols", impact.defines.length)}
      ${metric("Imports", impact.imports.length)}
      ${metric("Calls", impact.calls.length + impact.calledBy.length)}
      ${metric("References", impact.references.length + impact.referencedBy.length)}
    </div>
    <div class="grid">
      ${nodeSection("Defined here", impact.defines)}
      ${edgeSection("Imports", impact.imports, "to")}
      ${edgeSection("Imported by", impact.importedBy, "from")}
      ${edgeSection("Calls", impact.calls, "to")}
      ${edgeSection("Called by", impact.calledBy, "from")}
      ${edgeSection("Uses types", impact.usesTypes, "to")}
      ${edgeSection("Used as type by", impact.usedByTypes, "from")}
      ${edgeSection("References", impact.references, "to")}
      ${edgeSection("Referenced by", impact.referencedBy, "from")}
      ${definedInSection(impact)}
    </div>
    <script id="structural-impact-data" type="application/json">${jsonForScript({ target, impact })}</script>
  </main>
</body>
</html>
`;
}


function nodeSection(title: string, nodes: StructuralImpact["defines"]): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${
      nodes.length === 0
        ? `<p class="empty">No nodes available.</p>`
        : `<ul>${nodes.map((node) => `<li><h3>${escapeHtml(String(node.properties.title ?? node.label))}</h3><p class="meta"><code>${escapeHtml(node.label)}</code></p></li>`).join("")}</ul>`
    }
  </section>`;
}

function edgeSection(
  title: string,
  edges: StructuralImpact["imports"],
  focus: "from" | "to",
): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${
      edges.length === 0
        ? `<p class="empty">No ${escapeHtml(title.toLowerCase())} available.</p>`
        : `<ul>${edges.map((edge) => edgeItem(edge, focus)).join("")}</ul>`
    }
  </section>`;
}

function edgeItem(edge: StructuralImpact["imports"][number], focus: "from" | "to"): string {
  const node = focus === "from" ? edge.from : edge.to;
  return `<li>
    <h3>${escapeHtml(String(node.properties.title ?? node.label))}</h3>
    <p class="meta">${escapeHtml(edge.label)} - <code>${escapeHtml(node.label)}</code></p>
  </li>`;
}

function definedInSection(impact: StructuralImpact): string {
  const node = impact.definedIn;
  return `<section>
    <h2>Defined in</h2>
    ${
      node
        ? `<h3>${escapeHtml(String(node.properties.title ?? node.label))}</h3><p class="meta"><code>${escapeHtml(node.label)}</code></p>`
        : `<p class="empty">No containing file available.</p>`
    }
  </section>`;
}
