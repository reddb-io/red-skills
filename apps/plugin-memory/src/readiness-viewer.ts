import type { MemoryReadinessEnvelope } from "./readiness.js";
import type { PreflightEvidence, PreflightWarning } from "./preflight.js";
import { escapeHtml, jsonForScript, metricWithRequiredMeta as metric } from "./viewer-utils.js";

export interface ReadinessViewerArtifact {
  contract: {
    name: "memory.readiness.viewer";
    version: "memory.readiness.viewer.v1";
    consumes: "memory.readiness.v1";
  };
  envelope: MemoryReadinessEnvelope;
  html: string;
}

export function buildReadinessViewerArtifact(
  envelope: MemoryReadinessEnvelope,
): ReadinessViewerArtifact {
  return {
    contract: {
      name: "memory.readiness.viewer",
      version: "memory.readiness.viewer.v1",
      consumes: envelope.contract.version,
    },
    envelope,
    html: renderReadinessViewer(envelope),
  };
}

function renderReadinessViewer(envelope: MemoryReadinessEnvelope): string {
  const statusClass = envelope.status === "ready" ? "ok" : envelope.status;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory readiness viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f4;
      --ink: #1d2220;
      --muted: #606762;
      --line: #d7d9d2;
      --panel: #ffffff;
      --accent: #0f6b60;
      --warn: #9b5a13;
      --bad: #a73636;
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
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      align-items: start;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--line);
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; letter-spacing: 0; }
    h2 { font-size: 17px; margin-bottom: 10px; }
    h3 { font-size: 14px; margin-bottom: 4px; }
    .goal { color: var(--muted); margin-top: 6px; }
    .status {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--panel);
      font-weight: 700;
      text-transform: uppercase;
      font-size: 12px;
    }
    .status.ok { color: var(--accent); }
    .status.needs-evidence { color: var(--bad); }
    .status.review-warnings { color: var(--warn); }
    .grid {
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
    .metric span, .meta, .empty { color: var(--muted); font-size: 13px; }
    .sections {
      display: grid;
      grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.65fr);
      gap: 16px;
    }
    .stack { display: grid; gap: 16px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li {
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    li:first-child { border-top: 0; padding-top: 0; }
    .bad { color: var(--bad); }
    .warn { color: var(--warn); }
    .tag {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 1px 7px;
      margin: 6px 4px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #202522;
      color: #f8fbf5;
      border-radius: 6px;
      padding: 12px;
      font-size: 12px;
    }
    @media (max-width: 820px) {
      header, .sections, .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Task Readiness</h1>
        <p class="goal">${escapeHtml(envelope.request.goal)}</p>
        <p class="meta">Generated ${escapeHtml(envelope.request.generated_at)} from ${escapeHtml(envelope.contract.version)}</p>
      </div>
      <div class="status ${statusClass}">${escapeHtml(envelope.status)}</div>
    </header>
    <div class="grid">
      ${metric("Active evidence", `${envelope.retrieval.recall.active_evidence_count}/${envelope.retrieval.recall.evidence_count}`, "readiness recall")}
      ${metric("Missing evidence", envelope.evidence.missing.missing ? "yes" : "no", `${envelope.evidence.missing.active_count}/${envelope.evidence.missing.expected_minimum} active`)}
      ${metric("Contradictions", String(envelope.trust.contradictions.unresolved), `${envelope.trust.contradictions.total} total`)}
      ${metric("Supersession", String(envelope.trust.supersession.superseded_nodes), `${envelope.trust.supersession.active_successors} active successors`)}
    </div>
    <div class="sections">
      <div class="stack">
        ${evidenceSection("Relevant evidence", envelope.evidence.active)}
        ${evidenceSection("Supersession", envelope.evidence.superseded)}
        ${evidenceSection("Stale evidence", envelope.evidence.stale)}
      </div>
      <div class="stack">
        ${missingSection(envelope)}
        ${preflightWarningSection("Contradictions", envelope.evidence.contradictions, "bad")}
        ${nextActionsSection(envelope.next_actions)}
        ${contractSection(envelope)}
      </div>
    </div>
    <script id="readiness-data" type="application/json">${jsonForScript(envelope)}</script>
  </main>
</body>
</html>
`;
}


function evidenceSection(title: string, evidence: PreflightEvidence[]): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${
      evidence.length === 0
        ? `<p class="empty">No ${escapeHtml(title.toLowerCase())} available.</p>`
        : `<ul>${evidence.map(evidenceItem).join("")}</ul>`
    }
  </section>`;
}

function evidenceItem(item: PreflightEvidence): string {
  return `<li>
    <h3>${escapeHtml(item.title)}</h3>
    <p>${escapeHtml(item.excerpt)}</p>
    <p class="meta">${escapeHtml(item.urn)} - ${escapeHtml(item.nodeType)} - ${escapeHtml(item.confidence)}</p>
    <div>${item.statuses.map((status) => `<span class="tag">${escapeHtml(status)}</span>`).join("")}</div>
  </li>`;
}

function missingSection(envelope: MemoryReadinessEnvelope): string {
  const missing = envelope.evidence.missing;
  return `<section>
    <h2>Missing evidence</h2>
    <p class="${missing.missing ? "bad" : "meta"}">${missing.active_count}/${missing.expected_minimum} active evidence item(s)</p>
    ${missing.messages.length === 0 ? `<p class="empty">No missing evidence messages.</p>` : `<ul>${missing.messages.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`}
  </section>`;
}

function preflightWarningSection(
  title: string,
  warnings: PreflightWarning[],
  severityClass: "bad" | "warn",
): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${
      warnings.length === 0
        ? `<p class="empty">No ${escapeHtml(title.toLowerCase())} available.</p>`
        : `<ul>${warnings.map((warning) => warningItem(warning, severityClass)).join("")}</ul>`
    }
  </section>`;
}

function warningItem(warning: PreflightWarning, severityClass: "bad" | "warn"): string {
  return `<li>
    <p class="${severityClass}">${escapeHtml(warning.message)}</p>
    <p class="meta">${warning.rids.map((rid) => `memory_nodes:${rid}`).join(", ")}</p>
  </li>`;
}

function nextActionsSection(actions: string[]): string {
  return `<section>
    <h2>Next actions</h2>
    ${
      actions.length === 0
        ? `<p class="empty">No next actions available.</p>`
        : `<ul>${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`
    }
  </section>`;
}

function contractSection(envelope: MemoryReadinessEnvelope): string {
  return `<section>
    <h2>Readiness contract</h2>
    <p class="meta">${escapeHtml(envelope.contract.name)} ${escapeHtml(envelope.contract.version)}</p>
    <pre>${escapeHtml(JSON.stringify(envelope.contract, null, 2))}</pre>
  </section>`;
}
