import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MemoryStore } from "./graph-store.js";
import { buildMemoryAssetInventory } from "./asset-inventory.js";
import { buildMemoryAssetInventoryViewerArtifact } from "./asset-inventory-viewer.js";
import { buildMemoryAgentIntegrationStatus } from "./agent-integration-status.js";
import { buildMemoryAgentIntegrationStatusViewerArtifact } from "./agent-integration-status-viewer.js";
import { buildCommunityAnalytics } from "./communities.js";
import { buildCommunitiesViewerArtifact } from "./communities-viewer.js";
import { buildContextPack } from "./context-pack.js";
import { buildContextPackViewerArtifact } from "./context-pack-viewer.js";
import { readDoc, searchDocs } from "./doc-search.js";
import { buildDocSearchViewerArtifact } from "./doc-search-viewer.js";
import { buildDocBrief } from "./doc-brief.js";
import { buildDocBriefViewerArtifact } from "./doc-brief-viewer.js";
import { buildDocBundle } from "./doc-bundle.js";
import { buildDocBundleViewerArtifact } from "./doc-bundle-viewer.js";
import { buildDocBacklinksReport, type DocBacklinksInput } from "./doc-backlinks.js";
import { buildDocBacklinksViewerArtifact } from "./doc-backlinks-viewer.js";
import { buildDocCoverageReport } from "./doc-coverage.js";
import { buildDocEvidencePack } from "./doc-evidence-pack.js";
import { buildDocEvidencePackViewerArtifact } from "./doc-evidence-pack-viewer.js";
import { buildDocReferenceGraphReport } from "./doc-reference-graph.js";
import { buildDocReferenceGraphViewerArtifact } from "./doc-reference-graph-viewer.js";
import { buildDocRelatedReport } from "./doc-related.js";
import { buildDocRelatedViewerArtifact } from "./doc-related-viewer.js";
import { buildConfidenceReport } from "./confidence.js";
import { recall } from "./engine.js";
import { buildMemoryHandoff } from "./handoff.js";
import { buildMemoryHandoffViewerArtifact } from "./handoff-viewer.js";
import { buildWorkFrontier } from "./work-frontier.js";
import { buildWorkFrontierViewerArtifact } from "./work-frontier-viewer.js";
import {
  buildMemoryOperationalDashboard,
  buildMemoryOperationalDashboardArtifact,
} from "./operational-dashboard.js";
import { buildPathExplainReport } from "./path-explain.js";
import { buildHookCoverageReport } from "./hook-coverage.js";
import { buildHookCoverageViewerArtifact } from "./hook-coverage-viewer.js";
import { buildMemoryExtractionStatus } from "./extraction-status.js";
import { buildMemoryExtractionStatusViewerArtifact } from "./extraction-status-viewer.js";
import { buildMemoryGovernanceReport } from "./governance.js";
import { buildMemoryGovernanceViewerArtifact } from "./governance-viewer.js";
import { buildLearningDebtReport } from "./learning-debt.js";
import { buildLearningDebtViewerArtifact } from "./learning-debt-viewer.js";
import { buildMemoryHealthReport } from "./memory-health.js";
import { buildMemoryHealthViewerArtifact } from "./memory-health-viewer.js";
import { buildMemoryDecayReport } from "./memory-decay.js";
import { buildMemoryDecayViewerArtifact } from "./memory-decay-viewer.js";
import { buildMemoryLayersReport } from "./memory-layers.js";
import { buildMemoryLayersViewerArtifact } from "./memory-layers-viewer.js";
import { buildMemoryReferenceRadar } from "./references-radar.js";
import { buildOnboardingMap } from "./onboarding-map.js";
import { buildOnboardingMapViewerArtifact } from "./onboarding-map-viewer.js";
import { buildSessionTimeline } from "./session-timeline.js";
import { readSkillRollups } from "./skill-events.js";
import { buildReasoningReplay } from "./reasoning/reasoning-replay.js";
import { buildWhatifReport, parseWhatifChange, type WhatifChange } from "./whatif.js";
import { buildFederationReport } from "./federation.js";
import { runAutoCure, readAutoCureRunLog } from "./auto-curation.js";
import { buildMemorySmartSearch } from "./smart-search.js";
import { buildMemorySmartSearchViewerArtifact } from "./smart-search-viewer.js";
import { buildVectorSearchReport } from "./vector-search.js";
import { buildVectorStatusViewerArtifact } from "./vector-status-viewer.js";
import {
  buildMemoryWorkbench,
  buildMemoryWorkbenchArtifact,
} from "./workbench.js";
import {
  buildMemoryRoutingGuide,
  SUPPORTED_ROUTING_AGENTS,
  type MemoryRoutingAgent,
} from "./routing-guide.js";
import { buildMemoryRoutingGuideViewerArtifact } from "./routing-guide-viewer.js";

export interface MemoryHttpServerOptions {
  rootDir: string;
  store: MemoryStore;
  token?: string;
  now?: number;
}

export interface MemoryHttpHealth {
  schema_version: "memory.http.health.v1";
  read_only: true;
  root: string;
  auth: "none" | "bearer";
  endpoints: string[];
}

export interface MemoryOpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: "RedSkills Memory local HTTP API";
    version: "memory.http.v1";
    description: string;
  };
  servers: Array<{ url: string }>;
  security: Array<Record<string, string[]>>;
  paths: Record<string, unknown>;
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http";
        scheme: "bearer";
      };
    };
  };
}

const ENDPOINTS = [
  "GET /",
  "GET /workbench",
  "GET /assets?kind=<kind>",
  "GET /search?query=<text>",
  "GET /smart-search?query=<text>",
  "GET /context-pack?goal=<text>",
  "GET /dashboard",
  "GET /communities",
  "GET /docs/backlinks?query=<text>|label=<label>|rid=<rid>",
  "GET /docs/brief?query=<text>",
  "GET /docs/bundle?query=<text>",
  "GET /docs/evidence-pack?path=<path>|rid=<rid>",
  "GET /docs/reference-graph",
  "GET /docs/related?path=<path>|rid=<rid>",
  "GET /docs/search?query=<text>",
  "GET /extraction/status",
  "GET /governance",
  "GET /handoff?focus=<text>",
  "GET /frontier?focus=<text>",
  "GET /decay",
  "GET /routing-guide?agent=<agent>",
  "GET /integration-status?agent=<agent>",
  "GET /hooks/coverage",
  "GET /layers",
  "GET /learning-debt",
  "GET /memory/health",
  "GET /onboarding-map",
  "GET /openapi.json",
  "GET /vector/status",
  "GET /api/health",
  "GET /api/memory/health",
  "GET /api/openapi.json",
  "GET /api/assets?kind=<kind>",
  "GET /api/workbench",
  "GET /api/dashboard",
  "GET /api/references-radar",
  "GET /api/communities",
  "GET /api/context-pack?goal=<text>",
  "GET /api/extraction/status",
  "GET /api/governance",
  "GET /api/handoff?focus=<text>",
  "GET /api/frontier?focus=<text>",
  "GET /api/decay",
  "GET /api/routing-guide?agent=<agent>",
  "GET /api/integration-status?agent=<agent>",
  "GET /api/layers",
  "GET /api/learning-debt",
  "GET /api/onboarding-map",
  "GET /api/hooks/coverage",
  "GET /api/session/timeline?session=<id>",
  "GET /api/docs/brief?query=<text>",
  "GET /api/docs/bundle?query=<text>",
  "GET /api/docs/coverage",
  "GET /api/docs/backlinks?query=<text>|label=<label>|rid=<rid>",
  "GET /api/docs/evidence-pack?path=<path>|rid=<rid>",
  "GET /api/docs/reference-graph",
  "GET /api/docs/related?path=<path>|rid=<rid>",
  "GET /api/docs/search?query=<text>",
  "GET /api/docs/read?path=<path>|rid=<rid>",
  "GET /api/confidence?node=<rid>",
  "GET /api/path-explain?from=<label>&to=<label>",
  "GET /api/vector/status",
  "GET /api/vector/search?query=<text>",
  "GET /api/search?query=<text>",
  "GET /api/smart-search?query=<text>",
  "GET /api/recall?query=<text>",
  "GET /api/reasoning-replay?task=<text>",
  "GET /api/whatif?change=<descriptor>[&change=<descriptor>...] | POST /api/whatif",
  "GET /api/federate?query=<text>",
  "GET /api/autocure (dry-run) | POST /api/autocure (apply)",
];

export function createMemoryHttpServer(opts: MemoryHttpServerOptions): Server {
  return createServer(async (req, res) => {
    try {
      await handleRequest(req, res, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MemoryHttpServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const isAutocurePost = req.method === "POST" && url.pathname === "/api/autocure";
  const isWhatifPost = req.method === "POST" && url.pathname === "/api/whatif";
  if (req.method !== "GET" && req.method !== "HEAD" && !isAutocurePost && !isWhatifPost) {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  if (!publicEndpoint(url.pathname) && !authorized(req, opts.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (url.pathname === "/api/autocure") {
    const apply = isAutocurePost || url.searchParams.get("apply") === "true";
    const report = await runAutoCure(opts.store, {
      apply,
      staleDays: numberParam(url.searchParams.get("stale_days")),
      now: opts.now,
    });
    sendJson(res, 200, report);
    return;
  }

  if (url.pathname === "/api/autocure/runs") {
    const log = await readAutoCureRunLog(opts.store);
    sendJson(res, 200, log);
    return;
  }

  if (url.pathname === "/openapi.json" || url.pathname === "/api/openapi.json") {
    sendJson(res, 200, openApiDocument(opts));
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, health(opts));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/workbench") {
    const workbench = await buildMemoryWorkbench(opts.store, opts.rootDir, { now: opts.now });
    sendHtml(res, buildMemoryWorkbenchArtifact(workbench).html);
    return;
  }

  if (url.pathname === "/dashboard") {
    const dashboard = await buildMemoryOperationalDashboard(opts.store, opts.rootDir, {
      now: opts.now,
    });
    sendHtml(res, buildMemoryOperationalDashboardArtifact(dashboard).html);
    return;
  }

  if (url.pathname === "/assets") {
    const report = await buildMemoryAssetInventory(opts.store, {
      kind: url.searchParams.get("kind") ?? undefined,
      query: url.searchParams.get("query") ?? url.searchParams.get("q") ?? undefined,
    });
    sendHtml(res, buildMemoryAssetInventoryViewerArtifact(report).html);
    return;
  }

  if (url.pathname === "/search" || url.pathname === "/smart-search") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const report = await buildMemorySmartSearch(opts.store, query, {
      limit: numberParam(url.searchParams.get("limit")),
      depth: numberParam(url.searchParams.get("depth")),
      now: opts.now,
    });
    sendHtml(res, buildMemorySmartSearchViewerArtifact(report).html);
    return;
  }

  if (url.pathname === "/context-pack") {
    const goal = url.searchParams.get("goal") ?? url.searchParams.get("query") ?? "";
    if (!goal.trim()) {
      sendJson(res, 400, { error: "goal is required" });
      return;
    }
    const pack = await buildContextPack(opts.store, goal, {
      budgetChars: numberParam(url.searchParams.get("budget_chars")),
      limit: numberParam(url.searchParams.get("limit")),
      depth: numberParam(url.searchParams.get("depth")),
      now: opts.now,
    });
    sendHtml(res, buildContextPackViewerArtifact(pack).html);
    return;
  }

  if (url.pathname === "/docs/backlinks") {
    const input = docBacklinksInput(url);
    if (!input) {
      sendJson(res, 400, { error: "rid, label, title, or query is required" });
      return;
    }
    const report = await buildDocBacklinksReport(opts.store, input);
    sendHtml(res, buildDocBacklinksViewerArtifact(report).html);
    return;
  }

  if (url.pathname === "/docs/brief") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const brief = await buildDocBrief(opts.store, {
      query,
      limit: numberParam(url.searchParams.get("limit")),
      max_bytes: numberParam(url.searchParams.get("max_bytes")),
    });
    sendHtml(res, buildDocBriefViewerArtifact(brief).html);
    return;
  }

  if (url.pathname === "/docs/bundle") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const bundle = await buildDocBundle(opts.store, {
      query,
      limit: numberParam(url.searchParams.get("limit")),
      max_bytes: numberParam(url.searchParams.get("max_bytes")),
    });
    sendHtml(res, buildDocBundleViewerArtifact(bundle).html);
    return;
  }

  if (url.pathname === "/docs/evidence-pack") {
    const path = url.searchParams.get("path") ?? undefined;
    const rid = positiveIntParam(url.searchParams.get("rid"));
    if (!path && rid == null) {
      sendJson(res, 400, { error: "path or rid is required" });
      return;
    }
    const pack = await buildDocEvidencePack(opts.store, {
      path,
      rid,
      max_bytes: numberParam(url.searchParams.get("max_bytes")),
    });
    sendHtml(res, buildDocEvidencePackViewerArtifact(pack).html);
    return;
  }

  if (url.pathname === "/docs/search") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const report = await searchDocs(opts.store, query, {
      limit: numberParam(url.searchParams.get("limit")),
    });
    sendHtml(res, buildDocSearchViewerArtifact(report).html);
    return;
  }

  if (url.pathname === "/docs/reference-graph") {
    const report = await buildDocReferenceGraphReport(opts.store);
    sendHtml(res, buildDocReferenceGraphViewerArtifact(report).html);
    return;
  }

  if (url.pathname === "/docs/related") {
    const path = url.searchParams.get("path") ?? undefined;
    const rid = positiveIntParam(url.searchParams.get("rid"));
    if (!path && rid == null) {
      sendJson(res, 400, { error: "path or rid is required" });
      return;
    }
    const report = await buildDocRelatedReport(opts.store, { path, rid });
    sendHtml(res, buildDocRelatedViewerArtifact(report).html);
    return;
  }

  if (url.pathname === "/hooks/coverage") {
    const report = await buildHookCoverageReport(opts.rootDir);
    sendHtml(res, buildHookCoverageViewerArtifact(report).html);
    return;
  }

  if (url.pathname === "/extraction/status") {
    const status = await buildMemoryExtractionStatus(opts.store, opts.rootDir, { now: opts.now });
    sendHtml(res, buildMemoryExtractionStatusViewerArtifact(status).html);
    return;
  }

  if (url.pathname === "/api/workbench") {
    sendJson(res, 200, await buildMemoryWorkbench(opts.store, opts.rootDir, { now: opts.now }));
    return;
  }

  if (url.pathname === "/api/dashboard") {
    sendJson(
      res,
      200,
      await buildMemoryOperationalDashboard(opts.store, opts.rootDir, { now: opts.now }),
    );
    return;
  }

  if (url.pathname === "/api/communities") {
    sendJson(res, 200, await buildCommunityAnalytics(opts.store, { cache: "read-only" }));
    return;
  }

  if (url.pathname === "/api/context-pack") {
    const goal = url.searchParams.get("goal") ?? url.searchParams.get("query") ?? "";
    if (!goal.trim()) {
      sendJson(res, 400, { error: "goal is required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildContextPack(opts.store, goal, {
        budgetChars: numberParam(url.searchParams.get("budget_chars")),
        limit: numberParam(url.searchParams.get("limit")),
        depth: numberParam(url.searchParams.get("depth")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/communities") {
    sendHtml(
      res,
      buildCommunitiesViewerArtifact(
        await buildCommunityAnalytics(opts.store, { cache: "read-only" }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/references-radar") {
    sendJson(
      res,
      200,
      await buildMemoryReferenceRadar(opts.store, opts.rootDir, { now: opts.now }),
    );
    return;
  }

  if (url.pathname === "/api/extraction/status") {
    sendJson(
      res,
      200,
      await buildMemoryExtractionStatus(opts.store, opts.rootDir, { now: opts.now }),
    );
    return;
  }

  if (url.pathname === "/api/governance") {
    sendJson(
      res,
      200,
      await buildMemoryGovernanceReport(opts.store, {
        staleProgressDays: numberParam(url.searchParams.get("stale_progress_days")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/governance") {
    sendHtml(
      res,
      buildMemoryGovernanceViewerArtifact(
        await buildMemoryGovernanceReport(opts.store, {
          staleProgressDays: numberParam(url.searchParams.get("stale_progress_days")),
          now: opts.now,
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/handoff") {
    sendJson(
      res,
      200,
      await buildMemoryHandoff(opts.store, {
        focus: url.searchParams.get("focus") ?? url.searchParams.get("query") ?? undefined,
        limit: numberParam(url.searchParams.get("limit")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/handoff") {
    sendHtml(
      res,
      buildMemoryHandoffViewerArtifact(
        await buildMemoryHandoff(opts.store, {
          focus: url.searchParams.get("focus") ?? url.searchParams.get("query") ?? undefined,
          limit: numberParam(url.searchParams.get("limit")),
          now: opts.now,
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/frontier") {
    sendJson(
      res,
      200,
      await buildWorkFrontier(opts.store, {
        focus: url.searchParams.get("focus") ?? url.searchParams.get("query") ?? undefined,
        limit: numberParam(url.searchParams.get("limit")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/frontier") {
    sendHtml(
      res,
      buildWorkFrontierViewerArtifact(
        await buildWorkFrontier(opts.store, {
          focus: url.searchParams.get("focus") ?? url.searchParams.get("query") ?? undefined,
          limit: numberParam(url.searchParams.get("limit")),
          now: opts.now,
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/decay") {
    sendJson(
      res,
      200,
      await buildMemoryDecayReport(opts.store, {
        stale_days: numberParam(url.searchParams.get("stale_days")),
        deprecate_days: numberParam(url.searchParams.get("deprecate_days")),
        limit: numberParam(url.searchParams.get("limit")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/decay") {
    sendHtml(
      res,
      buildMemoryDecayViewerArtifact(
        await buildMemoryDecayReport(opts.store, {
          stale_days: numberParam(url.searchParams.get("stale_days")),
          deprecate_days: numberParam(url.searchParams.get("deprecate_days")),
          limit: numberParam(url.searchParams.get("limit")),
          now: opts.now,
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/routing-guide") {
    sendJson(
      res,
      200,
      buildMemoryRoutingGuide({ agent: routingAgentParam(url.searchParams.get("agent")) }),
    );
    return;
  }

  if (url.pathname === "/routing-guide") {
    sendHtml(
      res,
      buildMemoryRoutingGuideViewerArtifact(
        buildMemoryRoutingGuide({ agent: routingAgentParam(url.searchParams.get("agent")) }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/integration-status") {
    sendJson(
      res,
      200,
      await buildMemoryAgentIntegrationStatus(opts.rootDir, {
        agent: routingAgentParam(url.searchParams.get("agent")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/integration-status") {
    sendHtml(
      res,
      buildMemoryAgentIntegrationStatusViewerArtifact(
        await buildMemoryAgentIntegrationStatus(opts.rootDir, {
          agent: routingAgentParam(url.searchParams.get("agent")),
          now: opts.now,
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/layers") {
    sendJson(res, 200, await buildMemoryLayersReport(opts.store, { now: opts.now }));
    return;
  }

  if (url.pathname === "/api/memory/health") {
    sendJson(
      res,
      200,
      await buildMemoryHealthReport(opts.store, {
        stale_days: numberParam(url.searchParams.get("stale_days")),
      }),
    );
    return;
  }

  if (url.pathname === "/memory/health") {
    sendHtml(
      res,
      buildMemoryHealthViewerArtifact(
        await buildMemoryHealthReport(opts.store, {
          stale_days: numberParam(url.searchParams.get("stale_days")),
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/layers") {
    sendHtml(
      res,
      buildMemoryLayersViewerArtifact(
        await buildMemoryLayersReport(opts.store, { now: opts.now }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/learning-debt") {
    sendJson(
      res,
      200,
      await buildLearningDebtReport(opts.store, {
        staleDays: numberParam(url.searchParams.get("stale_days")),
        minRepeatedFailures: numberParam(url.searchParams.get("min_repeated_failures")),
        rollups: await safeSkillRollups(opts.store),
        skillTelemetryEnabled: true,
      }),
    );
    return;
  }

  if (url.pathname === "/learning-debt") {
    sendHtml(
      res,
      buildLearningDebtViewerArtifact(
        await buildLearningDebtReport(opts.store, {
          staleDays: numberParam(url.searchParams.get("stale_days")),
          minRepeatedFailures: numberParam(url.searchParams.get("min_repeated_failures")),
          rollups: await safeSkillRollups(opts.store),
          skillTelemetryEnabled: true,
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/onboarding-map") {
    sendJson(
      res,
      200,
      await buildOnboardingMap(opts.store, {
        staleDays: numberParam(url.searchParams.get("stale_days")),
        rollups: await safeSkillRollups(opts.store),
      }),
    );
    return;
  }

  if (url.pathname === "/onboarding-map") {
    sendHtml(
      res,
      buildOnboardingMapViewerArtifact(
        await buildOnboardingMap(opts.store, {
          staleDays: numberParam(url.searchParams.get("stale_days")),
          rollups: await safeSkillRollups(opts.store),
        }),
      ).html,
    );
    return;
  }

  if (url.pathname === "/api/hooks/coverage") {
    sendJson(res, 200, await buildHookCoverageReport(opts.rootDir));
    return;
  }

  if (url.pathname === "/api/session/timeline") {
    sendJson(
      res,
      200,
      await buildSessionTimeline(opts.store, {
        sessionId:
          url.searchParams.get("session") ??
          url.searchParams.get("session_id") ??
          undefined,
        limit: numberParam(url.searchParams.get("limit")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/api/assets") {
    sendJson(
      res,
      200,
      await buildMemoryAssetInventory(opts.store, {
        kind: url.searchParams.get("kind") ?? undefined,
        query: url.searchParams.get("query") ?? url.searchParams.get("q") ?? undefined,
      }),
    );
    return;
  }

  if (url.pathname === "/api/docs/coverage") {
    sendJson(res, 200, await buildDocCoverageReport(opts.store));
    return;
  }

  if (url.pathname === "/api/docs/brief") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildDocBrief(opts.store, {
        query,
        limit: numberParam(url.searchParams.get("limit")),
        max_bytes: numberParam(url.searchParams.get("max_bytes")),
      }),
    );
    return;
  }

  if (url.pathname === "/api/docs/bundle") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildDocBundle(opts.store, {
        query,
        limit: numberParam(url.searchParams.get("limit")),
        max_bytes: numberParam(url.searchParams.get("max_bytes")),
      }),
    );
    return;
  }

  if (url.pathname === "/api/docs/backlinks") {
    const input = docBacklinksInput(url);
    if (!input) {
      sendJson(res, 400, { error: "rid, label, title, or query is required" });
      return;
    }
    sendJson(res, 200, await buildDocBacklinksReport(opts.store, input));
    return;
  }

  if (url.pathname === "/api/docs/evidence-pack") {
    const path = url.searchParams.get("path") ?? undefined;
    const rid = positiveIntParam(url.searchParams.get("rid"));
    if (!path && rid == null) {
      sendJson(res, 400, { error: "path or rid is required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildDocEvidencePack(opts.store, {
        path,
        rid,
        max_bytes: numberParam(url.searchParams.get("max_bytes")),
      }),
    );
    return;
  }

  if (url.pathname === "/api/docs/reference-graph") {
    sendJson(res, 200, await buildDocReferenceGraphReport(opts.store));
    return;
  }

  if (url.pathname === "/api/docs/related") {
    const path = url.searchParams.get("path") ?? undefined;
    const rid = positiveIntParam(url.searchParams.get("rid"));
    if (!path && rid == null) {
      sendJson(res, 400, { error: "path or rid is required" });
      return;
    }
    sendJson(res, 200, await buildDocRelatedReport(opts.store, { path, rid }));
    return;
  }

  if (url.pathname === "/api/docs/search") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const limit = numberParam(url.searchParams.get("limit"));
    sendJson(res, 200, await searchDocs(opts.store, query, { limit }));
    return;
  }

  if (url.pathname === "/api/docs/read") {
    const path = url.searchParams.get("path") ?? undefined;
    const rid = positiveIntParam(url.searchParams.get("rid"));
    if (!path && rid == null) {
      sendJson(res, 400, { error: "path or rid is required" });
      return;
    }
    sendJson(
      res,
      200,
      await readDoc(opts.store, {
        path,
        rid,
        max_bytes: boundedIntParam(url.searchParams.get("max_bytes"), 200_000),
      }),
    );
    return;
  }

  if (url.pathname === "/api/confidence") {
    const nodeParam = url.searchParams.get("node") ?? url.searchParams.get("rid") ?? "";
    if (!nodeParam.trim()) {
      sendJson(res, 400, { error: "node is required" });
      return;
    }
    const report = await buildConfidenceReport(opts.store, nodeParam);
    if (!report) {
      sendJson(res, 404, { error: `no node with rid=${nodeParam}` });
      return;
    }
    sendJson(res, 200, report);
    return;
  }

  if (url.pathname === "/api/path-explain") {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (!from.trim() || !to.trim()) {
      sendJson(res, 400, { error: "from and to are required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildPathExplainReport(opts.store, {
        from,
        to,
        maxDepth: boundedIntParam(url.searchParams.get("max_depth"), 20),
      }),
    );
    return;
  }

  if (url.pathname === "/api/vector/status") {
    sendJson(res, 200, await opts.store.vectorStatus());
    return;
  }

  if (url.pathname === "/vector/status") {
    sendHtml(res, buildVectorStatusViewerArtifact(await opts.store.vectorStatus()).html);
    return;
  }

  if (url.pathname === "/api/vector/search") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildVectorSearchReport(opts.store, query, {
        limit: numberParam(url.searchParams.get("limit")),
      }),
    );
    return;
  }

  if (url.pathname === "/api/recall") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const limit = numberParam(url.searchParams.get("limit"));
    sendJson(res, 200, await recall(opts.store, query, { k: limit }));
    return;
  }

  if (url.pathname === "/api/federate") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildFederationReport(opts.rootDir, query, {
        limit: numberParam(url.searchParams.get("limit")),
        perRootLimit: numberParam(url.searchParams.get("per_root_limit")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/api/reasoning-replay") {
    const task = url.searchParams.get("task") ?? url.searchParams.get("query") ?? "";
    if (!task.trim()) {
      sendJson(res, 400, { error: "task is required" });
      return;
    }
    sendJson(
      res,
      200,
      await buildReasoningReplay(opts.store, task, {
        limit: numberParam(url.searchParams.get("limit")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/api/whatif") {
    const changes = await collectWhatifChanges(req, url);
    if (changes.length === 0) {
      sendJson(res, 400, {
        error: "at least one change is required (GET ?change=<descriptor> or POST {changes:[...]})",
      });
      return;
    }
    sendJson(
      res,
      200,
      await buildWhatifReport(opts.store, changes, {
        limit: numberParam(url.searchParams.get("limit")),
        now: opts.now,
      }),
    );
    return;
  }

  if (url.pathname === "/api/search" || url.pathname === "/api/smart-search") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const limit = numberParam(url.searchParams.get("limit"));
    sendJson(res, 200, await buildMemorySmartSearch(opts.store, query, { limit, now: opts.now }));
    return;
  }

  sendJson(res, 404, { error: "not found", endpoints: ENDPOINTS });
}

function health(opts: MemoryHttpServerOptions): MemoryHttpHealth {
  return {
    schema_version: "memory.http.health.v1",
    read_only: true,
    root: opts.rootDir,
    auth: opts.token ? "bearer" : "none",
    endpoints: ENDPOINTS,
  };
}

function openApiDocument(opts: MemoryHttpServerOptions): MemoryOpenApiDocument {
  const security = opts.token ? [{ bearerAuth: [] }] : [{}];
  const jsonResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { type: "object" } } },
  });
  const htmlResponse = (description: string) => ({
    description,
    content: { "text/html": { schema: { type: "string" } } },
  });
  const queryParam = {
    name: "query",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const optionalQueryParam = {
    name: "query",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const goalParam = {
    name: "goal",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const limitParam = {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100 },
  };
  const pathParam = {
    name: "path",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const ridParam = {
    name: "rid",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1 },
  };
  const maxBytesParam = {
    name: "max_bytes",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 200000 },
  };
  const fromParam = {
    name: "from",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const toParam = {
    name: "to",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const maxDepthParam = {
    name: "max_depth",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 20 },
  };
  const sessionParam = {
    name: "session",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const kindParam = {
    name: "kind",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const staleDaysParam = {
    name: "stale_days",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100 },
  };
  const staleProgressDaysParam = {
    name: "stale_progress_days",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1 },
  };
  const deprecateDaysParam = {
    name: "deprecate_days",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1 },
  };
  const agentParam = {
    name: "agent",
    in: "query",
    required: false,
    schema: { type: "string", enum: SUPPORTED_ROUTING_AGENTS },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "RedSkills Memory local HTTP API",
      version: "memory.http.v1",
      description:
        "Optional loopback-only read-only API over the project-local RedDB Memory store.",
    },
    servers: [{ url: "/" }],
    security,
    paths: {
      "/api/health": {
        get: { summary: "Health and endpoint discovery", responses: { "200": jsonResponse("Health") } },
      },
      "/api/memory/health": {
        get: {
          summary: "Memory operational health",
          parameters: [staleDaysParam],
          responses: { "200": jsonResponse("Memory health report") },
        },
      },
      "/memory/health": {
        get: {
          summary: "Memory operational health HTML",
          parameters: [staleDaysParam],
          responses: { "200": htmlResponse("Memory health viewer HTML") },
        },
      },
      "/openapi.json": {
        get: { summary: "OpenAPI contract", responses: { "200": jsonResponse("OpenAPI document") } },
      },
      "/api/openapi.json": {
        get: { summary: "OpenAPI contract", responses: { "200": jsonResponse("OpenAPI document") } },
      },
      "/": {
        get: { summary: "Memory Workbench HTML", responses: { "200": htmlResponse("Workbench HTML") } },
      },
      "/workbench": {
        get: { summary: "Memory Workbench HTML", responses: { "200": htmlResponse("Workbench HTML") } },
      },
      "/dashboard": {
        get: { summary: "Memory operational dashboard HTML", responses: { "200": htmlResponse("Dashboard HTML") } },
      },
      "/assets": {
        get: {
          summary: "Asset inventory HTML",
          parameters: [kindParam, optionalQueryParam],
          responses: { "200": htmlResponse("Asset inventory viewer HTML") },
        },
      },
      "/search": {
        get: {
          summary: "Smart search HTML",
          parameters: [queryParam, limitParam],
          responses: { "200": htmlResponse("Smart search viewer HTML") },
        },
      },
      "/smart-search": {
        get: {
          summary: "Smart search HTML",
          parameters: [queryParam, limitParam],
          responses: { "200": htmlResponse("Smart search viewer HTML") },
        },
      },
      "/docs/backlinks": {
        get: {
          summary: "Document backlinks HTML",
          parameters: [queryParam, ridParam],
          responses: { "200": htmlResponse("Doc backlinks viewer HTML") },
        },
      },
      "/docs/brief": {
        get: {
          summary: "Document brief HTML",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": htmlResponse("Doc brief viewer HTML") },
        },
      },
      "/docs/bundle": {
        get: {
          summary: "Document bundle HTML",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": htmlResponse("Doc bundle viewer HTML") },
        },
      },
      "/docs/evidence-pack": {
        get: {
          summary: "Document evidence pack HTML",
          parameters: [pathParam, ridParam, maxBytesParam],
          responses: { "200": htmlResponse("Doc evidence pack viewer HTML") },
        },
      },
      "/docs/reference-graph": {
        get: {
          summary: "Document reference graph HTML",
          responses: { "200": htmlResponse("Doc reference graph viewer HTML") },
        },
      },
      "/docs/related": {
        get: {
          summary: "Document related-docs HTML",
          parameters: [pathParam, ridParam],
          responses: { "200": htmlResponse("Doc related viewer HTML") },
        },
      },
      "/docs/search": {
        get: {
          summary: "Document search HTML",
          parameters: [queryParam, limitParam],
          responses: { "200": htmlResponse("Doc search viewer HTML") },
        },
      },
      "/hooks/coverage": {
        get: {
          summary: "Hook coverage HTML",
          responses: { "200": htmlResponse("Hook coverage viewer HTML") },
        },
      },
      "/extraction/status": {
        get: {
          summary: "Extraction status HTML",
          responses: { "200": htmlResponse("Extraction status viewer HTML") },
        },
      },
      "/api/workbench": {
        get: { summary: "Memory Workbench JSON", responses: { "200": jsonResponse("Workbench JSON") } },
      },
      "/api/dashboard": {
        get: { summary: "Memory operational dashboard JSON", responses: { "200": jsonResponse("Dashboard JSON") } },
      },
      "/api/references-radar": {
        get: { summary: "Memory references radar JSON", responses: { "200": jsonResponse("References radar JSON") } },
      },
      "/api/communities": {
        get: {
          summary: "Memory graph community analytics",
          responses: { "200": jsonResponse("Communities report") },
        },
      },
      "/communities": {
        get: {
          summary: "Memory graph communities HTML",
          responses: { "200": htmlResponse("Communities viewer HTML") },
        },
      },
      "/api/context-pack": {
        get: {
          summary: "Memory context pack JSON",
          parameters: [goalParam, optionalQueryParam, limitParam],
          responses: { "200": jsonResponse("Context pack") },
        },
      },
      "/context-pack": {
        get: {
          summary: "Memory context pack HTML",
          parameters: [goalParam, optionalQueryParam, limitParam],
          responses: { "200": htmlResponse("Context pack viewer HTML") },
        },
      },
      "/api/extraction/status": {
        get: { summary: "Memory extraction status", responses: { "200": jsonResponse("Extraction status report") } },
      },
      "/api/governance": {
        get: {
          summary: "Memory governance report",
          parameters: [staleProgressDaysParam],
          responses: { "200": jsonResponse("Governance report") },
        },
      },
      "/governance": {
        get: {
          summary: "Memory governance HTML",
          parameters: [staleProgressDaysParam],
          responses: { "200": htmlResponse("Governance viewer HTML") },
        },
      },
      "/api/handoff": {
        get: {
          summary: "Memory handoff report",
          parameters: [optionalQueryParam],
          responses: { "200": jsonResponse("Handoff report") },
        },
      },
      "/handoff": {
        get: {
          summary: "Memory handoff HTML",
          parameters: [optionalQueryParam],
          responses: { "200": htmlResponse("Handoff viewer HTML") },
        },
      },
      "/api/frontier": {
        get: {
          summary: "Memory work frontier report",
          parameters: [optionalQueryParam, limitParam],
          responses: { "200": jsonResponse("Work frontier report") },
        },
      },
      "/frontier": {
        get: {
          summary: "Memory work frontier HTML",
          parameters: [optionalQueryParam, limitParam],
          responses: { "200": htmlResponse("Work frontier viewer HTML") },
        },
      },
      "/api/decay": {
        get: {
          summary: "Memory decay plan",
          parameters: [staleDaysParam, deprecateDaysParam, limitParam],
          responses: { "200": jsonResponse("Memory decay plan") },
        },
      },
      "/decay": {
        get: {
          summary: "Memory decay plan HTML",
          parameters: [staleDaysParam, deprecateDaysParam, limitParam],
          responses: { "200": htmlResponse("Memory decay viewer HTML") },
        },
      },
      "/api/routing-guide": {
        get: {
          summary: "Memory routing guide",
          parameters: [agentParam],
          responses: { "200": jsonResponse("Memory routing guide") },
        },
      },
      "/routing-guide": {
        get: {
          summary: "Memory routing guide HTML",
          parameters: [agentParam],
          responses: { "200": htmlResponse("Memory routing guide viewer HTML") },
        },
      },
      "/api/integration-status": {
        get: {
          summary: "Memory agent integration status",
          parameters: [agentParam],
          responses: { "200": jsonResponse("Memory agent integration status") },
        },
      },
      "/integration-status": {
        get: {
          summary: "Memory agent integration status HTML",
          parameters: [agentParam],
          responses: { "200": htmlResponse("Memory agent integration status viewer HTML") },
        },
      },
      "/api/layers": {
        get: { summary: "Memory layers report", responses: { "200": jsonResponse("Memory layers report") } },
      },
      "/layers": {
        get: {
          summary: "Memory layers HTML",
          responses: { "200": htmlResponse("Memory layers viewer HTML") },
        },
      },
      "/api/learning-debt": {
        get: {
          summary: "Memory learning debt",
          responses: { "200": jsonResponse("Learning debt report") },
        },
      },
      "/learning-debt": {
        get: {
          summary: "Memory learning debt HTML",
          responses: { "200": htmlResponse("Learning debt viewer HTML") },
        },
      },
      "/api/onboarding-map": {
        get: {
          summary: "Memory onboarding map",
          parameters: [staleDaysParam],
          responses: { "200": jsonResponse("Onboarding map report") },
        },
      },
      "/onboarding-map": {
        get: {
          summary: "Memory onboarding map HTML",
          parameters: [staleDaysParam],
          responses: { "200": htmlResponse("Onboarding map viewer HTML") },
        },
      },
      "/api/hooks/coverage": {
        get: { summary: "Hook coverage report", responses: { "200": jsonResponse("Hook coverage report") } },
      },
      "/api/session/timeline": {
        get: {
          summary: "Session timeline report",
          parameters: [sessionParam, limitParam],
          responses: { "200": jsonResponse("Session timeline report") },
        },
      },
      "/api/assets": {
        get: {
          summary: "Binary document/media asset inventory",
          parameters: [kindParam, optionalQueryParam],
          responses: { "200": jsonResponse("Asset inventory report") },
        },
      },
      "/api/docs/coverage": {
        get: {
          summary: "Document graph and vector coverage",
          responses: { "200": jsonResponse("Doc coverage report") },
        },
      },
      "/api/docs/brief": {
        get: {
          summary: "Citation-first document evidence brief",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc brief") },
        },
      },
      "/api/docs/bundle": {
        get: {
          summary: "Agent-ready document bundle for a query",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc bundle") },
        },
      },
      "/api/docs/backlinks": {
        get: {
          summary: "Find indexed docs that reference a Memory node",
          parameters: [queryParam, ridParam],
          responses: { "200": jsonResponse("Doc backlinks report") },
        },
      },
      "/api/docs/evidence-pack": {
        get: {
          summary: "Agent-ready document evidence pack",
          parameters: [pathParam, ridParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc evidence pack") },
        },
      },
      "/api/docs/reference-graph": {
        get: {
          summary: "Document reference graph",
          responses: { "200": jsonResponse("Doc reference graph report") },
        },
      },
      "/api/docs/related": {
        get: {
          summary: "Find references and related docs for an ingested Memory doc",
          parameters: [pathParam, ridParam],
          responses: { "200": jsonResponse("Doc related report") },
        },
      },
      "/api/docs/search": {
        get: {
          summary: "Search ingested Memory docs",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Doc search result") },
        },
      },
      "/api/docs/read": {
        get: {
          summary: "Read an ingested Memory doc by path or rid",
          parameters: [pathParam, ridParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc read result") },
        },
      },
      "/api/confidence": {
        get: {
          summary: "Composed confidence breakdown for a Memory node (issue #167)",
          parameters: [
            {
              name: "node",
              in: "query",
              required: true,
              description: "Numeric rid of the Memory node",
              schema: { type: "string" },
            },
          ],
          responses: { "200": jsonResponse("Confidence breakdown") },
        },
      },
      "/api/path-explain": {
        get: {
          summary: "Explain a directed Memory graph path",
          parameters: [fromParam, toParam, maxDepthParam],
          responses: { "200": jsonResponse("Path explanation result") },
        },
      },
      "/api/vector/status": {
        get: {
          summary: "Read vector projection status",
          responses: { "200": jsonResponse("Vector status report") },
        },
      },
      "/vector/status": {
        get: {
          summary: "Vector projection status HTML",
          responses: { "200": htmlResponse("Vector status viewer HTML") },
        },
      },
      "/api/vector/search": {
        get: {
          summary: "Diagnostic vector search",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Vector search report") },
        },
      },
      "/api/recall": {
        get: {
          summary: "Governed Memory recall",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Recall result") },
        },
      },
      "/api/search": {
        get: {
          summary: "Memory smart search",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Smart search result") },
        },
      },
      "/api/smart-search": {
        get: {
          summary: "Memory smart search",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Smart search result") },
        },
      },
      "/api/federate": {
        get: {
          summary: "Federation cross-root read",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Federation result") },
        },
      },
      "/api/whatif": {
        get: {
          summary: "What-if blast radius (repeatable ?change=<descriptor>)",
          parameters: [
            {
              name: "change",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            limitParam,
          ],
          responses: { "200": jsonResponse("What-if report") },
        },
        post: {
          summary: "What-if blast radius (JSON body {changes:[...]} )",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": jsonResponse("What-if report") },
        },
      },
      "/api/reasoning-replay": {
        get: {
          summary: "Reasoning replay (similarity-ranked attempts)",
          parameters: [
            {
              name: "task",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            limitParam,
          ],
          responses: { "200": jsonResponse("Reasoning replay result") },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
}

function authorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function publicEndpoint(pathname: string): boolean {
  return pathname === "/api/health" || pathname === "/openapi.json" || pathname === "/api/openapi.json";
}

async function collectWhatifChanges(
  req: IncomingMessage,
  url: URL,
): Promise<WhatifChange[]> {
  const out: WhatifChange[] = [];
  for (const raw of url.searchParams.getAll("change")) {
    if (typeof raw === "string" && raw.trim()) out.push(parseWhatifChange(raw));
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    if (body.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return [];
      }
      const candidate = (parsed as { changes?: unknown }).changes;
      if (Array.isArray(candidate)) {
        for (const entry of candidate) {
          if (typeof entry === "string" && entry.trim()) {
            out.push(parseWhatifChange(entry));
          } else if (entry && typeof entry === "object") {
            const c = entry as Partial<WhatifChange>;
            if (c.kind && (c.file || c.symbol || c.description)) {
              out.push({
                kind: c.kind,
                file: c.file,
                symbol: c.symbol,
                with: c.with,
                description: c.description,
              });
            }
          }
        }
      }
    }
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function safeSkillRollups(store: MemoryStore) {
  try {
    return await readSkillRollups(store);
  } catch {
    return [];
  }
}

function docBacklinksInput(url: URL): DocBacklinksInput | null {
  const rid = positiveIntParam(url.searchParams.get("rid"));
  const label = url.searchParams.get("label") ?? undefined;
  const title = url.searchParams.get("title") ?? undefined;
  const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? undefined;
  if (rid == null && !label && !title && !query) return null;
  return { rid, label, title, query };
}

function routingAgentParam(value: string | null): MemoryRoutingAgent | undefined {
  if (!value) return undefined;
  return SUPPORTED_ROUTING_AGENTS.includes(value as MemoryRoutingAgent)
    ? (value as MemoryRoutingAgent)
    : undefined;
}

function numberParam(value: string | null): number | undefined {
  return boundedIntParam(value, 100);
}

function boundedIntParam(value: string | null, max: number): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(max, Math.floor(parsed));
}

function positiveIntParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return undefined;
  return parsed;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}
