import type { DocEvidencePack } from "./doc-evidence-pack.js";
import { escapeHtml, jsonForScript, metric, warningsSection } from "./viewer-utils.js";

export interface DocEvidencePackViewerArtifact {
  contract: {
    name: "memory.doc_evidence_pack.viewer";
    version: "memory.doc_evidence_pack.viewer.v1";
    consumes: "memory.doc_evidence_pack.v1";
  };
  pack: DocEvidencePack;
  html: string;
}

export function buildDocEvidencePackViewerArtifact(
  pack: DocEvidencePack,
): DocEvidencePackViewerArtifact {
  return {
    contract: {
      name: "memory.doc_evidence_pack.viewer",
      version: "memory.doc_evidence_pack.viewer.v1",
      consumes: pack.schema_version,
    },
    pack,
    html: renderDocEvidencePackViewer(pack),
  };
}

function renderDocEvidencePackViewer(pack: DocEvidencePack): string {
  const title = pack.doc.title ?? pack.doc.path ?? "Document not found";
  const path = pack.doc.path ?? "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory doc evidence pack viewer</title>
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
        <h1>Doc Evidence Pack</h1>
        <p class="meta">${escapeHtml(title)}</p>
        ${path ? `<p class="meta"><code>${escapeHtml(path)}</code></p>` : ""}
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Found", pack.found ? "yes" : "no")}
      ${metric("References", pack.related.references.length)}
      ${metric("Related Docs", pack.related.related_docs.length)}
      ${metric("Warnings", pack.warnings.length)}
    </div>
    <div class="layout">
      <div class="stack">
        ${referencesSection(pack)}
        ${relatedDocsSection(pack)}
        ${warningsSection(pack.warnings, "No evidence-pack warnings.")}
      </div>
      <div class="stack">
        <section>
          <h2>Agent Markdown</h2>
          <pre>${escapeHtml(pack.markdown)}</pre>
        </section>
      </div>
    </div>
    <script id="doc-evidence-pack-data" type="application/json">${jsonForScript(pack)}</script>
  </main>
</body>
</html>
`;
}

function referencesSection(pack: DocEvidencePack): string {
  return `<section>
    <h2>References</h2>
    ${
      pack.related.references.length === 0
        ? `<p class="empty">No extracted references.</p>`
        : `<ul>${pack.related.references.slice(0, 80).map((ref) => `<li><strong>${escapeHtml(ref.title)}</strong><p class="meta"><code>${escapeHtml(ref.label)}</code> - rid ${ref.rid}</p></li>`).join("")}</ul>`
    }
  </section>`;
}

function relatedDocsSection(pack: DocEvidencePack): string {
  return `<section>
    <h2>Related Docs</h2>
    ${
      pack.related.related_docs.length === 0
        ? `<p class="empty">No related docs found through shared references.</p>`
        : `<ul>${pack.related.related_docs.map((doc) => `<li><strong>${escapeHtml(doc.title)}</strong><p class="meta"><code>${escapeHtml(doc.path)}</code></p><p class="meta">${doc.shared_references} shared reference(s)</p></li>`).join("")}</ul>`
    }
  </section>`;
}
