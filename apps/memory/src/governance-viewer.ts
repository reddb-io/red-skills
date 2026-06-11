import type { MemoryGovernanceReport } from "./governance.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface MemoryGovernanceViewerArtifact {
  contract: {
    name: "memory.governance.viewer";
    version: "memory.governance.viewer.v1";
    consumes: "memory.governance.v1";
  };
  report: MemoryGovernanceReport;
  html: string;
}

export function buildMemoryGovernanceViewerArtifact(
  report: MemoryGovernanceReport,
): MemoryGovernanceViewerArtifact {
  return {
    contract: {
      name: "memory.governance.viewer",
      version: "memory.governance.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderMemoryGovernanceViewer(report),
  };
}

function renderMemoryGovernanceViewer(report: MemoryGovernanceReport): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory governance viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f6f1;
      --ink: #202421;
      --muted: #667067;
      --line: #d7ddd3;
      --panel: #ffffff;
      --accent: #0b6f5d;
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
      grid-template-columns: repeat(7, minmax(0, 1fr));
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .75fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    li:first-child { border-top: 0; padding-top: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 900px) {
      header, .metrics, .layout, li { grid-template-columns: 1fr; }
      .badge, .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Governance</h1>
        <p class="meta">Read-only trust audit over provenance, privacy, lint policy, contradictions, and supersession evidence.</p>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code> - ${escapeHtml(report.generated_at)}</p>
      </div>
      <div class="badge ${statusClass(report.status)}">${escapeHtml(report.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Nodes", report.summary.total_nodes)}
      ${metric("Provenance", `${report.summary.nodes_with_provenance}/${report.summary.total_nodes}`)}
      ${metric("Privacy", report.summary.privacy_findings)}
      ${metric("Lint", report.summary.lint_findings)}
      ${metric("Conflicts", report.summary.unresolved_contradictions)}
      ${metric("Superseded", report.summary.superseded_nodes)}
      ${metric("Tidy", report.tidy_availability.status)}
    </div>
    <div class="layout">
      <div class="stack">
        <section>
          <h2>Governance Signals</h2>
          <ul>
            ${signal("Provenance coverage", `${Math.round(report.provenance.coverage * 100)}% covered, ${report.summary.missing_provenance} missing`, report.summary.missing_provenance > 0 ? "attention" : "ok")}
            ${signal("Privacy scan", `${report.privacy.findings.length} sensitive-looking finding(s), ${report.privacy.warnings.length} warning(s)`, report.privacy.findings.length > 0 ? "attention" : "ok")}
            ${signal("Memory lint", `${report.lint.findings.length} policy finding(s)`, report.lint.findings.length > 0 ? "attention" : "ok")}
            ${signal("Contradictions", `${report.summary.unresolved_contradictions} unresolved, ${report.summary.resolved_contradictions} resolved`, report.summary.unresolved_contradictions > 0 ? "attention" : "ok")}
            ${signal("Tidy availability", `${report.tidy_availability.status}${report.tidy_availability.reason ? ` - ${report.tidy_availability.reason}` : ""}`, report.tidy_availability.status === "available" ? "ok" : "attention")}
          </ul>
        </section>
        <section>
          <h2>Contradictions</h2>
          ${report.contradictions.length === 0 ? `<p class="empty">No contradiction edges found.</p>` : `<ul>${report.contradictions.slice(0, 12).map((item) => `<li><div><h3>${escapeHtml(item.from.title)} -> ${escapeHtml(item.to.title)}</h3><p class="meta">${escapeHtml(item.reason ?? "no reason")} - ${item.resolved ? "resolved" : "unresolved"}</p></div><span class="pill ${item.resolved ? "" : "warn"}">${item.resolved ? "resolved" : "open"}</span></li>`).join("")}</ul>`}
        </section>
        <section>
          <h2>Provider Tidy Recommendations</h2>
          <p class="meta">Read-only duplicate and near-duplicate Soft-merge inspection output. Governance does not apply these recommendations.</p>
          ${report.tidy_recommendations.recommendations.length === 0 ? `<p class="empty">${escapeHtml(report.tidy_recommendations.reason ?? "No provider tidy recommendations.")}</p>` : `<ul>${report.tidy_recommendations.recommendations.map((item) => `<li><div><h3>${escapeHtml(item.proposed_soft_merge.direction)}</h3><p class="meta">${escapeHtml(item.relation)} - confidence ${item.confidence.toFixed(2)} - ${escapeHtml(item.rationale)}</p><p class="meta"><code>${escapeHtml(item.id)}</code></p></div><span class="pill">${escapeHtml(item.review_status)}</span></li>`).join("")}</ul>`}
        </section>
        <section>
          <h2>Missing Provenance</h2>
          ${report.provenance.missing.length === 0 ? `<p class="empty">All visible nodes have provenance metadata.</p>` : `<ul>${report.provenance.missing.slice(0, 12).map((item) => `<li><div><h3>${escapeHtml(item.title)}</h3><p class="meta"><code>memory_nodes:${item.rid}</code> - ${escapeHtml(item.node_type)} - ${escapeHtml(item.label)}</p></div></li>`).join("")}</ul>`}
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Finding Samples</h2>
          <ul>
            ${[...report.privacy.findings.slice(0, 5).map((finding) => findingItem("Privacy", finding.kind, finding.message, finding.location, finding.severity)), ...report.lint.findings.slice(0, 5).map((finding) => findingItem("Lint", finding.code, finding.message, finding.location, finding.severity))].join("") || `<li><div><p class="empty">No privacy or lint findings.</p></div></li>`}
          </ul>
        </section>
        <section>
          <h2>Recommended Next Actions</h2>
          ${report.recommended_next_actions.length === 0 ? `<p class="empty">No recommended next actions.</p>` : `<ul>${report.recommended_next_actions.map((action) => `<li><div><p class="meta">${escapeHtml(action)}</p></div></li>`).join("")}</ul>`}
        </section>
      </div>
    </div>
    <script id="memory-governance-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function signal(title: string, detail: string, status: "ok" | "attention"): string {
  return `<li><div><h3>${escapeHtml(title)}</h3><p class="meta">${escapeHtml(detail)}</p></div><span class="pill ${status === "attention" ? "warn" : ""}">${status}</span></li>`;
}

function findingItem(
  category: string,
  code: string,
  message: string,
  location: string,
  severity: string,
): string {
  return `<li><div><h3>${escapeHtml(category)}: ${escapeHtml(code)}</h3><p class="meta">${escapeHtml(message)} - <code>${escapeHtml(location)}</code></p></div><span class="pill ${severity === "error" ? "bad" : "warn"}">${escapeHtml(severity)}</span></li>`;
}


function statusClass(status: string): string {
  if (status === "ok") return "";
  if (status === "attention") return "warn";
  return "bad";
}
