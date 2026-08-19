import type { CompetitiveEvalV2Report } from "./competitive-baseline.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface CompetitiveEvalViewerArtifact {
  contract: {
    name: "memory.reference_eval.viewer";
    version: "memory.reference_eval.viewer.v1";
    consumes: "memory.reference_eval.v2";
  };
  report: CompetitiveEvalV2Report;
  html: string;
}

export function buildCompetitiveEvalViewerArtifact(
  report: CompetitiveEvalV2Report,
): CompetitiveEvalViewerArtifact {
  return {
    contract: {
      name: "memory.reference_eval.viewer",
      version: "memory.reference_eval.viewer.v1",
      consumes: report.schemaVersion,
    },
    report,
    html: renderCompetitiveEvalViewer(report),
  };
}

function renderCompetitiveEvalViewer(report: CompetitiveEvalV2Report): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory Reference Eval</title>
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
    .fail { color: var(--bad); }
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
    .counts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .count {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 4px 7px;
      color: var(--muted);
      font-size: 12px;
    }
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
        <h1>Memory Reference Eval</h1>
        <p class="meta">Read-only executable claim guard for Memory moat evidence, checked fixtures, and opt-in live baselines.</p>
        <p class="meta"><code>${escapeHtml(report.schemaVersion)}</code> - ${escapeHtml(report.fixture.name)}</p>
      </div>
      <div class="badge ${statusClass(report.composite.status)}">${report.composite.score}/${report.composite.maxScore} ${escapeHtml(report.composite.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Normalized", report.composite.normalizedScore)}
      ${metric("Dimensions", report.dimensions.length)}
      ${metric("Fixture Nodes", report.fixture.nodes)}
      ${metric("Live Baselines", report.liveBaselines.length)}
      ${metric("Claim Guards", report.claimGuards.status)}
    </div>
    <div class="layout">
      <div class="stack">
        <section>
          <h2>Dimensions</h2>
          <ul>${report.dimensions.map(dimensionItem).join("")}</ul>
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Live Baselines</h2>
          ${report.liveBaselines.length === 0 ? `<p class="empty">No live baseline requested. Fixture eval remains service-free.</p>` : `<ul>${report.liveBaselines.map(baselineItem).join("")}</ul>`}
        </section>
        <section>
          <h2>Claim Guards</h2>
          <ul>
            ${guardItem("Unsupported public claims", report.claimGuards.unsupportedPublicClaims)}
            ${guardItem("Unsupported live reference claims", report.claimGuards.unsupportedLiveCompetitorClaims)}
            ${guardItem("Unmeasured live baselines", report.claimGuards.unmeasuredLiveBaselines)}
          </ul>
        </section>
      </div>
    </div>
    <script id="memory-reference-eval-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function dimensionItem(dimension: CompetitiveEvalV2Report["dimensions"][number]): string {
  const subChecks = dimension.subChecks ?? [];
  const subChecksHtml = subChecks.length === 0
    ? ""
    : `<div class="counts">${subChecks
        .map(
          (check) =>
            `<span class="count ${statusClass(check.status)}" title="${escapeHtml(check.detail)}">${escapeHtml(check.id)}: ${escapeHtml(check.status)}</span>`,
        )
        .join("")}</div>`;
  return `<li>
    <div>
      <h3>${escapeHtml(dimension.id)}</h3>
      <p class="meta">${escapeHtml(dimension.detail)}</p>
      <div class="counts">
        ${Object.entries(dimension.metrics).map(([key, value]) => `<span class="count">${escapeHtml(key)}=${escapeHtml(String(value))}</span>`).join("")}
      </div>
      ${subChecksHtml}
      <p class="meta">${dimension.evidence.map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</p>
    </div>
    <span class="pill ${statusClass(dimension.status)}">${dimension.score}/${dimension.maxScore} ${escapeHtml(dimension.status)}</span>
  </li>`;
}

function baselineItem(baseline: CompetitiveEvalV2Report["liveBaselines"][number]): string {
  return `<li>
    <div>
      <h3>${escapeHtml(baseline.competitor)}</h3>
      <p class="meta">${escapeHtml(baseline.summary)}</p>
      <p class="meta"><code>${escapeHtml(baseline.adapter)}</code> - ${escapeHtml(baseline.command.join(" "))}</p>
      <div class="counts">${Object.entries(baseline.metrics).map(([key, value]) => `<span class="count">${escapeHtml(key)}=${escapeHtml(String(value))}</span>`).join("")}</div>
    </div>
    <span class="pill ${statusClass(baseline.state === "measured" ? "pass" : baseline.state === "failed" ? "fail" : "warn")}">${escapeHtml(baseline.state)}</span>
  </li>`;
}

function guardItem(label: string, values: string[]): string {
  return `<li><div><h3>${escapeHtml(label)}</h3><p class="meta">${values.length === 0 ? "none" : values.map(escapeHtml).join(", ")}</p></div><span class="pill ${values.length === 0 ? "" : "fail"}">${values.length}</span></li>`;
}


function statusClass(status: string): string {
  if (status === "fail" || status === "failed") return "fail";
  if (status === "warn" || status === "skipped" || status === "unavailable") return "warn";
  return "";
}
