import type { MemoryExtractionStatus } from "./extraction-status.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface MemoryExtractionStatusViewerArtifact {
  contract: {
    name: "memory.extraction_status.viewer";
    version: "memory.extraction_status.viewer.v1";
    consumes: "memory.extraction_status.v1";
  };
  status: MemoryExtractionStatus;
  html: string;
}

export function buildMemoryExtractionStatusViewerArtifact(
  status: MemoryExtractionStatus,
): MemoryExtractionStatusViewerArtifact {
  return {
    contract: {
      name: "memory.extraction_status.viewer",
      version: "memory.extraction_status.viewer.v1",
      consumes: status.schema_version,
    },
    status,
    html: renderExtractionStatusViewer(status),
  };
}

function renderExtractionStatusViewer(status: MemoryExtractionStatus): string {
  const deterministic = Object.entries(status.deterministic)
    .map(
      ([key, ready]) => `<li class="capability">
        <div>
          <h3>${escapeHtml(label(key))}</h3>
          <p class="meta">${escapeHtml(key)}</p>
        </div>
        <span class="pill ${ready ? "" : "bad"}">${ready ? "ready" : "missing"}</span>
      </li>`,
    )
    .join("");
  const actions =
    status.recommended_next_actions.length === 0
      ? `<p class="empty">No recommended next actions.</p>`
      : `<ul>${status.recommended_next_actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`;
  const inferredState = status.inferred.available
    ? "available"
    : status.inferred.configured
      ? "configured"
      : "local fallback";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory extraction status viewer</title>
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
    h1 { font-size: 28px; letter-spacing: 0; overflow-wrap: anywhere; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 14px; margin-bottom: 5px; overflow-wrap: anywhere; }
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
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
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
    .layout { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(320px, .9fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    li { border-top: 1px solid var(--line); padding-top: 12px; }
    li:first-child { border-top: 0; padding-top: 0; }
    .capability {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 900px) {
      header, .metrics, .layout, .capability { grid-template-columns: 1fr; }
      .badge, .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Extraction Status</h1>
        <p class="meta">${escapeHtml(status.root)} - ${escapeHtml(status.generated_at)}</p>
        <p class="meta">Read-only deterministic and inferred extraction readiness.</p>
      </div>
      <div class="badge ${status.inferred.available ? "" : "warn"}">${escapeHtml(inferredState)}</div>
    </header>
    <div class="metrics">
      ${metric("Deterministic", `${readyDeterministic(status)}/${Object.keys(status.deterministic).length}`)}
      ${metric("Inferred Facts", status.inferred.facts)}
      ${metric("Provider", status.inferred.mode ?? "none")}
      ${metric("Stop Hook", status.inferred.hook_stop_enabled ? "enabled" : "disabled")}
    </div>
    <div class="layout">
      <section>
        <h2>Deterministic Extractors</h2>
        <ul>${deterministic}</ul>
      </section>
      <div class="stack">
        <section>
          <h2>Inferred Extraction</h2>
          <ul>
            <li><strong>Configured</strong><p class="meta">${String(status.inferred.configured)}</p></li>
            <li><strong>Available</strong><p class="meta">${String(status.inferred.available)}</p></li>
            <li><strong>Mode</strong><p class="meta">${escapeHtml(status.inferred.mode ?? "none")}</p></li>
            <li><strong>Model</strong><p class="meta">${escapeHtml(status.inferred.model ?? "none")}</p></li>
            <li><strong>Egress</strong><p class="meta">${escapeHtml(status.inferred.egress ?? "none")}</p></li>
            ${status.inferred.endpoint ? `<li><strong>Endpoint</strong><p class="meta"><code>${escapeHtml(status.inferred.endpoint)}</code></p></li>` : ""}
            ${status.inferred.error ? `<li><strong>Error</strong><p class="meta bad">${escapeHtml(status.inferred.error)}</p></li>` : ""}
          </ul>
        </section>
        <section>
          <h2>Recommended Next Actions</h2>
          ${actions}
        </section>
      </div>
    </div>
    <script id="extraction-status-data" type="application/json">${jsonForScript(status)}</script>
  </main>
</body>
</html>`;
}

function readyDeterministic(status: MemoryExtractionStatus): number {
  return Object.values(status.deterministic).filter(Boolean).length;
}

function label(key: string): string {
  return key.replaceAll("_", " ");
}
