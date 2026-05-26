import type { MemoryStore } from "./graph-store.js";
import {
  buildMemoryAgentIntegrationStatus,
  type MemoryAgentIntegrationStatus,
} from "./agent-integration-status.js";
import {
  buildMemoryCapabilityCatalog,
  type MemoryCapabilityCatalog,
} from "./capability-catalog.js";
import {
  buildMemoryCompetitiveRadar,
  type MemoryCompetitiveRadar,
} from "./competitive-radar.js";
import {
  evaluateCompetitiveEvalV2,
  type CompetitiveEvalV2Report,
} from "./competitive-baseline.js";
import { buildContextPack, type ContextPack } from "./context-pack.js";
import {
  buildMemoryOperationalDashboard,
  type MemoryOperationalDashboard,
} from "./operational-dashboard.js";
import {
  buildMemoryExtractionStatus,
  type MemoryExtractionStatus,
} from "./extraction-status.js";
import {
  buildMemoryGovernanceReport,
  type MemoryGovernanceReport,
} from "./governance.js";
import { buildMemoryHandoff, type MemoryHandoffReport } from "./handoff.js";
import { buildWorkFrontier, type WorkFrontierReport } from "./work-frontier.js";
import {
  buildLearningDebtReport,
  type LearningDebtReport,
} from "./learning-debt.js";
import {
  buildMemoryHealthReport,
  type MemoryHealthReport,
} from "./memory-health.js";
import {
  buildMemoryDecayReport,
  type MemoryDecayReport,
} from "./memory-decay.js";
import {
  buildMemoryLayersReport,
  type MemoryLayersReport,
} from "./memory-layers.js";
import {
  buildReasoningReplay,
  type ReasoningReplayReport,
} from "./reasoning/reasoning-replay.js";
import {
  buildFederationReport,
  type FederationReport,
} from "./federation.js";
import { buildMemoryRoutingGuide, type MemoryRoutingGuide } from "./routing-guide.js";
import { buildSessionTimeline, type SessionTimeline } from "./session-timeline.js";
import { readSkillRollups } from "./skill-events.js";

export interface MemoryWorkbench {
  schema_version: "memory.workbench.v1";
  read_only: true;
  root: string;
  generated_at: string;
  dashboard: MemoryOperationalDashboard;
  capabilities: MemoryCapabilityCatalog;
  competitive_radar: MemoryCompetitiveRadar;
  competitive_eval: CompetitiveEvalV2Report;
  context_pack: ContextPack;
  extraction_status: MemoryExtractionStatus;
  governance: MemoryGovernanceReport;
  handoff: MemoryHandoffReport;
  work_frontier: WorkFrontierReport;
  learning_debt: LearningDebtReport;
  memory_decay: MemoryDecayReport;
  memory_health: MemoryHealthReport;
  memory_layers: MemoryLayersReport;
  routing_guide: MemoryRoutingGuide;
  agent_integration_status: MemoryAgentIntegrationStatus;
  session_timeline: SessionTimeline;
  reasoning_replay: ReasoningReplayReport;
  federation: FederationReport;
}

export interface MemoryWorkbenchArtifact {
  contract: {
    name: "memory.workbench.viewer";
    version: "memory.workbench.viewer.v1";
    consumes: [
      "memory.operational_dashboard.v1",
      "memory.capability_catalog.v1",
      "memory.competitive_radar.v1",
      "memory.competitive_eval.v2",
      "memory.context_pack.v1",
      "memory.extraction_status.v1",
      "memory.governance.v1",
      "memory.handoff.v1",
      "memory.work_frontier.v1",
      "memory.learning_debt.v1",
      "memory.decay_plan.v1",
      "memory.health.v1",
      "memory.memory_layers.v1",
      "memory.routing_guide.v1",
      "memory.agent_integration_status.v1",
      "memory.session_timeline.v1",
      "memory.reasoning_replay.v1",
      "memory.federation.v1",
    ];
  };
  workbench: MemoryWorkbench;
  html: string;
}

export async function buildMemoryWorkbench(
  store: MemoryStore,
  rootDir: string,
  opts: { staleDays?: number; sessionId?: string; limit?: number; now?: number } = {},
): Promise<MemoryWorkbench> {
  const [
    dashboard,
    capabilities,
    competitiveRadar,
    competitiveEval,
    contextPack,
    extractionStatus,
    governance,
    handoff,
    workFrontier,
    learningDebt,
    memoryDecay,
    memoryHealth,
    memoryLayers,
    routingGuide,
    agentIntegrationStatus,
    sessionTimeline,
    reasoningReplay,
    federation,
  ] = await Promise.all([
    buildMemoryOperationalDashboard(store, rootDir, {
      staleDays: opts.staleDays,
      now: opts.now,
    }),
    buildMemoryCapabilityCatalog(store, rootDir, { now: opts.now }),
    buildMemoryCompetitiveRadar(store, rootDir, { now: opts.now }),
    evaluateCompetitiveEvalV2({ now: opts.now }),
    buildContextPack(store, "memory", {
      budgetChars: 2_500,
      limit: 8,
      depth: 1,
      now: opts.now,
    }),
    buildMemoryExtractionStatus(store, rootDir, { now: opts.now }),
    buildMemoryGovernanceReport(store, { now: opts.now }),
    buildMemoryHandoff(store, { limit: 12, now: opts.now }),
    buildWorkFrontier(store, { limit: 12, now: opts.now }),
    buildLearningDebtReport(store, {
      now: opts.now,
      staleDays: opts.staleDays,
      rollups: await safeSkillRollups(store),
      skillTelemetryEnabled: true,
    }),
    buildMemoryDecayReport(store, { stale_days: opts.staleDays, limit: 12, now: opts.now }),
    buildMemoryHealthReport(store, { stale_days: opts.staleDays }),
    buildMemoryLayersReport(store, { now: opts.now }),
    Promise.resolve(buildMemoryRoutingGuide({ agent: "codex" })),
    buildMemoryAgentIntegrationStatus(rootDir, { now: opts.now }),
    buildSessionTimeline(store, {
      sessionId: opts.sessionId,
      limit: opts.limit,
      now: opts.now,
    }),
    buildReasoningReplay(store, "memory", { limit: 5, now: opts.now }),
    buildFederationReport(rootDir, "memory", { limit: 5, now: opts.now }),
  ]);
  return {
    schema_version: "memory.workbench.v1",
    read_only: true,
    root: rootDir,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    dashboard,
    capabilities,
    competitive_radar: competitiveRadar,
    competitive_eval: competitiveEval,
    context_pack: contextPack,
    extraction_status: extractionStatus,
    governance,
    handoff,
    work_frontier: workFrontier,
    learning_debt: learningDebt,
    memory_decay: memoryDecay,
    memory_health: memoryHealth,
    memory_layers: memoryLayers,
    routing_guide: routingGuide,
    agent_integration_status: agentIntegrationStatus,
    session_timeline: sessionTimeline,
    reasoning_replay: reasoningReplay,
    federation,
  };
}

export function buildMemoryWorkbenchArtifact(
  workbench: MemoryWorkbench,
): MemoryWorkbenchArtifact {
  return {
    contract: {
      name: "memory.workbench.viewer",
      version: "memory.workbench.viewer.v1",
      consumes: [
        "memory.operational_dashboard.v1",
        "memory.capability_catalog.v1",
        "memory.competitive_radar.v1",
        "memory.competitive_eval.v2",
        "memory.context_pack.v1",
        "memory.extraction_status.v1",
        "memory.governance.v1",
        "memory.handoff.v1",
        "memory.work_frontier.v1",
        "memory.learning_debt.v1",
        "memory.decay_plan.v1",
        "memory.health.v1",
        "memory.memory_layers.v1",
        "memory.routing_guide.v1",
        "memory.agent_integration_status.v1",
        "memory.session_timeline.v1",
        "memory.reasoning_replay.v1",
        "memory.federation.v1",
      ],
    },
    workbench,
    html: renderWorkbench(workbench),
  };
}

function renderWorkbench(workbench: MemoryWorkbench): string {
  const stateClass =
    workbench.dashboard.state === "ready"
      ? "ok"
      : workbench.dashboard.state === "degraded"
        ? "bad"
        : "warn";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory workbench</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f2;
      --ink: #202421;
      --muted: #657066;
      --line: #d6dbd2;
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
    h1 { font-size: 28px; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 13px; margin-bottom: 4px; overflow-wrap: anywhere; }
    .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--panel);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .ok { color: var(--accent); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(10, minmax(0, 1fr));
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
    .layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(340px, .8fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    .capability {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      white-space: nowrap;
    }
    .timeline {
      display: grid;
      grid-template-columns: 155px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }
    .search-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
      margin-top: 10px;
    }
    input, button, .button-link {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      min-width: 0;
    }
    input { padding: 9px 10px; }
    button, .button-link {
      padding: 9px 12px;
      font-weight: 700;
      cursor: pointer;
    }
    .button-link {
      display: inline-block;
      margin-top: 8px;
      text-decoration: none;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    .button-link:hover { border-color: var(--accent); color: var(--accent); }
    .result {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 8px;
      align-items: start;
    }
    .doc-body {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fbfcf8;
      padding: 10px;
      max-height: 260px;
      overflow: auto;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 920px) {
      header, .metrics, .layout, .timeline, .capability, .search-row, .result { grid-template-columns: 1fr; }
      .badge, .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Workbench</h1>
        <p class="meta">${escapeHtml(workbench.root)} - ${escapeHtml(workbench.generated_at)}</p>
        <p class="meta">Read-only RedDB-backed overview for operations, capabilities, competitive posture, and session replay evidence.</p>
      </div>
      <div class="badge ${stateClass}">${escapeHtml(workbench.dashboard.state)}</div>
    </header>
    <div class="metrics">
      ${metric("Nodes", workbench.dashboard.stats.nodes)}
      ${metric("Docs", `${workbench.dashboard.docs.grounded}/${workbench.dashboard.docs.total}`)}
      ${metric("Vectors", `${workbench.dashboard.vector.ready}/${workbench.dashboard.vector.total}`)}
      ${metric("Capabilities", `${workbench.capabilities.summary.ready}/${workbench.capabilities.summary.total}`)}
      ${metric("Context", workbench.context_pack.entries.length)}
      ${metric("Handoff", workbench.handoff.summary.returned_items)}
      ${metric("Frontier", `${workbench.work_frontier.summary.ready}/${workbench.work_frontier.summary.blocked}`)}
      ${metric("Governance", workbench.governance.status)}
      ${metric("Health", workbench.memory_health.state)}
      ${metric("Decay", `${workbench.memory_decay.summary.review}/${workbench.memory_decay.summary.deprecate}`)}
      ${metric("Debt", debtTotal(workbench.learning_debt))}
      ${metric("Layers", `${workbench.memory_layers.summary.ready_layers}/${workbench.memory_layers.summary.total_layers}`)}
      ${metric("Routing", workbench.routing_guide.integration.transports.length)}
      ${metric("Agents", `${workbench.agent_integration_status.summary.ready}/${workbench.agent_integration_status.summary.agents}`)}
      ${metric("Eval", `${workbench.competitive_eval.composite.score}/${workbench.competitive_eval.composite.maxScore}`)}
      ${metric("Radar", workbench.competitive_radar.summary.competitors)}
      ${metric("Timeline", workbench.session_timeline.summary.events)}
    </div>
    <div class="layout">
      <div class="stack">
        ${summarySection(workbench)}
        ${layersSection(workbench)}
        ${capabilitiesSection(workbench)}
        ${learningDebtSection(workbench)}
        ${competitiveEvalSection(workbench)}
        ${competitiveRadarSection(workbench)}
      </div>
      <div class="stack">
        ${searchConsoleSection()}
        ${contextPackSection(workbench)}
        ${docsExplorerSection()}
        ${handoffSection(workbench)}
        ${workFrontierSection(workbench)}
        ${routingGuideSection(workbench)}
        ${agentIntegrationStatusSection(workbench)}
        ${pathExplorerSection()}
        ${onboardingMapSection()}
        ${communitiesSection()}
        ${vectorDiagnosticsSection(workbench)}
        ${governanceSection(workbench)}
        ${decaySection(workbench)}
        ${memoryHealthSection(workbench)}
        ${extractionStatusSection(workbench)}
        ${hookDiagnosticsSection(workbench)}
        ${timelineSection(workbench)}
        ${reasoningReplaySection(workbench)}
        ${federationStatusSection(workbench)}
        ${actionsSection(workbench)}
      </div>
    </div>
    <script id="memory-workbench-data" type="application/json">${jsonForScript(workbench)}</script>
    <script>${searchConsoleScript()}</script>
    <script>${contextPackScript()}</script>
    <script>${docsExplorerScript()}</script>
    <script>${docsCoverageScript()}</script>
    <script>${docsReferenceGraphScript()}</script>
    <script>${assetInventoryScript()}</script>
    <script>${handoffScript()}</script>
    <script>${workFrontierScript()}</script>
    <script>${routingGuideScript()}</script>
    <script>${agentIntegrationStatusScript()}</script>
    <script>${pathExplorerScript()}</script>
    <script>${onboardingMapScript()}</script>
    <script>${communitiesScript()}</script>
    <script>${vectorDiagnosticsScript()}</script>
    <script>${governanceScript()}</script>
    <script>${decayScript()}</script>
    <script>${memoryHealthScript()}</script>
    <script>${extractionStatusScript()}</script>
    <script>${learningDebtScript()}</script>
    <script>${hookDiagnosticsScript()}</script>
    <script>${layersScript()}</script>
  </main>
</body>
</html>`;
}

function competitiveRadarSection(workbench: MemoryWorkbench): string {
  const competitors = workbench.competitive_radar.competitors;
  return `<section>
    <h2>Competitive Radar</h2>
    <p class="meta">${escapeHtml(workbench.competitive_radar.note)}</p>
    <ul>${competitors.map((competitor) => `<li class="capability"><div><h3>${escapeHtml(competitor.repository)}</h3><p class="meta">${competitor.relevant_capabilities} relevant capability signal(s), ${competitor.gaps.length} gap(s)</p></div><span class="pill ${statusClass(competitor.posture)}">${escapeHtml(competitor.posture)} ${competitor.score.toFixed(3)}</span></li>`).join("")}</ul>
  </section>`;
}

function competitiveEvalSection(workbench: MemoryWorkbench): string {
  const report = workbench.competitive_eval;
  return `<section>
    <h2>Competitive Eval</h2>
    <p class="meta">Executable claim guard over checked fixtures and opt-in live baseline slots.</p>
    <ul>
      <li><strong>${report.composite.score}/${report.composite.maxScore} ${escapeHtml(report.composite.status)}</strong><p class="meta">${report.dimensions.length} dimension(s), claim guards ${escapeHtml(report.claimGuards.status)}</p></li>
      <li><strong>${escapeHtml(report.fixture.name)}</strong><p class="meta">${report.fixture.nodes} node(s), ${report.fixture.edges} edge(s), live services ${escapeHtml(report.liveServices)}</p></li>
    </ul>
    <a class="button-link" href="/competitive-eval">Open Competitive Eval</a>
  </section>`;
}

function metric(label: string, value: number | string): string {
  return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

function summarySection(workbench: MemoryWorkbench): string {
  const d = workbench.dashboard;
  return `<section>
    <h2>Operational Summary</h2>
    <ul>
      <li><strong>Graph</strong><p class="meta">${d.stats.nodes} node(s), ${d.stats.edges} edge(s), ${d.stats.docs} doc(s)</p></li>
      <li><strong>Documents</strong><p class="meta">${d.docs.grounded}/${d.docs.total} grounded, ${d.docs.with_references} with references</p></li>
      <li><strong>Vectors</strong><p class="meta">${escapeHtml(d.vector.overall)}: ${d.vector.ready}/${d.vector.total} ready, ${d.vector.failed} failed</p></li>
      <li><strong>Hooks</strong><p class="meta">${escapeHtml(d.hooks.mode)}, ${d.hooks.enabled_events}/${d.hooks.total_events} enabled, ${d.hooks.gaps} gap(s)</p></li>
      <li><strong>Extraction</strong><p class="meta">${d.extraction.inferred_available ? "inferred provider available" : "deterministic only"}, ${d.extraction.inferred_facts} inferred fact(s)</p></li>
    </ul>
  </section>`;
}

function capabilitiesSection(workbench: MemoryWorkbench): string {
  const capabilities = workbench.capabilities.capabilities.slice(0, 12);
  return `<section>
    <h2>Capabilities</h2>
    <ul>${capabilities.map((item) => `<li class="capability"><div><h3>${escapeHtml(item.title)}</h3><p class="meta">${escapeHtml(item.category)} - ${escapeHtml(item.notes[0] ?? "")}</p></div><span class="pill ${statusClass(item.status)}">${escapeHtml(item.status)}</span></li>`).join("")}</ul>
  </section>`;
}

function layersSection(workbench: MemoryWorkbench): string {
  const layers = workbench.memory_layers.layers;
  return `<section>
    <h2>Memory Layers</h2>
    <p class="meta">Shows short-term, long-term, reasoning, docs/code, and vector readiness from <code>memory.memory_layers.v1</code>.</p>
    <ul id="memory-layers-results">${layers.map((layer) => `<li class="capability"><div><h3>${escapeHtml(layer.title)}</h3><p class="meta">${Object.entries(layer.counts).slice(0, 4).map(([key, value]) => `${escapeHtml(key)}=${escapeHtml(String(value))}`).join(", ")}</p></div><span class="pill ${statusClass(layer.status)}">${escapeHtml(layer.status)}</span></li>`).join("")}</ul>
    <button id="memory-layers-refresh" type="button">Refresh Layers</button>
    <p class="meta"><a href="/layers">Open Memory Layers</a></p>
    <p id="memory-layers-status" class="meta">${workbench.memory_layers.summary.ready_layers}/${workbench.memory_layers.summary.total_layers} layer(s) ready.</p>
  </section>`;
}

function searchConsoleSection(): string {
  return `<section>
    <h2>Search Console</h2>
    <p class="meta">Runs read-only smart search through <code>/api/search</code> when this Workbench is served by <code>memory serve</code>.</p>
    <form id="memory-search-form" class="search-row" action="/api/search" method="get">
      <input id="memory-search-query" name="query" type="search" placeholder="Search Memory evidence" autocomplete="off">
      <button type="submit">Search</button>
    </form>
    <a id="memory-smart-search-link" class="button-link" href="/search?query=memory">Open Smart Search Viewer</a>
    <p id="memory-search-status" class="meta">Ready.</p>
    <ul id="memory-search-summary"></ul>
    <ul id="memory-search-results"></ul>
    <ul id="memory-search-actions"></ul>
  </section>`;
}

/** Confidence-overlay badge (issue #167). Renders a small chip with the
 *  composed [0,1] confidence; returns empty string when no score is present. */
function confidenceBadge(score: number | undefined): string {
  if (score == null || !Number.isFinite(score)) return "";
  const cls = score >= 0.7 ? "ok" : score >= 0.4 ? "warn" : "bad";
  return ` <span class="pill ${cls}" data-confidence="${score.toFixed(3)}" title="Composed confidence (memory.confidence.v1)">conf ${score.toFixed(2)}</span>`;
}

function contextPackSection(workbench: MemoryWorkbench): string {
  const pack = workbench.context_pack;
  return `<section>
    <h2>Context Pack</h2>
    <p class="meta">Builds budgeted, cited agent context through <code>/api/context-pack</code>.</p>
    <form id="memory-context-pack-form" class="search-row" action="/api/context-pack" method="get">
      <input id="memory-context-pack-goal" name="goal" type="search" placeholder="Context goal" autocomplete="off" value="${escapeHtml(pack.goal)}">
      <button type="submit">Build Pack</button>
    </form>
    <a id="memory-context-pack-link" class="button-link" href="/context-pack?goal=${encodeURIComponent(pack.goal)}">Open Context Pack</a>
    <p id="memory-context-pack-status" class="meta">${pack.entries.length} context item(s), status ${escapeHtml(pack.status)}.</p>
    <ul id="memory-context-pack-results">${pack.entries.slice(0, 4).map((entry) => `<li><strong>${escapeHtml(entry.title)}</strong><p class="meta">${escapeHtml(entry.section)} - <code>${escapeHtml(entry.citation.urn)}</code>${confidenceBadge(entry.confidence_score)}</p></li>`).join("")}</ul>
    <pre id="memory-context-pack-markdown" class="doc-body">${escapeHtml(pack.markdown)}</pre>
  </section>`;
}

function docsExplorerSection(): string {
  return `<section>
    <h2>Docs Explorer</h2>
    <p class="meta">Searches ingested <code>memory_docs</code>, reads selected chunks, and inspects graph/vector coverage through read-only HTTP contracts.</p>
    <form id="memory-docs-form" class="search-row" action="/api/docs/search" method="get">
      <input id="memory-docs-query" name="query" type="search" placeholder="Search indexed docs" autocomplete="off">
      <button type="submit">Find Docs</button>
    </form>
    <a id="memory-docs-search-link" class="button-link" href="/docs/search?query=memory">Open Search Viewer</a>
    <button id="memory-docs-brief-button" type="button">Generate Brief</button>
    <a id="memory-docs-brief-link" class="button-link" href="/docs/brief?query=memory">Open Brief Viewer</a>
    <a id="memory-docs-bundle-link" class="button-link" href="/docs/bundle?query=memory">Open Bundle Viewer</a>
    <p id="memory-docs-status" class="meta">Ready.</p>
    <ul id="memory-docs-results"></ul>
    <pre id="memory-docs-body" class="doc-body">Select a doc result to read its indexed chunk.</pre>
    <pre id="memory-docs-evidence-pack" class="doc-body">Select a doc result to generate an evidence pack.</pre>
    <ul id="memory-docs-related-results"></ul>
    <form id="memory-docs-backlinks-form" class="search-row" action="/api/docs/backlinks" method="get">
      <input id="memory-docs-backlinks-query" name="query" type="search" placeholder="Find docs referencing label/title/rid" autocomplete="off">
      <button type="submit">Find Backlinks</button>
    </form>
    <p id="memory-docs-backlinks-status" class="meta">Backlinks: served Workbench can load <code>/api/docs/backlinks</code>.</p>
    <ul id="memory-docs-backlinks-results"></ul>
    <button id="memory-docs-coverage-refresh" type="button">Refresh Coverage</button>
    <p id="memory-docs-coverage-status" class="meta">Coverage: ${workbenchCoveragePlaceholder()}</p>
    <ul id="memory-docs-coverage-results"></ul>
    <button id="memory-docs-reference-graph-refresh" type="button">Refresh Reference Graph</button>
    <a class="button-link" href="/docs/reference-graph">Open Reference Graph</a>
    <p id="memory-docs-reference-graph-status" class="meta">Graph: served Workbench can load <code>/api/docs/reference-graph</code>.</p>
    <ul id="memory-docs-reference-graph-results"></ul>
    <button id="memory-assets-refresh" type="button">Refresh Assets</button>
    <a id="memory-assets-link" class="button-link" href="/assets">Open Asset Inventory</a>
    <p id="memory-assets-status" class="meta">Assets: served Workbench can load <code>/api/assets</code>.</p>
    <ul id="memory-assets-results"></ul>
  </section>`;
}

function workbenchCoveragePlaceholder(): string {
  return "served Workbench can load /api/docs/coverage.";
}

function pathExplorerSection(): string {
  return `<section>
    <h2>Graph Path Explorer</h2>
    <p class="meta">Explains directed graph paths through <code>/api/path-explain</code> without mutating Memory.</p>
    <form id="memory-path-form" class="search-row" action="/api/path-explain" method="get">
      <input id="memory-path-from" name="from" type="search" placeholder="From label or title" autocomplete="off">
      <input id="memory-path-to" name="to" type="search" placeholder="To label or title" autocomplete="off">
      <button type="submit">Explain</button>
    </form>
    <p id="memory-path-status" class="meta">Ready.</p>
    <ul id="memory-path-results"></ul>
  </section>`;
}

function handoffSection(workbench: MemoryWorkbench): string {
  const handoff = workbench.handoff;
  return `<section>
    <h2>Agent Handoff</h2>
    <p class="meta">Builds a cross-agent continuation brief through <code>/api/handoff</code> without reading raw transcripts.</p>
    <form id="memory-handoff-form" class="search-row" action="/api/handoff" method="get">
      <input id="memory-handoff-focus" name="focus" type="search" placeholder="Optional handoff focus" autocomplete="off">
      <button type="submit">Build Handoff</button>
    </form>
    <a id="memory-handoff-link" class="button-link" href="/handoff">Open Handoff</a>
    <p id="memory-handoff-status" class="meta">${handoff.summary.returned_items} handoff item(s), status ${escapeHtml(handoff.status)}.</p>
    <ul id="memory-handoff-results">${handoff.sections.slice(0, 3).map((section) => `<li><strong>${escapeHtml(section.title)}</strong><p class="meta">${section.items.length} item(s)</p></li>`).join("")}</ul>
    <pre id="memory-handoff-markdown" class="doc-body">${escapeHtml(handoff.markdown)}</pre>
  </section>`;
}

function workFrontierSection(workbench: MemoryWorkbench): string {
  const frontier = workbench.work_frontier;
  return `<section>
    <h2>Work Frontier</h2>
    <p class="meta">Ranks remembered task, issue, goal, and PRD evidence through <code>/api/frontier</code> without mutating work state.</p>
    <form id="memory-frontier-form" class="search-row" action="/api/frontier" method="get">
      <input id="memory-frontier-focus" name="focus" type="search" placeholder="Optional work focus" autocomplete="off">
      <button type="submit">Refresh Frontier</button>
    </form>
    <a id="memory-frontier-link" class="button-link" href="/frontier">Open Frontier</a>
    <p id="memory-frontier-status" class="meta">${frontier.summary.ready} ready, ${frontier.summary.blocked} blocked, status ${escapeHtml(frontier.status)}.</p>
    <ul id="memory-frontier-results">${frontier.ready.slice(0, 4).map((item) => `<li><strong>${escapeHtml(item.title)}</strong><p class="meta"><code>${escapeHtml(item.citation)}</code> - priority ${item.priority.toFixed(2)}</p></li>`).join("")}</ul>
    <pre id="memory-frontier-markdown" class="doc-body">${escapeHtml(frontier.markdown)}</pre>
  </section>`;
}

function routingGuideSection(workbench: MemoryWorkbench): string {
  const guide = workbench.routing_guide;
  return `<section>
    <h2>Agent Routing</h2>
    <p class="meta">Builds agent-specific Memory adoption guidance through <code>/api/routing-guide</code> without editing rule files.</p>
    <form id="memory-routing-guide-form" class="search-row" action="/api/routing-guide" method="get">
      <select id="memory-routing-guide-agent" name="agent">
        ${guide.supportedAgents.map((agent) => `<option value="${escapeHtml(agent)}"${agent === guide.agent ? " selected" : ""}>${escapeHtml(agent)}</option>`).join("")}
      </select>
      <button type="submit">Refresh Routing</button>
    </form>
    <a id="memory-routing-guide-link" class="button-link" href="/routing-guide?agent=${escapeHtml(guide.agent)}">Open Routing Guide</a>
    <p id="memory-routing-guide-status" class="meta">${escapeHtml(guide.integration.displayName)}: ${guide.integration.transports.join(", ")}.</p>
    <ul id="memory-routing-guide-results">
      <li><strong>Target files</strong><p class="meta">${escapeHtml(guide.targetFiles.join(", "))}</p></li>
      <li><strong>MCP tools</strong><p class="meta">${guide.mcpTools.length} tool(s), ${guide.rules.length} routing rule(s)</p></li>
    </ul>
  </section>`;
}

function agentIntegrationStatusSection(workbench: MemoryWorkbench): string {
  const report = workbench.agent_integration_status;
  return `<section>
    <h2>Agent Integration Status</h2>
    <p class="meta">Audits agent rule files, Memory routing snippets, and hook coverage through <code>/api/integration-status</code>.</p>
    <button id="memory-agent-integration-refresh" type="button">Refresh Integrations</button>
    <a class="button-link" href="/integration-status">Open Integration Status</a>
    <p id="memory-agent-integration-status" class="meta">${report.summary.ready}/${report.summary.agents} agent integration(s) ready.</p>
    <ul id="memory-agent-integration-results">
      ${report.agents.slice(0, 4).map((agent) => `<li><strong>${escapeHtml(agent.display_name)}</strong><p class="meta">${escapeHtml(agent.state)} - ${agent.target_files.map((file) => escapeHtml(file.path)).join(", ")}</p></li>`).join("")}
    </ul>
  </section>`;
}

function communitiesSection(): string {
  return `<section>
    <h2>Graph Communities</h2>
    <p class="meta">Inspects RedDB native graph community analytics through <code>/api/communities</code>.</p>
    <button id="memory-communities-refresh" type="button">Refresh Communities</button>
    <a class="button-link" href="/communities">Open Communities</a>
    <p id="memory-communities-status" class="meta">Ready.</p>
    <ul id="memory-communities-results"></ul>
  </section>`;
}

function onboardingMapSection(): string {
  return `<section>
    <h2>Onboarding Map</h2>
    <p class="meta">Reads map-first Memory graph orientation through <code>/api/onboarding-map</code>.</p>
    <button id="memory-onboarding-refresh" type="button">Refresh Onboarding</button>
    <a class="button-link" href="/onboarding-map">Open Onboarding Map</a>
    <p id="memory-onboarding-status" class="meta">Ready.</p>
    <ul id="memory-onboarding-results"></ul>
  </section>`;
}

function vectorDiagnosticsSection(workbench: MemoryWorkbench): string {
  return `<section>
    <h2>Vector Diagnostics</h2>
    <p class="meta">Inspects vector projection status through <code>/api/vector/status</code> and runs diagnostic vector search through <code>/api/vector/search</code>.</p>
    <ul>
      <li><strong>${escapeHtml(workbench.dashboard.vector.overall)}</strong><p class="meta">${workbench.dashboard.vector.ready}/${workbench.dashboard.vector.total} projected vector item(s) ready, ${workbench.dashboard.vector.failed} failed, ${workbench.dashboard.vector.unavailable} unavailable</p></li>
    </ul>
    <form id="memory-vector-form" class="search-row" action="/api/vector/search" method="get">
      <input id="memory-vector-query" name="query" type="search" placeholder="Search vector projection" autocomplete="off">
      <button type="submit">Vector Search</button>
    </form>
    <a class="button-link" href="/vector/status">Open Vector Status</a>
    <p id="memory-vector-status" class="meta">Ready.</p>
    <ul id="memory-vector-results"></ul>
  </section>`;
}

function governanceSection(workbench: MemoryWorkbench): string {
  const governance = workbench.governance;
  return `<section>
    <h2>Governance</h2>
    <p class="meta">Reads provenance, privacy, lint, contradiction, and supersession evidence through <code>/api/governance</code>.</p>
    <ul id="memory-governance-results">
      <li><strong>${escapeHtml(governance.status)}</strong><p class="meta">${governance.summary.nodes_with_provenance}/${governance.summary.total_nodes} with provenance, ${governance.summary.missing_provenance} missing</p></li>
      <li><strong>Privacy and lint</strong><p class="meta">${governance.summary.privacy_findings} privacy finding(s), ${governance.summary.lint_findings} lint finding(s)</p></li>
      <li><strong>Contradictions</strong><p class="meta">${governance.summary.unresolved_contradictions} unresolved, ${governance.summary.superseded_nodes} superseded node(s)</p></li>
    </ul>
    <button id="memory-governance-refresh" type="button">Refresh Governance</button>
    <a class="button-link" href="/governance">Open Governance</a>
    <p id="memory-governance-status" class="meta">${escapeHtml(governance.recommended_next_actions[0] ?? "Ready.")}</p>
  </section>`;
}

function decaySection(workbench: MemoryWorkbench): string {
  const decay = workbench.memory_decay;
  return `<section>
    <h2>Memory Decay</h2>
    <p class="meta">Reads retention posture through <code>/api/decay</code> and classifies Memory evidence without pruning or rewriting it.</p>
    <ul id="memory-decay-results">
      <li><strong>${escapeHtml(decay.status)}</strong><p class="meta">${decay.summary.keep} keep, ${decay.summary.review} review, ${decay.summary.deprecate} deprecate, ${decay.summary.expire} expire</p></li>
      <li><strong>Policy</strong><p class="meta">${decay.policy.stale_days}d stale, ${decay.policy.deprecate_days}d deprecate, pinned ${decay.policy.pinned_importance_threshold}</p></li>
    </ul>
    <button id="memory-decay-refresh" type="button">Refresh Decay</button>
    <a class="button-link" href="/decay">Open Decay</a>
    <p id="memory-decay-status" class="meta">${escapeHtml(decay.recommended_next_actions[0] ?? "Ready.")}</p>
  </section>`;
}

function memoryHealthSection(workbench: MemoryWorkbench): string {
  const health = workbench.memory_health;
  return `<section>
    <h2>Memory Health</h2>
    <p class="meta">Reads graph, vector, stale evidence, and Skill telemetry health through <code>/api/memory/health</code>.</p>
    <ul id="memory-health-results">
      <li><strong>${escapeHtml(health.state)}</strong><p class="meta">${health.stats.nodes} node(s), ${health.stats.edges} edge(s), ${health.stale.stale}/${health.stale.total} stale</p></li>
      <li><strong>${escapeHtml(health.vector.overall)}</strong><p class="meta">${health.vector.ready}/${health.vector.total} vector item(s) ready, ${health.vector.failed} failed</p></li>
      <li><strong>${escapeHtml(health.skill_telemetry.status)}</strong><p class="meta">${health.skill_telemetry.rollups} Skill telemetry rollup(s)</p></li>
    </ul>
    <button id="memory-health-refresh" type="button">Refresh Health</button>
    <a class="button-link" href="/memory/health">Open Memory Health</a>
    <p id="memory-health-status" class="meta">${escapeHtml(health.recommended_next_actions[0] ?? "Ready.")}</p>
  </section>`;
}

function extractionStatusSection(workbench: MemoryWorkbench): string {
  const extraction = workbench.extraction_status;
  const deterministic = Object.entries(extraction.deterministic)
    .filter(([, ready]) => ready)
    .map(([key]) => key.replaceAll("_", " "));
  return `<section>
    <h2>Extraction Status</h2>
    <p class="meta">Reads deterministic and inferred extraction readiness through <code>/api/extraction/status</code>.</p>
    <ul id="memory-extraction-results">
      <li><strong>${extraction.inferred.available ? "provider available" : "local structured fallback"}</strong><p class="meta">${extraction.inferred.facts} inferred fact(s), Stop hook ${extraction.inferred.hook_stop_enabled ? "enabled" : "disabled"}</p></li>
      <li><strong>Deterministic extractors</strong><p class="meta">${escapeHtml(deterministic.join(", "))}</p></li>
    </ul>
    <button id="memory-extraction-refresh" type="button">Refresh Extraction</button>
    <a class="button-link" href="/extraction/status">Open Extraction Status</a>
    <p id="memory-extraction-status" class="meta">${escapeHtml(extraction.recommended_next_actions[0] ?? "Ready.")}</p>
  </section>`;
}

function learningDebtSection(workbench: MemoryWorkbench): string {
  const debt = workbench.learning_debt;
  return `<section>
    <h2>Learning Debt</h2>
    <p class="meta">Reads repeated failures, stale guidance, validation gaps, and Skill telemetry gaps through <code>/api/learning-debt</code>.</p>
    <ul id="memory-learning-debt-results">
      <li><strong>${escapeHtml(debt.status)}</strong><p class="meta">${debtTotal(debt)} debt signal(s), ${debt.summary.skillTelemetryGaps} telemetry gap(s)</p></li>
      <li><strong>Validation gaps</strong><p class="meta">${debt.summary.missingValidationEvidence} missing validation evidence item(s)</p></li>
    </ul>
    <button id="memory-learning-debt-refresh" type="button">Refresh Learning Debt</button>
    <a class="button-link" href="/learning-debt">Open Learning Debt</a>
    <p id="memory-learning-debt-status" class="meta">${escapeHtml(debt.status)}</p>
  </section>`;
}

function hookDiagnosticsSection(workbench: MemoryWorkbench): string {
  const hooks = workbench.dashboard.hooks;
  return `<section>
    <h2>Hook Diagnostics</h2>
    <p class="meta">Inspects lifecycle hook coverage through <code>/api/hooks/coverage</code> and recent event replay through <code>/api/session/timeline</code>.</p>
    <ul>
      <li><strong>${escapeHtml(hooks.mode)}</strong><p class="meta">${hooks.enabled_events}/${hooks.total_events} hook event(s) enabled, ${hooks.gaps} gap(s)</p></li>
    </ul>
    <form id="memory-hooks-form" class="search-row" action="/api/session/timeline" method="get">
      <input id="memory-hooks-session" name="session" type="search" placeholder="Optional session id" autocomplete="off">
      <button id="memory-hooks-refresh" type="submit">Refresh Hooks</button>
    </form>
    <a class="button-link" href="/hooks/coverage">Open Hook Coverage</a>
    <p id="memory-hooks-status" class="meta">Ready.</p>
    <ul id="memory-hooks-results"></ul>
  </section>`;
}

function timelineSection(workbench: MemoryWorkbench): string {
  const entries = workbench.session_timeline.entries.slice(-8).reverse();
  return `<section>
    <h2>Session Timeline</h2>
    ${
      entries.length === 0
        ? `<p class="empty">No session events available.</p>`
        : `<ul>${entries.map((entry) => `<li class="timeline"><p class="meta">${escapeHtml(entry.occurred_at)}</p><div><h3>${escapeHtml(entry.title)}</h3><p>${escapeHtml(entry.detail || "No detail.")}</p><p class="meta"><code>${escapeHtml(entry.session_id)}</code></p></div><span class="pill ${statusClass(entry.outcome)}">${escapeHtml(entry.outcome)}</span></li>`).join("")}</ul>`
    }
  </section>`;
}

function reasoningReplaySection(workbench: MemoryWorkbench): string {
  const replay = workbench.reasoning_replay;
  const items = replay.results;
  const gaps = replay.gaps;
  const gapsHtml =
    gaps.length === 0
      ? ""
      : `<h3>Gaps</h3><ul class="reasoning-gaps">${gaps
          .map((gap) => `<li>${escapeHtml(gap)}</li>`)
          .join("")}</ul>`;
  return `<section>
    <h2>Reasoning Replay</h2>
    <p class="meta">Similarity ranking over reasoning-tier attempt nodes, with AFK envelope outcome and learning-debt gaps.</p>
    ${
      items.length === 0
        ? `<p class="empty">No recent reasoning replays yet — run a few AFK attempts to populate this panel.</p>`
        : `<ul>${items
            .map(
              (item) =>
                `<li class="capability"><div><h3>${escapeHtml(item.attempt_id)}</h3><p class="meta">${escapeHtml(item.when)}</p><p>${escapeHtml(item.summary)}</p></div><span class="pill ${outcomeClass(item.outcome)}" data-outcome="${escapeHtml(item.outcome)}">${escapeHtml(item.outcome)}</span><span class="pill">${item.similarity.toFixed(4)}</span></li>`,
            )
            .join("")}</ul>`
    }
    ${gapsHtml}
  </section>`;
}

function federationStatusSection(workbench: MemoryWorkbench): string {
  const federation = workbench.federation;
  const roots = federation.roots;
  return `<section>
    <h2>Federation Status</h2>
    <p class="meta">Cross-root memory federation (issue #168). Reads <code>.red/memory/federation.yaml</code>; no privacy policy applied yet.</p>
    ${
      roots.length === 0
        ? `<p class="empty">No federation roots configured — add <code>.red/memory/federation.yaml</code> to enable cross-root reads.</p>`
        : `<ul>${roots
            .map(
              (root) =>
                `<li class="capability"><div><h3>${escapeHtml(root.origin_repo)}</h3><p class="meta">${escapeHtml(root.path)}</p></div><span class="pill ${root.status === "ok" ? "ok" : "warn"}">${escapeHtml(root.status)} - ${root.hits} hit(s)</span></li>`,
            )
            .join("")}</ul>`
    }
    <p class="meta">${federation.results.length} merged result(s) across ${federation.roots_queried} root(s).</p>
  </section>`;
}

function outcomeClass(outcome: string): string {
  if (outcome === "done") return "ok";
  if (outcome === "blocked") return "bad";
  if (outcome === "no-sentinel") return "warn";
  return "warn";
}

function actionsSection(workbench: MemoryWorkbench): string {
  const actions = [
    ...workbench.dashboard.recommended_next_actions,
    ...workbench.capabilities.recommended_next_actions,
    ...workbench.competitive_radar.recommended_next_actions,
    ...(workbench.learning_debt.status === "debt-found"
      ? ["inspect `memory learning-debt` before changing Skill guidance"]
      : []),
    ...workbench.memory_layers.recommended_next_actions,
    ...workbench.session_timeline.recommended_next_actions,
  ];
  const unique = [...new Set(actions)].slice(0, 12);
  return `<section>
    <h2>Next Actions</h2>
    ${
      unique.length === 0
        ? `<p class="empty">No next actions.</p>`
        : `<ul>${unique.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`
    }
  </section>`;
}

function debtTotal(report: LearningDebtReport): number {
  return (
    report.summary.repeatedFailurePatterns +
    report.summary.staleOrContradictedGuidance +
    report.summary.missingValidationEvidence +
    report.summary.skillTelemetryGaps
  );
}

async function safeSkillRollups(store: MemoryStore) {
  try {
    return await readSkillRollups(store);
  } catch {
    return [];
  }
}

function statusClass(status: string): string {
  if (status === "ready" || status === "succeeded") return "ok";
  if (status === "failed" || status === "degraded" || status === "gap") return "bad";
  return "warn";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll("</", "<\\/");
}

function searchConsoleScript(): string {
  return `(() => {
  const form = document.getElementById("memory-search-form");
  const input = document.getElementById("memory-search-query");
  const viewerLink = document.getElementById("memory-smart-search-link");
  const status = document.getElementById("memory-search-status");
  const summary = document.getElementById("memory-search-summary");
  const results = document.getElementById("memory-search-results");
  const actions = document.getElementById("memory-search-actions");
  if (!form || !input || !viewerLink || !status || !summary || !results || !actions) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(input.value || "").trim();
    viewerLink.setAttribute("href", "/search?query=" + encodeURIComponent(query || "memory"));
    summary.replaceChildren();
    results.replaceChildren();
    actions.replaceChildren();
    if (!query) {
      status.textContent = "Enter a query.";
      return;
    }
    status.textContent = "Searching...";
    try {
      const response = await fetch("/api/search?query=" + encodeURIComponent(query) + "&limit=5", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const body = await response.json();
      const hits = Array.isArray(body.top_results) ? body.top_results : [];
      const counts = body.summary || {};
      status.textContent = hits.length + " fused result(s).";
      const summaryItem = document.createElement("li");
      summaryItem.textContent =
        "recall=" + String(counts.recall_hits ?? 0) +
        " docs=" + String(counts.doc_hits ?? 0) +
        " assets=" + String(counts.asset_hits ?? 0) +
        " vectors=" + String(counts.vector_hits ?? 0) +
        " (" + String(counts.vector_status ?? "unknown") + ")";
      summary.append(summaryItem);
      for (const hit of hits) {
        const item = document.createElement("li");
        item.className = "result";
        const rank = document.createElement("span");
        rank.className = "pill";
        rank.textContent = "#" + String(hit.rank ?? "?");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(hit.title ?? hit.id ?? "Untitled result");
        const meta = document.createElement("p");
        meta.className = "meta";
        const ref = hit.ref || {};
        const refText = ref.path || ref.label || (ref.rid == null ? "" : "rid:" + String(ref.rid));
        meta.textContent = String(hit.kind ?? "result") + " - " + (Array.isArray(hit.sources) ? hit.sources.join("+") : "unknown") + (refText ? " - " + String(refText) : "");
        const excerpt = document.createElement("p");
        excerpt.textContent = String(hit.excerpt ?? "");
        content.append(title, meta, excerpt);
        item.append(rank, content);
        results.append(item);
      }
      const nextActions = Array.isArray(body.recommended_next_actions) ? body.recommended_next_actions : [];
      for (const action of nextActions) {
        const item = document.createElement("li");
        item.textContent = String(action);
        actions.append(item);
      }
    } catch (err) {
      status.textContent = "Search unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function docsExplorerScript(): string {
  return `(() => {
  const form = document.getElementById("memory-docs-form");
  const input = document.getElementById("memory-docs-query");
  const status = document.getElementById("memory-docs-status");
  const results = document.getElementById("memory-docs-results");
  const body = document.getElementById("memory-docs-body");
  const evidencePack = document.getElementById("memory-docs-evidence-pack");
  const relatedResults = document.getElementById("memory-docs-related-results");
  const searchLink = document.getElementById("memory-docs-search-link");
  const briefButton = document.getElementById("memory-docs-brief-button");
  const briefLink = document.getElementById("memory-docs-brief-link");
  const bundleLink = document.getElementById("memory-docs-bundle-link");
  const backlinksForm = document.getElementById("memory-docs-backlinks-form");
  const backlinksInput = document.getElementById("memory-docs-backlinks-query");
  const backlinksStatus = document.getElementById("memory-docs-backlinks-status");
  const backlinksResults = document.getElementById("memory-docs-backlinks-results");
  if (!form || !input || !status || !results || !body || !evidencePack || !relatedResults || !searchLink || !briefButton || !briefLink || !bundleLink || !backlinksForm || !backlinksInput || !backlinksStatus || !backlinksResults) return;
  async function readDoc(rid) {
    body.textContent = "Loading doc...";
    const response = await fetch("/api/docs/read?rid=" + encodeURIComponent(String(rid)) + "&max_bytes=8000", {
      headers: { "accept": "application/json" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const doc = await response.json();
    body.textContent = doc.found ? String(doc.body || "") : "Indexed doc not found.";
  }
  async function loadEvidencePack(rid) {
    evidencePack.textContent = "Loading evidence pack...";
    const response = await fetch("/api/docs/evidence-pack?rid=" + encodeURIComponent(String(rid)) + "&max_bytes=8000", {
      headers: { "accept": "application/json" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const pack = await response.json();
    evidencePack.textContent = pack.found ? String(pack.markdown || "") : "Evidence pack not found.";
  }
  async function loadRelated(rid) {
    relatedResults.replaceChildren();
    const response = await fetch("/api/docs/related?rid=" + encodeURIComponent(String(rid)), {
      headers: { "accept": "application/json" },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const report = await response.json();
    const refs = Array.isArray(report.references) ? report.references.slice(0, 5) : [];
    const docs = Array.isArray(report.related_docs) ? report.related_docs.slice(0, 5) : [];
    const summary = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = "Related docs";
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = refs.length + " reference(s) shown, " + docs.length + " related doc(s) shown.";
    summary.append(title, meta);
    relatedResults.append(summary);
    for (const ref of refs) {
      const item = document.createElement("li");
      item.textContent = "Reference: " + String(ref.title || ref.label || "Referenced node");
      relatedResults.append(item);
    }
    for (const doc of docs) {
      const item = document.createElement("li");
      item.textContent = "Related: " + String(doc.path || doc.title || "Doc") + " (" + String(doc.shared_references ?? 0) + " shared)";
      relatedResults.append(item);
    }
  }
  briefButton.addEventListener("click", async () => {
    const query = String(input.value || "").trim();
    if (!query) {
      evidencePack.textContent = "Enter a docs query before generating a brief.";
      return;
    }
    evidencePack.textContent = "Generating docs brief...";
    try {
      const response = await fetch("/api/docs/brief?query=" + encodeURIComponent(query) + "&limit=3&max_bytes=8000", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const brief = await response.json();
      evidencePack.textContent = String(brief.markdown || "");
    } catch (err) {
      evidencePack.textContent = "Docs brief unavailable here; open the Workbench through memory serve.";
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(input.value || "").trim();
    results.replaceChildren();
    if (!query) {
      status.textContent = "Enter a docs query.";
      return;
    }
    searchLink.setAttribute("href", "/docs/search?query=" + encodeURIComponent(query) + "&limit=10");
    briefLink.setAttribute("href", "/docs/brief?query=" + encodeURIComponent(query) + "&limit=3&max_bytes=8000");
    bundleLink.setAttribute("href", "/docs/bundle?query=" + encodeURIComponent(query) + "&limit=3&max_bytes=8000");
    status.textContent = "Searching docs...";
    try {
      const response = await fetch("/api/docs/search?query=" + encodeURIComponent(query) + "&limit=5", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const hits = Array.isArray(report.hits) ? report.hits : [];
      status.textContent = hits.length + " doc result(s).";
      for (const hit of hits) {
        const item = document.createElement("li");
        item.className = "result";
        const read = document.createElement("button");
        read.type = "button";
        read.textContent = "Read";
        read.addEventListener("click", () => {
          readDoc(hit.rid).catch(() => {
            body.textContent = "Doc read unavailable here; open the Workbench through memory serve.";
          });
        });
        const pack = document.createElement("button");
        pack.type = "button";
        pack.textContent = "Pack";
        pack.addEventListener("click", () => {
          loadEvidencePack(hit.rid).catch(() => {
            evidencePack.textContent = "Evidence pack unavailable here; open the Workbench through memory serve.";
          });
        });
        const packViewer = document.createElement("a");
        packViewer.className = "button-link";
        packViewer.textContent = "Pack Viewer";
        packViewer.href = "/docs/evidence-pack?rid=" + encodeURIComponent(String(hit.rid)) + "&max_bytes=8000";
        const related = document.createElement("button");
        related.type = "button";
        related.textContent = "Related";
        related.addEventListener("click", () => {
          loadRelated(hit.rid).catch(() => {
            relatedResults.replaceChildren();
            const item = document.createElement("li");
            item.textContent = "Related docs unavailable here; open the Workbench through memory serve.";
            relatedResults.append(item);
          });
        });
        const relatedViewer = document.createElement("a");
        relatedViewer.className = "button-link";
        relatedViewer.textContent = "Related Viewer";
        relatedViewer.href = "/docs/related?rid=" + encodeURIComponent(String(hit.rid));
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(hit.title || hit.path || "Untitled doc");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(hit.path || "") + " - score " + String(hit.score ?? "?");
        const excerpt = document.createElement("p");
        excerpt.textContent = String(hit.excerpt || "");
        content.append(title, meta, excerpt);
        const actions = document.createElement("div");
        actions.append(read, pack, packViewer, related, relatedViewer);
        item.append(actions, content);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Docs search unavailable here; open the Workbench through memory serve.";
    }
  });
  backlinksForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(backlinksInput.value || "").trim();
    backlinksResults.replaceChildren();
    if (!query) {
      backlinksStatus.textContent = "Enter a reference label, title, or rid.";
      return;
    }
    backlinksStatus.textContent = "Finding doc backlinks...";
    try {
      const key = /^[0-9]+$/.test(query) ? "rid" : "query";
      const response = await fetch("/api/docs/backlinks?" + key + "=" + encodeURIComponent(query), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const docs = Array.isArray(report.docs) ? report.docs.slice(0, 8) : [];
      const refs = Array.isArray(report.references) ? report.references.slice(0, 3) : [];
      backlinksStatus.textContent = String(refs.length) + " reference node(s), " + String(docs.length) + " doc backlink(s) shown.";
      for (const doc of docs) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(doc.title || doc.path || "Indexed doc");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(doc.path || "") + " - " + String(doc.matched_references ?? 0) + " matched reference(s)";
        item.append(title, meta);
        backlinksResults.append(item);
      }
      if (docs.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No indexed docs reference that node.";
        backlinksResults.append(item);
      }
    } catch (err) {
      backlinksStatus.textContent = "Doc backlinks unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function docsCoverageScript(): string {
  return `(() => {
  const button = document.getElementById("memory-docs-coverage-refresh");
  const status = document.getElementById("memory-docs-coverage-status");
  const results = document.getElementById("memory-docs-coverage-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing doc coverage...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/docs/coverage", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = String(report.grounded_docs ?? 0) + "/" + String(report.total_docs ?? 0) + " grounded, " + String(report.docs_with_references ?? 0) + " with references, vectors " + String(report.vector?.overall || "unknown") + ".";
      const docs = Array.isArray(report.docs) ? report.docs : [];
      const interesting = docs
        .filter((doc) => Number(doc.references?.count || 0) > 0 || doc.graph_status !== "grounded" || doc.vector_status !== "ready")
        .slice(0, 8);
      for (const doc of interesting) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(doc.title || doc.path || "Indexed doc");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(doc.path || "") + " - " + String(doc.graph_status || "unknown") + ", refs " + String(doc.references?.count ?? 0) + ", vector " + String(doc.vector_status || "unknown");
        item.append(title, meta);
        results.append(item);
      }
      if (interesting.length === 0) {
        const item = document.createElement("li");
        item.textContent = "All indexed docs are grounded with ready vectors; no reference-bearing docs to highlight.";
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Doc coverage unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function handoffScript(): string {
  return `(() => {
  const form = document.getElementById("memory-handoff-form");
  const input = document.getElementById("memory-handoff-focus");
  const viewerLink = document.getElementById("memory-handoff-link");
  const status = document.getElementById("memory-handoff-status");
  const results = document.getElementById("memory-handoff-results");
  const markdown = document.getElementById("memory-handoff-markdown");
  if (!form || !input || !viewerLink || !status || !results || !markdown) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const focus = String(input.value || "").trim();
    viewerLink.setAttribute("href", focus ? "/handoff?focus=" + encodeURIComponent(focus) : "/handoff");
    status.textContent = "Building handoff...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/handoff" + (focus ? "?focus=" + encodeURIComponent(focus) + "&limit=12" : "?limit=12"), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      status.textContent = String(summary.returned_items ?? 0) + " handoff item(s), status " + String(report.status || "unknown") + ".";
      const sections = Array.isArray(report.sections) ? report.sections : [];
      for (const section of sections) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(section.title || section.id || "Handoff section");
        const meta = document.createElement("p");
        meta.className = "meta";
        const items = Array.isArray(section.items) ? section.items : [];
        meta.textContent = String(items.length) + " item(s)";
        item.append(title, meta);
        results.append(item);
      }
      markdown.textContent = String(report.markdown || "");
    } catch (err) {
      status.textContent = "Handoff unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function contextPackScript(): string {
  return `(() => {
  const form = document.getElementById("memory-context-pack-form");
  const input = document.getElementById("memory-context-pack-goal");
  const viewerLink = document.getElementById("memory-context-pack-link");
  const status = document.getElementById("memory-context-pack-status");
  const results = document.getElementById("memory-context-pack-results");
  const markdown = document.getElementById("memory-context-pack-markdown");
  if (!form || !input || !viewerLink || !status || !results || !markdown) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const goal = String(input.value || "").trim();
    if (!goal) {
      status.textContent = "Context goal is required.";
      return;
    }
    viewerLink.setAttribute("href", "/context-pack?goal=" + encodeURIComponent(goal));
    status.textContent = "Building context pack...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/context-pack?goal=" + encodeURIComponent(goal) + "&budget_chars=2500&limit=8", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const pack = await response.json();
      const entries = Array.isArray(pack.entries) ? pack.entries : [];
      status.textContent = String(entries.length) + " context item(s), status " + String(pack.status || "unknown") + ".";
      for (const entry of entries.slice(0, 8)) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(entry.title || "Context entry");
        const meta = document.createElement("p");
        meta.className = "meta";
        const citation = entry.citation || {};
        meta.textContent = String(entry.section || "evidence") + " - " + String(citation.urn || "");
        item.append(title, meta);
        results.append(item);
      }
      markdown.textContent = String(pack.markdown || "");
    } catch (err) {
      status.textContent = "Context pack unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function workFrontierScript(): string {
  return `(() => {
  const form = document.getElementById("memory-frontier-form");
  const input = document.getElementById("memory-frontier-focus");
  const viewerLink = document.getElementById("memory-frontier-link");
  const status = document.getElementById("memory-frontier-status");
  const results = document.getElementById("memory-frontier-results");
  const markdown = document.getElementById("memory-frontier-markdown");
  if (!form || !input || !viewerLink || !status || !results || !markdown) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const focus = String(input.value || "").trim();
    viewerLink.setAttribute("href", focus ? "/frontier?focus=" + encodeURIComponent(focus) : "/frontier");
    status.textContent = "Refreshing frontier...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/frontier" + (focus ? "?focus=" + encodeURIComponent(focus) + "&limit=12" : "?limit=12"), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      status.textContent = String(summary.ready ?? 0) + " ready, " + String(summary.blocked ?? 0) + " blocked, status " + String(report.status || "unknown") + ".";
      const ready = Array.isArray(report.ready) ? report.ready : [];
      const blocked = Array.isArray(report.blocked) ? report.blocked : [];
      for (const entry of ready.concat(blocked).slice(0, 8)) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(entry.title || "Work item");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(entry.citation || "") + " - priority " + String(entry.priority ?? "?");
        item.append(title, meta);
        results.append(item);
      }
      markdown.textContent = String(report.markdown || "");
    } catch (err) {
      status.textContent = "Work frontier unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function routingGuideScript(): string {
  return `(() => {
  const form = document.getElementById("memory-routing-guide-form");
  const input = document.getElementById("memory-routing-guide-agent");
  const viewerLink = document.getElementById("memory-routing-guide-link");
  const status = document.getElementById("memory-routing-guide-status");
  const results = document.getElementById("memory-routing-guide-results");
  if (!form || !input || !viewerLink || !status || !results) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const agent = String(input.value || "generic");
    viewerLink.setAttribute("href", "/routing-guide?agent=" + encodeURIComponent(agent));
    status.textContent = "Refreshing routing guide...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/routing-guide?agent=" + encodeURIComponent(agent), {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const guide = await response.json();
      const integration = guide.integration || {};
      const targetFiles = Array.isArray(guide.targetFiles) ? guide.targetFiles : [];
      const tools = Array.isArray(guide.mcpTools) ? guide.mcpTools : [];
      const rules = Array.isArray(guide.rules) ? guide.rules : [];
      status.textContent = String(integration.displayName || agent) + ": " + String((integration.transports || []).join(", ")) + ".";
      addItem("Target files", targetFiles.join(", ") || "none");
      addItem("MCP tools", String(tools.length) + " tool(s)");
      addItem("Routing rules", String(rules.length) + " rule(s)");
    } catch (err) {
      status.textContent = "Routing guide unavailable here; open the Workbench through memory serve.";
    }
  });
  function addItem(titleText, metaText) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = metaText;
    item.append(title, meta);
    results.append(item);
  }
})();`.replaceAll("</", "<\\/");
}

function agentIntegrationStatusScript(): string {
  return `(() => {
  const button = document.getElementById("memory-agent-integration-refresh");
  const status = document.getElementById("memory-agent-integration-status");
  const results = document.getElementById("memory-agent-integration-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing agent integration status...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/integration-status", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      status.textContent = String(summary.ready ?? 0) + "/" + String(summary.agents ?? 0) + " agent integration(s) ready.";
      const agents = Array.isArray(report.agents) ? report.agents.slice(0, 8) : [];
      for (const agent of agents) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(agent.display_name || agent.agent || "Agent");
        const meta = document.createElement("p");
        meta.className = "meta";
        const files = Array.isArray(agent.target_files) ? agent.target_files.map((file) => String(file.path || "")).join(", ") : "";
        meta.textContent = String(agent.state || "unknown") + " - " + files;
        item.append(title, meta);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Agent integration status unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function docsReferenceGraphScript(): string {
  return `(() => {
  const button = document.getElementById("memory-docs-reference-graph-refresh");
  const status = document.getElementById("memory-docs-reference-graph-status");
  const results = document.getElementById("memory-docs-reference-graph-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing doc reference graph...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/docs/reference-graph", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = String(report.reference_edges ?? 0) + " edge(s), " + String(report.reference_nodes ?? 0) + " referenced node(s), " + String(report.grounded_docs ?? 0) + "/" + String(report.total_docs ?? 0) + " grounded docs.";
      const refs = Array.isArray(report.top_references) ? report.top_references.slice(0, 8) : [];
      for (const ref of refs) {
        const item = document.createElement("li");
        item.className = "result";
        const count = document.createElement("span");
        count.className = "pill";
        count.textContent = String(ref.incoming_docs ?? 0);
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(ref.node?.title || ref.node?.label || "Referenced node");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(ref.node?.label || "") + " - referenced by doc count";
        content.append(title, meta);
        item.append(count, content);
        results.append(item);
      }
      if (refs.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No extracted document reference graph edges to show.";
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Doc reference graph unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function assetInventoryScript(): string {
  return `(() => {
  const button = document.getElementById("memory-assets-refresh");
  const status = document.getElementById("memory-assets-status");
  const results = document.getElementById("memory-assets-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing asset inventory...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/assets", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = String(report.total_assets ?? 0) + " asset(s), " + String(report.kinds?.length ?? 0) + " kind(s).";
      const assets = Array.isArray(report.assets) ? report.assets.slice(0, 8) : [];
      for (const asset of assets) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(asset.title || asset.path || "Asset");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(asset.asset_kind || "asset") + " - " + String(asset.media_type || "unknown") + " - " + String(asset.bytes ?? 0) + " byte(s)";
        item.append(title, meta);
        results.append(item);
      }
      if (assets.length === 0) {
        const item = document.createElement("li");
        item.textContent = "No binary/document assets indexed yet.";
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Asset inventory unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function pathExplorerScript(): string {
  return `(() => {
  const form = document.getElementById("memory-path-form");
  const fromInput = document.getElementById("memory-path-from");
  const toInput = document.getElementById("memory-path-to");
  const status = document.getElementById("memory-path-status");
  const results = document.getElementById("memory-path-results");
  if (!form || !fromInput || !toInput || !status || !results) return;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const from = String(fromInput.value || "").trim();
    const to = String(toInput.value || "").trim();
    results.replaceChildren();
    if (!from || !to) {
      status.textContent = "Enter source and target labels.";
      return;
    }
    status.textContent = "Explaining path...";
    try {
      const response = await fetch("/api/path-explain?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to) + "&max_depth=8", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      status.textContent = report.reachable ? "Reachable in " + String(report.hop_count) + " hop(s)." : "No directed path found.";
      const edges = Array.isArray(report.edges) ? report.edges : [];
      if (edges.length === 0 && Array.isArray(report.recommended_next_actions)) {
        for (const action of report.recommended_next_actions) {
          const item = document.createElement("li");
          item.textContent = String(action);
          results.append(item);
        }
        return;
      }
      for (const edge of edges) {
        const item = document.createElement("li");
        const title = document.createElement("h3");
        title.textContent = String(edge.from?.title || edge.from?.label || "?") + " --" + String(edge.label || "?") + "--> " + String(edge.to?.title || edge.to?.label || "?");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = String(edge.from?.label || "") + " -> " + String(edge.to?.label || "");
        item.append(title, meta);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Path explanation unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function communitiesScript(): string {
  return `(() => {
  const button = document.getElementById("memory-communities-refresh");
  const status = document.getElementById("memory-communities-status");
  const results = document.getElementById("memory-communities-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing communities...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/communities", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const communities = Array.isArray(report.communities) ? report.communities : [];
      status.textContent = String(communities.length) + " community(ies), " + String(report.assignments?.length ?? 0) + " assignment(s).";
      for (const community of communities.slice(0, 8)) {
        const item = document.createElement("li");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(community.id || "community");
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = Array.isArray(community.titles) ? community.titles.join(", ") : "";
        const count = document.createElement("span");
        count.className = "pill";
        count.textContent = String(community.count ?? 0) + " node(s)";
        content.append(title, meta);
        item.append(content, count);
        results.append(item);
      }
    } catch (_) {
      status.textContent = "Communities unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function onboardingMapScript(): string {
  return `(() => {
  const button = document.getElementById("memory-onboarding-refresh");
  const status = document.getElementById("memory-onboarding-status");
  const results = document.getElementById("memory-onboarding-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing onboarding map...";
    results.replaceChildren();
    try {
      const response = await fetch("/api/onboarding-map", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const map = await response.json();
      const summary = map.summary || {};
      status.textContent = String(map.status || "unknown") + ": " + String(summary.warnings ?? 0) + " warning(s).";
      const sections = map.sections || {};
      for (const key of ["concepts", "workflows", "decisions", "risks", "validations"]) {
        const entries = Array.isArray(sections[key]) ? sections[key] : [];
        if (entries.length === 0) continue;
        const item = document.createElement("li");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = key;
        const meta = document.createElement("p");
        meta.className = "meta";
        meta.textContent = entries.slice(0, 3).map((entry) => String(entry.title || entry.urn || "")).filter(Boolean).join(", ");
        const count = document.createElement("span");
        count.className = "pill";
        count.textContent = String(entries.length);
        content.append(title, meta);
        item.append(content, count);
        results.append(item);
      }
    } catch (_) {
      status.textContent = "Onboarding map unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function vectorDiagnosticsScript(): string {
  return `(() => {
  const form = document.getElementById("memory-vector-form");
  const input = document.getElementById("memory-vector-query");
  const status = document.getElementById("memory-vector-status");
  const results = document.getElementById("memory-vector-results");
  if (!form || !input || !status || !results) return;
  async function refreshStatus() {
    try {
      const response = await fetch("/api/vector/status", { headers: { "accept": "application/json" } });
      if (!response.ok) return;
      const report = await response.json();
      status.textContent = "Vector projection " + String(report.overall || "unknown") + ": " + String(report.ready ?? 0) + "/" + String(report.total ?? 0) + " ready.";
    } catch (_) {
      status.textContent = "Vector status unavailable here; open the Workbench through memory serve.";
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = String(input.value || "").trim();
    results.replaceChildren();
    if (!query) {
      status.textContent = "Enter a vector query.";
      return;
    }
    status.textContent = "Searching vectors...";
    try {
      const response = await fetch("/api/vector/search?query=" + encodeURIComponent(query) + "&limit=5", {
        headers: { "accept": "application/json" },
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const hits = Array.isArray(report.hits) ? report.hits : [];
      status.textContent = report.status === "available" ? hits.length + " vector hit(s)." : "Vector search unavailable: " + String(report.error || "not ready");
      for (const hit of hits) {
        const item = document.createElement("li");
        item.className = "result";
        const score = document.createElement("span");
        score.className = "pill";
        score.textContent = String(hit.score ?? "?");
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(hit.title || hit.label || "Untitled vector hit");
        const meta = document.createElement("p");
        meta.className = "meta";
        const assetMeta = hit.kind === "asset"
          ? " - " + String(hit.asset_kind || "asset") + " - " + String(hit.media_type || "unknown") + (hit.path ? " - " + String(hit.path) : "")
          : "";
        meta.textContent = String(hit.kind || hit.node_type || "node") + " - " + String(hit.label || "") + assetMeta;
        const excerpt = document.createElement("p");
        excerpt.textContent = String(hit.excerpt || "");
        content.append(title, meta, excerpt);
        item.append(score, content);
        results.append(item);
      }
    } catch (err) {
      status.textContent = "Vector diagnostics unavailable here; open the Workbench through memory serve.";
    }
  });
  refreshStatus();
})();`.replaceAll("</", "<\\/");
}

function extractionStatusScript(): string {
  return `(() => {
  const button = document.getElementById("memory-extraction-refresh");
  const status = document.getElementById("memory-extraction-status");
  const results = document.getElementById("memory-extraction-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing extraction status...";
    try {
      const response = await fetch("/api/extraction/status", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      results.replaceChildren();
      const inferred = report.inferred || {};
      const first = document.createElement("li");
      const title = document.createElement("h3");
      title.textContent = inferred.available ? "Provider available" : "Local structured fallback";
      const meta = document.createElement("p");
      meta.className = "meta";
      meta.textContent = String(inferred.facts ?? 0) + " inferred fact(s), Stop hook " + (inferred.hook_stop_enabled ? "enabled" : "disabled");
      first.append(title, meta);
      results.append(first);
      const deterministic = report.deterministic && typeof report.deterministic === "object"
        ? Object.entries(report.deterministic).filter(([, ready]) => ready).map(([key]) => String(key).replaceAll("_", " "))
        : [];
      const second = document.createElement("li");
      const detTitle = document.createElement("h3");
      detTitle.textContent = "Deterministic extractors";
      const detMeta = document.createElement("p");
      detMeta.className = "meta";
      detMeta.textContent = deterministic.join(", ");
      second.append(detTitle, detMeta);
      results.append(second);
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Extraction paths are ready.";
    } catch (err) {
      status.textContent = "Extraction status unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function governanceScript(): string {
  return `(() => {
  const button = document.getElementById("memory-governance-refresh");
  const status = document.getElementById("memory-governance-status");
  const results = document.getElementById("memory-governance-results");
  if (!button || !status || !results) return;
  function addItem(titleText, detailText) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing governance...";
    try {
      const response = await fetch("/api/governance", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      results.replaceChildren();
      addItem(String(report.status || "unknown"), String(summary.nodes_with_provenance ?? 0) + "/" + String(summary.total_nodes ?? 0) + " with provenance, " + String(summary.missing_provenance ?? 0) + " missing");
      addItem("Privacy and lint", String(summary.privacy_findings ?? 0) + " privacy finding(s), " + String(summary.lint_findings ?? 0) + " lint finding(s)");
      addItem("Contradictions", String(summary.unresolved_contradictions ?? 0) + " unresolved, " + String(summary.superseded_nodes ?? 0) + " superseded node(s)");
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Governance report is clean.";
    } catch (err) {
      status.textContent = "Governance unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function decayScript(): string {
  return `(() => {
  const button = document.getElementById("memory-decay-refresh");
  const status = document.getElementById("memory-decay-status");
  const results = document.getElementById("memory-decay-results");
  if (!button || !status || !results) return;
  function addItem(titleText, detailText) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing decay plan...";
    try {
      const response = await fetch("/api/decay", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      const policy = report.policy || {};
      results.replaceChildren();
      addItem(String(report.status || "unknown"), String(summary.keep ?? 0) + " keep, " + String(summary.review ?? 0) + " review, " + String(summary.deprecate ?? 0) + " deprecate, " + String(summary.expire ?? 0) + " expire");
      addItem("Policy", String(policy.stale_days ?? 0) + "d stale, " + String(policy.deprecate_days ?? 0) + "d deprecate, pinned " + String(policy.pinned_importance_threshold ?? 0));
      const deprecate = Array.isArray(report.deprecate) ? report.deprecate[0] : null;
      if (deprecate) addItem("Deprecate candidate", String(deprecate.title || deprecate.citation || ""));
      const review = Array.isArray(report.review) ? report.review[0] : null;
      if (review) addItem("Review candidate", String(review.title || review.citation || ""));
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Decay plan is clean.";
    } catch (err) {
      status.textContent = "Decay plan unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function memoryHealthScript(): string {
  return `(() => {
  const button = document.getElementById("memory-health-refresh");
  const status = document.getElementById("memory-health-status");
  const results = document.getElementById("memory-health-results");
  if (!button || !status || !results) return;
  function addItem(titleText, detailText, className) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = className || "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing Memory health...";
    try {
      const response = await fetch("/api/memory/health", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      results.replaceChildren();
      addItem(String(report.state || "unknown"), String(report.stats?.nodes ?? 0) + " node(s), " + String(report.stats?.edges ?? 0) + " edge(s), " + String(report.stale?.stale ?? 0) + "/" + String(report.stale?.total ?? 0) + " stale", "meta");
      addItem(String(report.vector?.overall || "unknown"), String(report.vector?.ready ?? 0) + "/" + String(report.vector?.total ?? 0) + " vector item(s) ready, " + String(report.vector?.failed ?? 0) + " failed", "meta");
      addItem(String(report.skill_telemetry?.status || "unknown"), String(report.skill_telemetry?.rollups ?? 0) + " Skill telemetry rollup(s)", "meta");
      const actions = Array.isArray(report.recommended_next_actions) ? report.recommended_next_actions : [];
      status.textContent = actions[0] || "Memory health refreshed.";
    } catch (err) {
      status.textContent = "Memory health unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function learningDebtScript(): string {
  return `(() => {
  const button = document.getElementById("memory-learning-debt-refresh");
  const status = document.getElementById("memory-learning-debt-status");
  const results = document.getElementById("memory-learning-debt-results");
  if (!button || !status || !results) return;
  function totalDebt(summary) {
    return Number(summary?.repeatedFailurePatterns ?? 0)
      + Number(summary?.staleOrContradictedGuidance ?? 0)
      + Number(summary?.missingValidationEvidence ?? 0)
      + Number(summary?.skillTelemetryGaps ?? 0);
  }
  function addItem(titleText, detailText, className) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = className || "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing learning debt...";
    try {
      const response = await fetch("/api/learning-debt", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const summary = report.summary || {};
      const categories = report.categories || {};
      results.replaceChildren();
      addItem(String(report.status || "unknown"), String(totalDebt(summary)) + " debt signal(s), " + String(summary.skillTelemetryGaps ?? 0) + " telemetry gap(s)", "meta");
      const repeated = Array.isArray(categories.repeatedFailurePatterns) ? categories.repeatedFailurePatterns[0] : null;
      if (repeated) addItem("Repeated failure", String(repeated.pattern || "") + " - " + String(repeated.attemptCount || 0) + " attempt(s)", "meta");
      const validation = Array.isArray(categories.missingValidationEvidence) ? categories.missingValidationEvidence[0] : null;
      if (validation) addItem("Validation gap", String(validation.title || validation.evidence || ""), "meta");
      const telemetry = Array.isArray(categories.skillTelemetryGaps) ? categories.skillTelemetryGaps[0] : null;
      if (telemetry) addItem("Telemetry gap", String(telemetry.reason || telemetry.kind || ""), "meta");
      status.textContent = String(report.status || "Learning debt refreshed.");
    } catch (err) {
      status.textContent = "Learning debt unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function hookDiagnosticsScript(): string {
  return `(() => {
  const form = document.getElementById("memory-hooks-form");
  const input = document.getElementById("memory-hooks-session");
  const status = document.getElementById("memory-hooks-status");
  const results = document.getElementById("memory-hooks-results");
  if (!form || !input || !status || !results) return;
  function addItem(titleText, detailText, className) {
    const item = document.createElement("li");
    const title = document.createElement("h3");
    title.textContent = titleText;
    const detail = document.createElement("p");
    detail.className = className || "meta";
    detail.textContent = detailText;
    item.append(title, detail);
    results.append(item);
  }
  async function loadHookCoverage() {
    const response = await fetch("/api/hooks/coverage", { headers: { "accept": "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const report = await response.json();
    const summary = report.summary || {};
    addItem(
      "Hook coverage",
      String(report.mode || "unknown") + ": " + String(summary.enabled_events ?? 0) + "/" + String(summary.total_events ?? 0) + " enabled, " + String(Array.isArray(report.gaps) ? report.gaps.length : 0) + " gap(s)",
      "meta",
    );
    const gaps = Array.isArray(report.gaps) ? report.gaps.slice(0, 4) : [];
    for (const gap of gaps) addItem("Gap", String(gap), "meta");
  }
  async function loadTimeline(sessionId) {
    const query = sessionId ? "?session=" + encodeURIComponent(sessionId) + "&limit=20" : "?limit=20";
    const response = await fetch("/api/session/timeline" + query, { headers: { "accept": "application/json" } });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const timeline = await response.json();
    const entries = Array.isArray(timeline.entries) ? timeline.entries.slice(-5).reverse() : [];
    addItem("Session timeline", String(timeline.summary?.events ?? 0) + " event(s), " + String(timeline.summary?.hook_events ?? 0) + " hook event(s)", "meta");
    for (const entry of entries) {
      addItem(String(entry.title || entry.kind || "Timeline event"), String(entry.occurred_at || "") + " - " + String(entry.detail || ""), "meta");
    }
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    results.replaceChildren();
    status.textContent = "Refreshing hook diagnostics...";
    try {
      await loadHookCoverage();
      await loadTimeline(String(input.value || "").trim());
      status.textContent = "Hook diagnostics refreshed.";
    } catch (err) {
      status.textContent = "Hook diagnostics unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}

function layersScript(): string {
  return `(() => {
  const button = document.getElementById("memory-layers-refresh");
  const status = document.getElementById("memory-layers-status");
  const results = document.getElementById("memory-layers-results");
  if (!button || !status || !results) return;
  button.addEventListener("click", async () => {
    status.textContent = "Refreshing layers...";
    try {
      const response = await fetch("/api/layers", { headers: { "accept": "application/json" } });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const report = await response.json();
      const layers = Array.isArray(report.layers) ? report.layers : [];
      results.replaceChildren();
      for (const layer of layers) {
        const item = document.createElement("li");
        item.className = "capability";
        const content = document.createElement("div");
        const title = document.createElement("h3");
        title.textContent = String(layer.title || layer.id || "Memory layer");
        const meta = document.createElement("p");
        meta.className = "meta";
        const counts = layer.counts && typeof layer.counts === "object" ? Object.entries(layer.counts).slice(0, 4) : [];
        meta.textContent = counts.map(([key, value]) => String(key) + "=" + String(value)).join(", ");
        const pill = document.createElement("span");
        pill.className = "pill " + (layer.status === "ready" ? "ok" : layer.status === "degraded" ? "bad" : "warn");
        pill.textContent = String(layer.status || "unknown");
        content.append(title, meta);
        item.append(content, pill);
        results.append(item);
      }
      status.textContent = String(report.summary?.ready_layers ?? 0) + "/" + String(report.summary?.total_layers ?? layers.length) + " layer(s) ready.";
    } catch (err) {
      status.textContent = "Layer report unavailable here; open the Workbench through memory serve.";
    }
  });
})();`.replaceAll("</", "<\\/");
}
