import { diagnose } from "./doctor.js";
import { buildDocCoverageReport, type DocCoverageReport } from "./doc-coverage.js";
import {
  buildMemoryExtractionStatus,
  type MemoryExtractionStatus,
} from "./extraction-status.js";
import type { MemoryStore, VectorStatusReport } from "./graph-store.js";
import { buildHookCoverageReport, type HookCoverageReport } from "./hook-coverage.js";
import { buildMemoryDecayReport, type MemoryDecayReport } from "./memory-decay.js";
import { escapeHtml, jsonForScript, metricWithRequiredMeta as metric, warningsSection } from "./viewer-utils.js";

export interface MemoryOperationalDashboard {
  schema_version: "memory.operational_dashboard.v1";
  read_only: true;
  root: string;
  generated_at: string;
  state: "ready" | "attention" | "degraded";
  stats: {
    nodes: number;
    edges: number;
    docs: number;
  };
  vector: Pick<
    VectorStatusReport,
    "overall" | "total" | "ready" | "stale" | "unavailable" | "failed"
  > & { error?: string };
  docs: {
    total: number;
    grounded: number;
    ungrounded: number;
    with_references: number;
    warnings: number;
  };
  hooks: {
    mode: HookCoverageReport["mode"];
    enabled_events: number;
    wired_events: number;
    effective_events: number;
    total_events: number;
    gaps: number;
    actionable_gaps: number;
  };
  extraction: {
    inferred_available: boolean;
    inferred_facts: number;
    egress: string | null;
  };
  stale: {
    total_nodes: number;
    stale_nodes: number;
    stale_days: number;
  };
  decay: {
    status: MemoryDecayReport["status"];
    keep: number;
    review: number;
    deprecate: number;
    expire: number;
    protected: number;
    superseded: number;
    stale_days: number;
    deprecate_days: number;
  };
  warnings: string[];
  recommended_next_actions: string[];
  sources: {
    doc_coverage: DocCoverageReport;
    hook_coverage: HookCoverageReport;
    extraction_status: MemoryExtractionStatus;
    decay_plan: MemoryDecayReport;
  };
}

export interface MemoryOperationalDashboardArtifact {
  contract: {
    name: "memory.operational_dashboard.viewer";
    version: "memory.operational_dashboard.viewer.v1";
    consumes: "memory.operational_dashboard.v1";
  };
  dashboard: MemoryOperationalDashboard;
  html: string;
}

export async function buildMemoryOperationalDashboard(
  store: MemoryStore,
  rootDir: string,
  opts: { staleDays?: number; now?: number } = {},
): Promise<MemoryOperationalDashboard> {
  const [stats, docs, hooks, extraction, stale, decay] = await Promise.all([
    store.stats(),
    buildDocCoverageReport(store),
    buildHookCoverageReport(rootDir),
    buildMemoryExtractionStatus(store, rootDir, opts),
    diagnose(store, { staleDays: opts.staleDays, now: opts.now }),
    buildMemoryDecayReport(store, { stale_days: opts.staleDays, limit: 10, now: opts.now }),
  ]);
  const warnings = [
    ...docs.warnings.map((warning) => `docs: ${warning}`),
    ...hooks.actionable_gaps.map((gap) => `hooks: ${gap}`),
    ...(extraction.inferred.error ? [`extraction: ${extraction.inferred.error}`] : []),
    ...stale.stale.slice(0, 5).map((node) => `stale: ${node.title} (${node.ageDays} days)`),
    ...(decay.status === "attention"
      ? [
          `decay: ${decay.summary.review} review, ${decay.summary.deprecate} deprecate, ${decay.summary.expire} expire`,
        ]
      : []),
  ];
  const state = dashboardState(docs, hooks, stale, decay, warnings);

  return {
    schema_version: "memory.operational_dashboard.v1",
    read_only: true,
    root: rootDir,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    state,
    stats: { nodes: stats.nodes, edges: stats.edges, docs: docs.total_docs },
    vector: docs.vector,
    docs: {
      total: docs.total_docs,
      grounded: docs.grounded_docs,
      ungrounded: docs.ungrounded_docs,
      with_references: docs.docs_with_references,
      warnings: docs.warnings.length,
    },
    hooks: {
      mode: hooks.mode,
      enabled_events: hooks.summary.enabled_events,
      wired_events: hooks.summary.wired_events,
      effective_events: hooks.summary.effective_events,
      total_events: hooks.summary.total_events,
      gaps: hooks.gaps.length,
      actionable_gaps: hooks.actionable_gaps.length,
    },
    extraction: {
      inferred_available: extraction.inferred.available,
      inferred_facts: extraction.inferred.facts,
      egress: extraction.inferred.egress,
    },
    stale: {
      total_nodes: stale.totalNodes,
      stale_nodes: stale.stale.length,
      stale_days: stale.staleDays,
    },
    decay: {
      status: decay.status,
      keep: decay.summary.keep,
      review: decay.summary.review,
      deprecate: decay.summary.deprecate,
      expire: decay.summary.expire,
      protected: decay.summary.protected,
      superseded: decay.summary.superseded,
      stale_days: decay.policy.stale_days,
      deprecate_days: decay.policy.deprecate_days,
    },
    warnings,
    recommended_next_actions: dashboardActions(docs, hooks, extraction, stale, decay, warnings),
    sources: {
      doc_coverage: docs,
      hook_coverage: hooks,
      extraction_status: extraction,
      decay_plan: decay,
    },
  };
}

export function buildMemoryOperationalDashboardArtifact(
  dashboard: MemoryOperationalDashboard,
): MemoryOperationalDashboardArtifact {
  return {
    contract: {
      name: "memory.operational_dashboard.viewer",
      version: "memory.operational_dashboard.viewer.v1",
      consumes: dashboard.schema_version,
    },
    dashboard,
    html: renderOperationalDashboard(dashboard),
  };
}

function dashboardState(
  docs: DocCoverageReport,
  hooks: HookCoverageReport,
  stale: Awaited<ReturnType<typeof diagnose>>,
  decay: MemoryDecayReport,
  warnings: string[],
): MemoryOperationalDashboard["state"] {
  if (docs.vector.failed > 0 || !hooks.config_found) return "degraded";
  if (
    docs.ungrounded_docs > 0 ||
    stale.stale.length > 0 ||
    decay.status === "attention" ||
    warnings.length > 0
  ) {
    return "attention";
  }
  return "ready";
}

function dashboardActions(
  docs: DocCoverageReport,
  hooks: HookCoverageReport,
  extraction: MemoryExtractionStatus,
  stale: Awaited<ReturnType<typeof diagnose>>,
  decay: MemoryDecayReport,
  warnings: string[],
): string[] {
  const actions: string[] = [];
  if (docs.ungrounded_docs > 0) actions.push("run `memory ingest . --root .` to refresh document graph grounding");
  if (docs.vector.overall !== "ready") {
    actions.push("run `memory vector maintain --local` for local-dev vectors or configure `RED_MEMORY_VECTOR_PROVIDER` for provider embeddings");
  }
  actions.push(...hooks.recommended_next_actions.filter(isActionableRecommendation));
  actions.push(...extraction.recommended_next_actions.filter(isActionableRecommendation));
  if (decay.status === "attention") {
    actions.push(...decay.recommended_next_actions.filter(isActionableRecommendation));
  }
  if (stale.stale.length > 0) actions.push("review stale Memory nodes with `memory doctor`");
  if (actions.length === 0 && warnings.length === 0) actions.push("Memory operational dashboard is ready");
  return [...new Set(actions)];
}

function isActionableRecommendation(action: string): boolean {
  return !(/\bis ready; no action required\b/i.test(action) || /\bare ready\b/i.test(action));
}

function renderOperationalDashboard(dashboard: MemoryOperationalDashboard): string {
  const stateClass = dashboard.state === "ready" ? "ok" : dashboard.state === "degraded" ? "bad" : "warn";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory operational dashboard</title>
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
    h1 { font-size: 28px; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 13px; margin-bottom: 4px; }
    .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      background: var(--panel);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
    }
    .ok { color: var(--accent); }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
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
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    @media (max-width: 880px) { header, .metrics, .layout { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Operational Dashboard</h1>
        <p class="meta">${escapeHtml(dashboard.root)} - ${escapeHtml(dashboard.generated_at)}</p>
      </div>
      <div class="badge ${stateClass}">${escapeHtml(dashboard.state)}</div>
    </header>
    <div class="metrics">
      ${metric("Nodes", dashboard.stats.nodes, `${dashboard.stats.edges} edges`)}
      ${metric("Docs", `${dashboard.docs.grounded}/${dashboard.docs.total}`, `${dashboard.docs.with_references} with refs`)}
      ${metric("Vectors", `${dashboard.vector.ready}/${dashboard.vector.total}`, dashboard.vector.overall)}
      ${metric("Extraction", dashboard.extraction.inferred_facts, dashboard.extraction.inferred_available ? `${dashboard.extraction.egress} inferred` : "deterministic")}
      ${metric("Decay", `${dashboard.decay.review}/${dashboard.decay.deprecate}`, dashboard.decay.status)}
    </div>
    <div class="layout">
      <div class="stack">
        ${summarySection(dashboard)}
        ${warningsSection(dashboard.warnings, "No operational warnings.")}
      </div>
      <div class="stack">
        ${actionsSection(dashboard.recommended_next_actions)}
        ${sourceSection(dashboard)}
      </div>
    </div>
    <script id="memory-dashboard-data" type="application/json">${jsonForScript(dashboard)}</script>
  </main>
</body>
</html>`;
}


function summarySection(dashboard: MemoryOperationalDashboard): string {
  return `<section>
    <h2>Operational Summary</h2>
    <ul>
      <li><strong>Documents</strong><p class="meta">${dashboard.docs.grounded}/${dashboard.docs.total} grounded, ${dashboard.docs.ungrounded} ungrounded</p></li>
      <li><strong>Vector projection</strong><p class="meta">${dashboard.vector.overall}: ${dashboard.vector.ready}/${dashboard.vector.total} ready, ${dashboard.vector.failed} failed</p></li>
      <li><strong>Hooks</strong><p class="meta">${dashboard.hooks.mode}, ${dashboard.hooks.enabled_events}/${dashboard.hooks.total_events} enabled, ${dashboard.hooks.gaps} gap(s)</p></li>
      <li><strong>Extraction</strong><p class="meta">${dashboard.extraction.inferred_available ? "inferred provider available" : "deterministic only"}, ${dashboard.extraction.inferred_facts} inferred fact(s)</p></li>
      <li><strong>Staleness</strong><p class="meta">${dashboard.stale.stale_nodes}/${dashboard.stale.total_nodes} stale over ${dashboard.stale.stale_days} day(s)</p></li>
      <li><strong>Decay</strong><p class="meta">${dashboard.decay.status}: ${dashboard.decay.review} review, ${dashboard.decay.deprecate} deprecate, ${dashboard.decay.expire} expire; ${dashboard.decay.protected} protected, ${dashboard.decay.superseded} superseded</p></li>
    </ul>
  </section>`;
}


function actionsSection(actions: string[]): string {
  return `<section>
    <h2>Next Actions</h2>
    ${
      actions.length === 0
        ? `<p class="empty">No next actions.</p>`
        : `<ul>${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`
    }
  </section>`;
}

function sourceSection(dashboard: MemoryOperationalDashboard): string {
  return `<section>
    <h2>Source Reports</h2>
    <ul>
      <li><strong>${escapeHtml(dashboard.sources.doc_coverage.schema_version)}</strong><p class="meta">doc coverage contract</p></li>
      <li><strong>${escapeHtml(dashboard.sources.hook_coverage.schema_version)}</strong><p class="meta">hook coverage contract</p></li>
      <li><strong>${escapeHtml(dashboard.sources.extraction_status.schema_version)}</strong><p class="meta">extraction status contract</p></li>
      <li><strong>${escapeHtml(dashboard.sources.decay_plan.schema_version)}</strong><p class="meta">decay plan contract</p></li>
    </ul>
  </section>`;
}
