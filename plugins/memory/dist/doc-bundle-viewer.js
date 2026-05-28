export function buildDocBundleViewerArtifact(bundle) {
    return {
        contract: {
            name: "memory.doc_bundle.viewer",
            version: "memory.doc_bundle.viewer.v1",
            consumes: bundle.schema_version,
        },
        bundle,
        html: renderDocBundleViewer(bundle),
    };
}
function renderDocBundleViewer(bundle) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory docs bundle viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f4;
      --ink: #202421;
      --muted: #626d66;
      --line: #d5dad2;
      --panel: #ffffff;
      --accent: #725c17;
      --warn: #8c5d16;
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
    .layout { display: grid; grid-template-columns: minmax(0, .85fr) minmax(380px, 1fr); gap: 14px; }
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
        <h1>Documentation Bundle</h1>
        <p class="meta">${escapeHtml(bundle.query)}</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Hits", `${bundle.hits.length}/${bundle.total_docs}`)}
      ${metric("Evidence Packs", bundle.packs.length)}
      ${metric("Warnings", bundle.warnings.length)}
      ${metric("Markdown Bytes", Buffer.byteLength(bundle.markdown, "utf8"))}
    </div>
    <div class="layout">
      <div class="stack">
        ${hitsSection(bundle)}
        ${packsSection(bundle)}
        ${warningsSection(bundle.warnings)}
      </div>
      <div class="stack">
        <section>
          <h2>Agent Markdown</h2>
          <pre>${escapeHtml(bundle.markdown)}</pre>
        </section>
      </div>
    </div>
    <script id="doc-bundle-data" type="application/json">${jsonForScript(bundle)}</script>
  </main>
</body>
</html>
`;
}
function hitsSection(bundle) {
    return `<section>
    <h2>Search Hits</h2>
    ${bundle.hits.length === 0
        ? `<p class="empty">No indexed docs matched this query.</p>`
        : `<ul>${bundle.hits.map(hitItem).join("")}</ul>`}
  </section>`;
}
function hitItem(hit) {
    return `<li>
    <h3>${escapeHtml(hit.title || hit.path)}</h3>
    <p class="meta"><code>${escapeHtml(hit.path)}</code></p>
    <p class="meta">score ${hit.score} · ${escapeHtml(hit.matched_fields.join(", "))}</p>
    ${hit.excerpt ? `<p class="meta">${escapeHtml(hit.excerpt)}</p>` : ""}
  </li>`;
}
function packsSection(bundle) {
    return `<section>
    <h2>Evidence Packs</h2>
    ${bundle.packs.length === 0
        ? `<p class="empty">No evidence packs were created.</p>`
        : `<ul>${bundle.packs.map(packItem).join("")}</ul>`}
  </section>`;
}
function packItem(pack) {
    const path = pack.doc.path ?? `rid:${pack.doc.rid ?? "unknown"}`;
    return `<li>
    <h3>${escapeHtml(pack.doc.title ?? path)}</h3>
    <p class="meta"><code>${escapeHtml(path)}</code></p>
    <p class="meta">${pack.related.references.length} reference(s), ${pack.related.related_docs.length} related doc(s)</p>
    ${pack.warnings.length === 0
        ? ""
        : `<p class="meta warn">${escapeHtml(pack.warnings.join("; "))}</p>`}
  </li>`;
}
function warningsSection(warnings) {
    return `<section>
    <h2>Warnings</h2>
    ${warnings.length === 0
        ? `<p class="empty">No bundle warnings.</p>`
        : `<ul>${warnings.map((warning) => `<li class="warn">${escapeHtml(warning)}</li>`).join("")}</ul>`}
  </section>`;
}
function metric(label, value) {
    return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
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
