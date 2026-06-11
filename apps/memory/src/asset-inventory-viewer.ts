import type { MemoryAssetInventoryReport } from "./asset-inventory.js";
import { escapeHtmlNoSingleQuote as escapeHtml } from "./viewer-utils.js";

export interface MemoryAssetInventoryViewerArtifact {
  contract: {
    name: "memory.asset_inventory.viewer";
    version: "memory.asset_inventory.viewer.v1";
    consumes: "memory.asset_inventory.v1";
  };
  report: MemoryAssetInventoryReport;
  html: string;
}

export function buildMemoryAssetInventoryViewerArtifact(
  report: MemoryAssetInventoryReport,
): MemoryAssetInventoryViewerArtifact {
  return {
    contract: {
      name: "memory.asset_inventory.viewer",
      version: "memory.asset_inventory.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderAssetInventory(report),
  };
}

function renderAssetInventory(report: MemoryAssetInventoryReport): string {
  const kinds = report.kinds
    .map(
      (kind) =>
        `<li><strong>${escapeHtml(kind.kind)}</strong><p class="meta">${kind.count} asset(s), ${formatBytes(kind.bytes)}</p></li>`,
    )
    .join("");
  const assets = report.assets
    .map(
      (asset) => `<li class="asset">
        <div class="asset-header">
          <div>
            <h3>${escapeHtml(asset.title)}</h3>
            <p class="meta"><code>${escapeHtml(asset.path)}</code></p>
          </div>
          <span class="pill">${escapeHtml(asset.asset_kind)}</span>
        </div>
        <p class="meta">${escapeHtml(asset.media_type)} · ${formatBytes(asset.bytes)} · rid ${asset.rid}</p>
        ${asset.hash ? `<p class="meta">hash <code>${escapeHtml(asset.hash)}</code></p>` : ""}
      </li>`,
    )
    .join("");
  const warnings = report.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory asset inventory</title>
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
    main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 42px; }
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
    .badge, .pill {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--panel);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
      margin: 20px 0;
    }
    .metric, section, .asset {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 14px;
    }
    .metric strong { display: block; font-size: 22px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(300px, .8fr); gap: 14px; }
    .stack { display: grid; gap: 12px; }
    .asset-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child, li.asset { border-top: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
      color: var(--code);
    }
    @media (max-width: 860px) {
      header, .metrics, .layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Asset Inventory</h1>
        <p class="meta">RedDB metadata for binary document and media assets</p>
      </div>
      <div class="badge">${report.total_assets} asset(s)</div>
    </header>
    <div class="metrics">
      <div class="metric"><strong>${report.total_assets}</strong><span>Total assets</span></div>
      <div class="metric"><strong>${report.kinds.length}</strong><span>Asset kinds</span></div>
      <div class="metric"><strong>${formatBytes(report.total_bytes)}</strong><span>Total bytes</span></div>
    </div>
    <div class="layout">
      <section>
        <h2>Assets</h2>
        ${report.assets.length === 0 ? `<p class="empty">No assets indexed.</p>` : `<ul class="stack">${assets}</ul>`}
      </section>
      <div class="stack">
        <section>
          <h2>Kinds</h2>
          ${report.kinds.length === 0 ? `<p class="empty">No kind summary.</p>` : `<ul>${kinds}</ul>`}
        </section>
        <section>
          <h2>Warnings</h2>
          ${report.warnings.length === 0 ? `<p class="empty">No warnings.</p>` : `<ul>${warnings}</ul>`}
        </section>
      </div>
    </div>
  </main>
  <script id="asset-inventory-data" type="application/json">${escapeHtml(JSON.stringify(report, null, 2))}</script>
</body>
</html>`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
