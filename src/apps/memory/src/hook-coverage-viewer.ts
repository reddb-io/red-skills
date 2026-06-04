import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";
import type {
  HookCoverageEvent,
  HookCoverageReport,
  HookCoverageRunner,
} from "./hook-coverage.js";

export interface HookCoverageViewerArtifact {
  contract: {
    name: "memory.hook_coverage.viewer";
    version: "memory.hook_coverage.viewer.v1";
    consumes: "memory.hook_coverage.v1";
  };
  report: HookCoverageReport;
  html: string;
}

export function buildHookCoverageViewerArtifact(
  report: HookCoverageReport,
): HookCoverageViewerArtifact {
  return {
    contract: {
      name: "memory.hook_coverage.viewer",
      version: "memory.hook_coverage.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderHookCoverageViewer(report),
  };
}

function renderHookCoverageViewer(report: HookCoverageReport): string {
  const runners = report.runners.map(runnerSection).join("");
  const actions =
    report.recommended_next_actions.length === 0
      ? `<p class="empty">No recommended next actions.</p>`
      : `<ul>${report.recommended_next_actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`;
  const gaps =
    report.gaps.length === 0
      ? `<p class="empty">No coverage gaps.</p>`
      : `<ul>${report.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory hook coverage viewer</title>
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
    .event {
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
      header, .metrics, .layout, .event { grid-template-columns: 1fr; }
      .badge, .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Hook Coverage</h1>
        <p class="meta">${escapeHtml(report.root)}</p>
        <p class="meta">Read-only lifecycle hook manifest and config coverage.</p>
      </div>
      <div class="badge">${escapeHtml(report.mode)}</div>
    </header>
    <div class="metrics">
      ${metric("Runners", report.summary.runner_count)}
      ${metric("Wired", `${report.summary.wired_events}/${report.summary.total_events}`)}
      ${metric("Enabled", `${report.summary.enabled_events}/${report.summary.total_events}`)}
      ${metric("Effective", `${report.summary.effective_events}/${report.summary.total_events}`)}
      ${metric("Actionable Gaps", report.summary.actionable_gaps)}
    </div>
    <div class="layout">
      <div class="stack">${runners}</div>
      <div class="stack">
        <section>
          <h2>Gaps</h2>
          ${gaps}
        </section>
        <section>
          <h2>Recommended Next Actions</h2>
          ${actions}
        </section>
      </div>
    </div>
    <script id="hook-coverage-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function runnerSection(runner: HookCoverageRunner): string {
  return `<section>
    <h2>${escapeHtml(runner.runner)}</h2>
    <p class="meta"><code>${escapeHtml(runner.manifest_path)}</code></p>
    <p class="meta">${runner.coverage.enabled}/${runner.coverage.total} enabled, ${runner.coverage.effective}/${runner.coverage.total} effectively covered</p>
    <ul>${runner.events.map(eventItem).join("")}</ul>
  </section>`;
}

function eventItem(event: HookCoverageEvent): string {
  const state = event.effectively_covered
    ? "covered"
    : event.enabled
      ? "enabled"
      : event.wired
        ? "wired"
        : "missing";
  const stateClass = state === "covered" || state === "enabled" ? "" : state === "wired" ? "warn" : "bad";
  return `<li class="event">
    <div>
      <h3>${escapeHtml(event.event)}</h3>
      <p class="meta">${escapeHtml(event.flag)} - ${event.command_count} command(s)${event.matcher ? ` - matcher ${escapeHtml(event.matcher)}` : ""}</p>
      ${event.notes.length === 0 ? "" : `<p class="meta">${escapeHtml(event.notes.join("; "))}</p>`}
    </div>
    <span class="pill ${stateClass}">${escapeHtml(state)}</span>
  </li>`;
}
