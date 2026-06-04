import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";
import type {
  MemorySmartSearchReport,
  MemorySmartSearchResult,
} from "./smart-search.js";

export interface MemorySmartSearchViewerArtifact {
  contract: {
    name: "memory.smart_search.viewer";
    version: "memory.smart_search.viewer.v1";
    consumes: "memory.smart_search.v1";
  };
  report: MemorySmartSearchReport;
  html: string;
}

export function buildMemorySmartSearchViewerArtifact(
  report: MemorySmartSearchReport,
): MemorySmartSearchViewerArtifact {
  return {
    contract: {
      name: "memory.smart_search.viewer",
      version: "memory.smart_search.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderSmartSearchViewer(report),
  };
}

function renderSmartSearchViewer(report: MemorySmartSearchReport): string {
  const topResults =
    report.top_results.length === 0
      ? `<p class="empty">No fused results matched this query.</p>`
      : `<ul>${report.top_results.map(resultItem).join("")}</ul>`;
  const actions =
    report.recommended_next_actions.length === 0
      ? `<p class="empty">No recommended next actions.</p>`
      : `<ul>${report.recommended_next_actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`;
  const docs =
    report.docs.hits.length === 0
      ? `<p class="empty">No indexed docs matched this query.</p>`
      : `<ul>${report.docs.hits
          .slice(0, 8)
          .map(
            (doc) => `<li>
              <h3>${escapeHtml(doc.title ?? doc.path)}</h3>
              <p class="meta"><code>${escapeHtml(doc.path)}</code></p>
              <p class="meta">score ${doc.score} - ${escapeHtml(doc.matched_fields.join(", "))}</p>
              ${doc.excerpt ? `<p>${escapeHtml(doc.excerpt)}</p>` : ""}
            </li>`,
          )
          .join("")}</ul>`;
  const assets =
    report.assets.assets.length === 0
      ? `<p class="empty">No asset inventory hits matched this query.</p>`
      : `<ul>${report.assets.assets
          .slice(0, 8)
          .map(
            (asset) => `<li>
              <h3>${escapeHtml(asset.title)}</h3>
              <p class="meta"><code>${escapeHtml(asset.path)}</code></p>
              <p class="meta">${escapeHtml(asset.asset_kind)} - ${escapeHtml(asset.media_type)} - ${formatBytes(asset.bytes)}</p>
            </li>`,
          )
          .join("")}</ul>`;
  const vectors =
    report.vector.hits.length === 0
      ? `<p class="empty">${report.vector.status === "available" ? "No vector hits matched this query." : `Vector search unavailable: ${escapeHtml(report.vector.error ?? "not ready")}`}</p>`
      : `<ul>${report.vector.hits
          .slice(0, 8)
          .map(
            (hit) => `<li>
              <h3>${escapeHtml(hit.title)}</h3>
              <p class="meta">${escapeHtml(hit.kind)} - score ${hit.score} - <code>${escapeHtml(hit.path ?? hit.label)}</code></p>
              ${hit.asset_kind ? `<p class="meta">${escapeHtml(hit.asset_kind)} - ${escapeHtml(hit.media_type ?? "unknown")}</p>` : ""}
              <p>${escapeHtml(hit.excerpt)}</p>
            </li>`,
          )
          .join("")}</ul>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory smart search viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #202421;
      --muted: #626d66;
      --line: #d5dad2;
      --panel: #ffffff;
      --accent: #0c6f68;
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
    .badge, .pill, .button-link {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 10px;
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
    .layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    li { border-top: 1px solid var(--line); padding-top: 12px; }
    li:first-child { border-top: 0; padding-top: 0; }
    .result {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 10px;
      align-items: start;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 900px) {
      header, .metrics, .layout, .result { grid-template-columns: 1fr; }
      .badge, .pill, .button-link { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Smart Search</h1>
        <p class="meta">${escapeHtml(report.query)}</p>
        <p class="meta">${escapeHtml(report.generated_at)}</p>
      </div>
      <div class="badge">${escapeHtml(report.vector.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Recall", report.summary.recall_hits)}
      ${metric("Docs", report.summary.doc_hits)}
      ${metric("Assets", report.summary.asset_hits)}
      ${metric("Vectors", report.summary.vector_hits)}
      ${metric("Top Results", report.top_results.length)}
    </div>
    <div class="layout">
      <div class="stack">
        <section>
          <h2>Fused Results</h2>
          ${topResults}
        </section>
        <section>
          <h2>Recommended Next Actions</h2>
          ${actions}
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Document Hits</h2>
          ${docs}
        </section>
        <section>
          <h2>Asset Hits</h2>
          ${assets}
        </section>
        <section>
          <h2>Vector Hits</h2>
          ${vectors}
        </section>
      </div>
    </div>
    <script id="smart-search-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function resultItem(result: MemorySmartSearchResult): string {
  const ref = result.ref.path ?? result.ref.label ?? result.ref.rid ?? result.id;
  return `<li class="result">
    <span class="pill">#${result.rank}</span>
    <div>
      <h3>${escapeHtml(result.title)}</h3>
      <p class="meta">${escapeHtml(result.kind)} - ${escapeHtml(result.sources.join("+"))} - <code>${escapeHtml(String(ref))}</code></p>
      <p class="meta">score ${result.score.toFixed(3)}</p>
      <p>${escapeHtml(result.excerpt)}</p>
      <div class="actions">
        ${result.kind === "doc" && result.ref.path ? `<a class="button-link" href="/api/docs/read?path=${encodeURIComponent(result.ref.path)}">Read Path JSON</a>` : ""}
        ${result.kind === "asset" ? `<a class="button-link" href="/assets?query=${encodeURIComponent(result.title)}">Asset Inventory</a>` : ""}
      </div>
    </div>
  </li>`;
}


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
