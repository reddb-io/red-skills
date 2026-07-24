import {
  agentIntegrationStatusScript,
  assetInventoryScript,
  communitiesScript,
  contextPackScript,
  decayScript,
  docsCoverageScript,
  docsExplorerScript,
  docsReferenceGraphScript,
  extractionStatusScript,
  governanceScript,
  handoffScript,
  hookDiagnosticsScript,
  layersScript,
  learningDebtScript,
  memoryHealthScript,
  onboardingMapScript,
  pathExplorerScript,
  routingGuideScript,
  searchConsoleScript,
  vectorDiagnosticsScript,
  workFrontierScript,
} from "./scripts.js";
import type { ContextPack } from "../context-pack.js";
import type { LearningDebtReport } from "../learning-debt.js";
import { escapeHtml, jsonForScript, metric } from "../viewer-utils.js";
import type { MemoryWorkbench } from "./types.js";

export function renderWorkbench(workbench: MemoryWorkbench): string {
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
    .workflow-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin: 0 0 14px;
    }
    .workflow-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
    }
    .workflow-card strong { display: block; margin-bottom: 4px; }
    .workflow-card code { color: var(--accent); }
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
        <p class="meta">Read-only RedDB-backed overview for operations, capabilities, reference posture, and session replay evidence.</p>
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
      ${metric("References", workbench.references_radar.summary.references)}
      ${metric("Timeline", workbench.session_timeline.summary.events)}
      ${metric("Autocure", `${workbench.autocure.actions_proposed.length}/${workbench.autocure.actions_applied.length}`)}
    </div>
    <section>
      <h2>Command map</h2>
      <p class="meta">Use these as the primary entry points. Everything else in the Workbench is an operator or diagnostic view over the same governed evidence store.</p>
      <div class="workflow-grid">
        ${workflowCard("Remember one fact", "memory store \"Decision: ...\"", "Capture scoped evidence for later recall.")}
        ${workflowCard("Get context before acting", "memory recall \"topic\"", "Canonical governed context path.")}
        ${workflowCard("Prepare another agent", "memory context-pack \"goal\"", "Budgeted, cited continuation context.")}
        ${workflowCard("Decide if safe", "memory readiness \"goal\"", "Go/no-go envelope with warnings.")}
        ${workflowCard("Search every surface", "memory smart-search \"query\"", "Broad discovery across recall, docs, assets, and vectors.")}
        ${workflowCard("Operate/debug Memory", "memory health-viewer", "Freshness, hooks, trust, retention, and capability status.")}
      </div>
    </section>
    <div class="layout">
      <div class="stack">
        ${summarySection(workbench)}
        ${layersSection(workbench)}
        ${capabilitiesSection(workbench)}
        ${learningDebtSection(workbench)}
        ${referencesRadarSection(workbench)}
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
        ${whatifSection(workbench)}
        ${federationStatusSection(workbench)}
        ${autocureHealthSection(workbench)}
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

function referencesRadarSection(workbench: MemoryWorkbench): string {
  const references = workbench.references_radar.references;
  return `<section>
    <h2>References Radar</h2>
    <p class="meta">${escapeHtml(workbench.references_radar.note)}</p>
    <ul>${references.map((reference) => `<li class="capability"><div><h3>${escapeHtml(reference.repository)}</h3><p class="meta">${reference.relevant_capabilities} relevant capability signal(s), ${reference.gaps.length} gap(s)</p></div><span class="pill ${statusClass(reference.posture)}">${escapeHtml(reference.posture)} ${reference.score.toFixed(3)}</span></li>`).join("")}</ul>
  </section>`;
}


function workflowCard(title: string, command: string, description: string): string {
  return `<div class="workflow-card"><strong>${escapeHtml(title)}</strong><code>${escapeHtml(command)}</code><p class="meta">${escapeHtml(description)}</p></div>`;
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

function contextPackPreviewEntries(pack: ContextPack): Array<{ entry: ContextPack["entries"][number]; core: boolean }> {
  const coreContext = pack.coreContext ?? [];
  const coreRids = new Set(coreContext.map((entry) => entry.citation.rid));
  const ordinary = pack.entries.filter((entry) => !coreRids.has(entry.citation.rid));
  return [
    ...coreContext.map((entry) => ({ entry, core: true })),
    ...ordinary.map((entry) => ({ entry, core: false })),
  ];
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
    <p id="memory-context-pack-status" class="meta">${pack.entries.length} context item(s), ${pack.coreContext.length} core, status ${escapeHtml(pack.status)}.</p>
    <ul id="memory-context-pack-results">${contextPackPreviewEntries(pack).slice(0, 4).map(({ entry, core }) => `<li><strong>${escapeHtml(entry.title)}</strong><p class="meta">${core ? "core_context" : escapeHtml(entry.section)} - <code>${escapeHtml(entry.citation.urn)}</code>${confidenceBadge(entry.confidence_score)}</p></li>`).join("")}</ul>
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
      <li><strong>Tidy availability</strong><p class="meta">${escapeHtml(governance.tidy_availability.status)} - ${escapeHtml(governance.tidy_availability.reason ?? governance.tidy_availability.next_action)}</p></li>
      <li><strong>Provider tidy recommendations</strong><p class="meta">${governance.tidy_recommendations.summary.recommended_pairs}/${governance.tidy_recommendations.summary.candidate_pairs} duplicate or near-duplicate Soft-merge recommendation(s)</p></li>
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
                `<li class="capability"><div><h3>${escapeHtml(item.worker_id)}</h3><p class="meta">${escapeHtml(item.when)}</p><p>${escapeHtml(item.summary)}</p></div><span class="pill ${outcomeClass(item.outcome)}" data-outcome="${escapeHtml(item.outcome)}">${escapeHtml(item.outcome)}</span><span class="pill">${item.similarity.toFixed(4)}</span></li>`,
            )
            .join("")}</ul>`
    }
    ${gapsHtml}
  </section>`;
}

function whatifSection(workbench: MemoryWorkbench): string {
  const whatif = workbench.whatif;
  const riskClass =
    whatif.breakage_likelihood >= 0.66
      ? "bad"
      : whatif.breakage_likelihood >= 0.33
        ? "warn"
        : "ok";
  const filesPreview = whatif.affected.files.slice(0, 5);
  const symbolsPreview = whatif.affected.symbols.slice(0, 5);
  return `<section>
    <h2>What-if Sandbox</h2>
    <p class="meta">Pre-action blast radius (memory.whatif.v1). Composes structural-impact-reader + reasoning-replay; never mutates state.</p>
    <ul>
      <li><strong>Breakage likelihood</strong><p class="meta">composite of structural fan-out + historical outcomes</p><span class="pill ${riskClass}">${whatif.breakage_likelihood.toFixed(3)}</span></li>
      <li><strong>Self-confidence</strong><p class="meta">structural and historical evidence presence</p><span class="pill">${whatif.self_confidence.toFixed(2)}</span></li>
      <li><strong>Affected</strong><p class="meta">${whatif.affected.files.length} file(s), ${whatif.affected.symbols.length} symbol(s), ${whatif.affected.tests.length} test(s)</p></li>
    </ul>
    ${
      filesPreview.length === 0 && symbolsPreview.length === 0
        ? `<p class="empty">No structural impact for the preview change — call <code>memory whatif --change "&lt;descriptor&gt;"</code> to evaluate real changes.</p>`
        : `<ul>${[
            ...filesPreview.map((file) => `<li><strong>file</strong> <code>${escapeHtml(file)}</code></li>`),
            ...symbolsPreview.map((sym) => `<li><strong>sym</strong> <code>${escapeHtml(sym)}</code></li>`),
          ].join("")}</ul>`
    }
    ${
      whatif.historical_attempts.length === 0
        ? `<p class="meta">No similar past attempts in the reasoning tier yet.</p>`
        : `<p class="meta">Historical attempts: ${whatif.historical_attempts.length} (top similarity ${whatif.historical_attempts[0]?.similarity.toFixed(3)}).</p>`
    }
  </section>`;
}

function federationStatusSection(workbench: MemoryWorkbench): string {
  const federation = workbench.federation;
  const roots = federation.roots;
  return `<section>
    <h2>Federation Status</h2>
    <p class="meta">Cross-root memory federation (issues #168, #170). Reads <code>.red/memory/federation.yaml</code>; redaction policy applied at read time (fields=${escapeHtml(federation.policy.fields.join(", ") || "none")}, scopes=${escapeHtml(federation.policy.scopes.join(", ") || "none")}${federation.policy.default_deny ? ", default-deny" : ""}).</p>
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

function autocureHealthSection(workbench: MemoryWorkbench): string {
  const autocure = workbench.autocure;
  const runs = workbench.autocure_runs.entries;
  const recent = runs.slice(-5).reverse();
  const trend = recent
    .map(
      (entry) =>
        `<li><span class="pill ${entry.dry_run ? "warn" : "ok"}">${entry.dry_run ? "dry-run" : "apply"}</span> ${escapeHtml(entry.generated_at)} — entropy ${entry.entropy_before} → ${entry.entropy_after}, proposed=${entry.proposed} applied=${entry.applied} skipped_claim_guarded=${entry.skipped_claim_guarded}</li>`,
    )
    .join("");
  return `<section>
    <h2>Autocure Health</h2>
    <p class="meta">Opt-in auto-curation (issue #171). Dry-run by default; <code>POST /api/autocure</code> mutates. Claim-guarded nodes (<code>properties.claim_guard</code>) never appear in <code>actions_applied</code>.</p>
    <p class="meta">Current entropy ${autocure.entropy_before} (nodes=${autocure.totals.nodes}, edges=${autocure.totals.edges}, claim_guarded=${autocure.totals.claim_guarded}); ${autocure.actions_proposed.length} action(s) proposed.</p>
    ${
      recent.length === 0
        ? `<p class="empty">No recent autocure runs yet — call <code>memory autocure</code> to populate the trend.</p>`
        : `<ul>${trend}</ul>`
    }
  </section>`;
}

function actionsSection(workbench: MemoryWorkbench): string {
  const actions = [
    ...workbench.dashboard.recommended_next_actions,
    ...workbench.capabilities.recommended_next_actions,
    ...workbench.references_radar.recommended_next_actions,
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

function statusClass(status: string): string {
  if (status === "ready" || status === "succeeded") return "ok";
  if (status === "failed" || status === "degraded" || status === "gap") return "bad";
  return "warn";
}
