import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";
import type {
  GuidanceDebt,
  LearningDebtReport,
  RepeatedFailureDebt,
  SkillTelemetryDebt,
  ValidationDebt,
} from "./learning-debt.js";

export interface LearningDebtViewerArtifact {
  contract: {
    name: "memory.learning_debt.viewer";
    version: "memory.learning_debt.viewer.v1";
    consumes: "memory.learning_debt.v1";
  };
  report: LearningDebtReport;
  html: string;
}

export function buildLearningDebtViewerArtifact(
  report: LearningDebtReport,
): LearningDebtViewerArtifact {
  return {
    contract: {
      name: "memory.learning_debt.viewer",
      version: "memory.learning_debt.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderLearningDebtViewer(report),
  };
}

function renderLearningDebtViewer(report: LearningDebtReport): string {
  const totalDebt =
    report.summary.repeatedFailurePatterns +
    report.summary.staleOrContradictedGuidance +
    report.summary.missingValidationEvidence +
    report.summary.skillTelemetryGaps;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory learning debt viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --ink: #202421;
      --muted: #657067;
      --line: #d8ddd4;
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
    .debt { color: var(--bad); }
    .warn { color: var(--warn); }
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
    pre {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfcf8;
      margin: 0;
      padding: 10px;
      max-height: 280px;
      overflow: auto;
      white-space: pre-wrap;
      font-size: 12px;
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
        <h1>Learning Debt</h1>
        <p class="meta">Read-only self-improvement evidence from repeated failures, stale guidance, validation gaps, and Skill telemetry gaps.</p>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code></p>
      </div>
      <div class="badge ${report.status === "clean" ? "" : "debt"}">${escapeHtml(report.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Total Debt", totalDebt)}
      ${metric("Repeated Failures", report.summary.repeatedFailurePatterns)}
      ${metric("Guidance", report.summary.staleOrContradictedGuidance)}
      ${metric("Validation", report.summary.missingValidationEvidence)}
      ${metric("Telemetry", report.summary.skillTelemetryGaps)}
    </div>
    <div class="layout">
      <div class="stack">
        ${section("Repeated Failure Patterns", report.categories.repeatedFailurePatterns, repeatedFailureItem)}
        ${section("Stale Or Contradicted Guidance", report.categories.staleOrContradictedGuidance, guidanceItem)}
        ${section("Missing Validation Evidence", report.categories.missingValidationEvidence, validationItem)}
        ${section("Skill Telemetry Gaps", report.categories.skillTelemetryGaps, telemetryItem)}
      </div>
      <div class="stack">
        <section>
          <h2>Agent Markdown</h2>
          <pre>${escapeHtml(report.markdown)}</pre>
        </section>
      </div>
    </div>
    <script id="learning-debt-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function section<T>(title: string, items: T[], render: (item: T) => string): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${items.length === 0 ? `<p class="empty">No ${escapeHtml(title.toLowerCase())}.</p>` : `<ul>${items.map(render).join("")}</ul>`}
  </section>`;
}

function repeatedFailureItem(item: RepeatedFailureDebt): string {
  return `<li>
    <div>
      <h3>${escapeHtml(item.pattern)}</h3>
      <p class="meta">${item.attemptCount} attempt(s), ${escapeHtml(item.errorClass)}</p>
      <p class="meta">${escapeHtml(item.citations.join(", "))}</p>
      <p class="meta">${escapeHtml(item.touchedFiles.join(", ") || "No touched files recorded.")}</p>
    </div>
    <span class="pill debt">needs lesson</span>
  </li>`;
}

function guidanceItem(item: GuidanceDebt): string {
  return `<li>
    <div>
      <h3>${escapeHtml(item.title)}</h3>
      <p class="meta"><code>${escapeHtml(item.evidence)}</code> - ${escapeHtml(item.nodeType)} - ${escapeHtml(item.kind)}</p>
      <p class="meta">${escapeHtml(item.reason)}</p>
    </div>
    <span class="pill ${item.kind === "contradicted-guidance" ? "debt" : "warn"}">${escapeHtml(item.kind)}</span>
  </li>`;
}

function validationItem(item: ValidationDebt): string {
  return `<li>
    <div>
      <h3>${escapeHtml(item.title)}</h3>
      <p class="meta"><code>${escapeHtml(item.evidence)}</code> - ${escapeHtml(item.nodeType)}</p>
      <p class="meta">${escapeHtml(item.reason)}</p>
    </div>
    <span class="pill debt">needs validation</span>
  </li>`;
}

function telemetryItem(item: SkillTelemetryDebt): string {
  return `<li>
    <div>
      <h3>${escapeHtml(item.skill ?? "Skill telemetry")}</h3>
      <p class="meta">${escapeHtml(item.reason)}</p>
    </div>
    <span class="pill ${item.kind === "telemetry-empty" ? "warn" : "debt"}">${escapeHtml(item.kind)}</span>
  </li>`;
}
