import type { DocBrief, DocBriefCitation } from "./doc-brief.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface DocBriefViewerArtifact {
  contract: {
    name: "memory.doc_brief.viewer";
    version: "memory.doc_brief.viewer.v1";
    consumes: "memory.doc_brief.v1";
  };
  brief: DocBrief;
  html: string;
}

export function buildDocBriefViewerArtifact(
  brief: DocBrief,
): DocBriefViewerArtifact {
  return {
    contract: {
      name: "memory.doc_brief.viewer",
      version: "memory.doc_brief.viewer.v1",
      consumes: brief.schema_version,
    },
    brief,
    html: renderDocBriefViewer(brief),
  };
}

function renderDocBriefViewer(brief: DocBrief): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory docs brief viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #202421;
      --muted: #626d66;
      --line: #d5dad2;
      --panel: #ffffff;
      --accent: #4f6f2d;
      --warn: #8c5d16;
      --bad: #a43a3a;
      --code: #f0f2ee;
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
    .layout { display: grid; grid-template-columns: minmax(0, .9fr) minmax(380px, 1fr); gap: 14px; }
    .stack { display: grid; gap: 12px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    code, pre {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    pre {
      margin: 0;
      background: var(--code);
      border-radius: 6px;
      padding: 12px;
      max-height: 640px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .status-grounded { color: var(--accent); }
    .status-partial { color: var(--warn); }
    .status-missing { color: var(--bad); }
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
        <h1>Documentation Brief</h1>
        <p class="meta">${escapeHtml(brief.query)}</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Status", brief.status)}
      ${metric("Citations", brief.citations.length)}
      ${metric("Gaps", brief.gaps.length)}
      ${metric("Bundle Hits", `${brief.source_bundle.hits}/${brief.source_bundle.total_docs}`)}
    </div>
    <div class="layout">
      <div class="stack">
        ${citationsSection(brief.citations)}
        ${gapsSection(brief.gaps)}
        ${nextActionsSection(brief.next_actions)}
      </div>
      <div class="stack">
        <section>
          <h2>Agent Markdown</h2>
          <pre>${escapeHtml(brief.markdown)}</pre>
        </section>
      </div>
    </div>
    <script id="doc-brief-data" type="application/json">${jsonForScript(brief)}</script>
  </main>
</body>
</html>
`;
}

function citationsSection(citations: DocBriefCitation[]): string {
  return `<section>
    <h2>Citations</h2>
    ${
      citations.length === 0
        ? `<p class="empty">No indexed docs matched this query.</p>`
        : `<ul>${citations.map(citationItem).join("")}</ul>`
    }
  </section>`;
}

function citationItem(citation: DocBriefCitation): string {
  return `<li>
    <h3>${escapeHtml(citation.marker)} ${escapeHtml(citation.title)}</h3>
    <p class="meta"><code>${escapeHtml(citation.path)}</code></p>
    <p class="meta">score ${citation.score} - ${escapeHtml(citation.matched_fields.join(", "))}</p>
    ${citation.excerpt ? `<p class="meta">${escapeHtml(citation.excerpt)}</p>` : ""}
    ${
      citation.references.length === 0
        ? `<p class="meta">No extracted references.</p>`
        : `<p class="meta">References: ${escapeHtml(citation.references.map((reference) => reference.title).join(", "))}</p>`
    }
    ${
      citation.related_docs.length === 0
        ? ""
        : `<p class="meta">Related: ${escapeHtml(citation.related_docs.map((doc) => `${doc.title} (${doc.shared_references})`).join(", "))}</p>`
    }
  </li>`;
}

function gapsSection(gaps: string[]): string {
  return `<section>
    <h2>Gaps</h2>
    ${
      gaps.length === 0
        ? `<p class="empty">No doc brief gaps.</p>`
        : `<ul>${gaps.map((gap) => `<li class="warn">${escapeHtml(gap)}</li>`).join("")}</ul>`
    }
  </section>`;
}

function nextActionsSection(actions: string[]): string {
  return `<section>
    <h2>Next Actions</h2>
    ${
      actions.length === 0
        ? `<p class="empty">No next actions.</p>`
        : `<ul>${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`
    }
  </section>`;
}
