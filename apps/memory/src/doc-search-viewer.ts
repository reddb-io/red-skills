import type { DocSearchHit, DocSearchReport } from "./doc-search.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface DocSearchViewerArtifact {
  contract: {
    name: "memory.doc_search.viewer";
    version: "memory.doc_search.viewer.v1";
    consumes: "memory.doc_search.v1";
  };
  report: DocSearchReport;
  html: string;
}

export function buildDocSearchViewerArtifact(
  report: DocSearchReport,
): DocSearchViewerArtifact {
  return {
    contract: {
      name: "memory.doc_search.viewer",
      version: "memory.doc_search.viewer.v1",
      consumes: "memory.doc_search.v1",
    },
    report,
    html: renderDocSearchViewer(report),
  };
}

function renderDocSearchViewer(report: DocSearchReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory docs search viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #202421;
      --muted: #626d66;
      --line: #d5dad2;
      --panel: #ffffff;
      --accent: #285f8f;
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
    .badge, .button-link {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--panel);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      white-space: nowrap;
      text-decoration: none;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
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
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    li { border-top: 1px solid var(--line); padding-top: 12px; }
    li:first-child { border-top: 0; padding-top: 0; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 900px) {
      header, .metrics { grid-template-columns: 1fr; }
      .badge, .button-link { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Documentation Search</h1>
        <p class="meta">${escapeHtml(report.query)}</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Hits", report.hits.length)}
      ${metric("Indexed Docs", report.total_docs)}
      ${metric("Top Score", report.hits[0]?.score ?? 0)}
    </div>
    <section>
      <h2>Search Results</h2>
      ${
        report.hits.length === 0
          ? `<p class="empty">No indexed docs matched this query.</p>`
          : `<ul>${report.hits.map((hit) => hitItem(report.query, hit)).join("")}</ul>`
      }
    </section>
    <script id="doc-search-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>
`;
}

function hitItem(query: string, hit: DocSearchHit): string {
  const title = hit.title ?? hit.path;
  return `<li>
    <h3>${escapeHtml(title)}</h3>
    <p class="meta"><code>${escapeHtml(hit.path)}</code></p>
    <p class="meta">score ${hit.score} - ${escapeHtml(hit.matched_fields.join(", "))}</p>
    ${hit.excerpt ? `<p>${escapeHtml(hit.excerpt)}</p>` : ""}
    <div class="actions">
      <a class="button-link" href="/docs/evidence-pack?rid=${hit.rid}">Evidence Pack</a>
      <a class="button-link" href="/api/docs/read?rid=${hit.rid}">Read JSON</a>
      <a class="button-link" href="/docs/brief?query=${encodeURIComponent(query)}">Brief</a>
      <a class="button-link" href="/docs/bundle?query=${encodeURIComponent(query)}">Bundle</a>
    </div>
  </li>`;
}
