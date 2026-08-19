import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { createMemoryHttpServer } from "../src/http-server.js";
import { indexFile } from "../src/ingest.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 30_000;
const roots: string[] = [];
const stores: MemoryStore[] = [];
const servers: ReturnType<typeof createMemoryHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "memory-http-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { hooks: true });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  const authRid = await store.upsertNode({
    label: "auth-service",
    node_type: "concept",
    properties: {
      title: "Auth service",
      content: "Auth service owns token policy.",
      confidence: "EXTRACTED",
      tier: "durable",
    },
  });
  const jwtRid = await store.upsertNode({
    label: "jwt-rotation",
    node_type: "decision",
    properties: {
      title: "JWT rotation",
      content: "JWT tokens rotate every 90 days in staging.",
      confidence: "EXTRACTED",
      tier: "durable",
    },
  });
  await store.upsertNode({
    label: "jwt-frontier-task",
    node_type: "task",
    properties: {
      title: "Ship JWT frontier task",
      content: "Ship JWT work frontier evidence.",
      status: "open",
      confidence: "EXTRACTED",
      tier: "durable",
    },
  });
  await store.upsertEdge({ from_rid: authRid, to_rid: jwtRid, label: "REFERENCES" });
  const doc = join(root, "docs", "jwt.md");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    doc,
    "# JWT Guide\n\nJWT rotation requires signed fixtures, `JWT_SECRET`, and incident review.\n",
    "utf8",
  );
  await indexFile(store, doc);
  const asset = join(root, "docs", "architecture.pdf");
  await writeFile(asset, Buffer.from("%PDF-1.4\narchitecture reference\n"));
  await indexFile(store, asset);
  return { root, store };
}

async function listen(root: string, store: MemoryStore, token?: string): Promise<string> {
  const server = createMemoryHttpServer({ rootDir: root, store, token, now: 1_700_000_000_000 });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: ReturnType<typeof createMemoryHttpServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Server spin-up is host-sensitive (port allocation, vitest-isolated workers);
// AFK feedback gates set RED_AFK_SKIP_PERF=1 to keep merge validation off the
// timing edge. Dev / CI runs without the var still exercise the suite.
const skipPerf = process.env.RED_AFK_SKIP_PERF === "1";

describe.skipIf(skipPerf)("Memory local HTTP server", () => {
  test(
    "serves health, workbench HTML, dashboard JSON, and recall JSON",
    async () => {
      const { root, store } = await graphRoot();
      const base = await listen(root, store);

      const health = await fetch(`${base}/api/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({
        schema_version: "memory.http.health.v1",
        read_only: true,
        auth: "none",
      });

      const openapi = await fetch(`${base}/openapi.json`);
      expect(openapi.status).toBe(200);
      expect(await openapi.json()).toMatchObject({
        openapi: "3.1.0",
        info: { version: "memory.http.v1" },
        paths: {
          "/api/assets": expect.any(Object),
          "/api/communities": expect.any(Object),
          "/api/references-radar": expect.any(Object),
          "/api/context-pack": expect.any(Object),
          "/api/decay": expect.any(Object),
          "/api/integration-status": expect.any(Object),
          "/api/docs/backlinks": expect.any(Object),
          "/api/docs/brief": expect.any(Object),
          "/api/docs/bundle": expect.any(Object),
          "/api/docs/coverage": expect.any(Object),
          "/api/docs/evidence-pack": expect.any(Object),
          "/api/docs/reference-graph": expect.any(Object),
          "/api/docs/related": expect.any(Object),
          "/api/docs/read": expect.any(Object),
          "/api/docs/search": expect.any(Object),
          "/assets": expect.any(Object),
          "/communities": expect.any(Object),
          "/context-pack": expect.any(Object),
          "/docs/backlinks": expect.any(Object),
          "/docs/brief": expect.any(Object),
          "/docs/bundle": expect.any(Object),
          "/docs/evidence-pack": expect.any(Object),
          "/docs/reference-graph": expect.any(Object),
          "/docs/related": expect.any(Object),
          "/docs/search": expect.any(Object),
          "/decay": expect.any(Object),
          "/routing-guide": expect.any(Object),
          "/integration-status": expect.any(Object),
          "/extraction/status": expect.any(Object),
          "/governance": expect.any(Object),
          "/handoff": expect.any(Object),
          "/frontier": expect.any(Object),
          "/hooks/coverage": expect.any(Object),
          "/layers": expect.any(Object),
          "/learning-debt": expect.any(Object),
          "/memory/health": expect.any(Object),
          "/onboarding-map": expect.any(Object),
          "/search": expect.any(Object),
          "/smart-search": expect.any(Object),
          "/api/extraction/status": expect.any(Object),
          "/api/governance": expect.any(Object),
          "/api/handoff": expect.any(Object),
          "/api/frontier": expect.any(Object),
          "/api/routing-guide": expect.any(Object),
          "/api/hooks/coverage": expect.any(Object),
          "/api/layers": expect.any(Object),
          "/api/learning-debt": expect.any(Object),
          "/api/memory/health": expect.any(Object),
          "/api/onboarding-map": expect.any(Object),
          "/api/path-explain": expect.any(Object),
          "/api/session/timeline": expect.any(Object),
          "/api/vector/search": expect.any(Object),
          "/api/vector/status": expect.any(Object),
          "/vector/status": expect.any(Object),
          "/api/search": expect.any(Object),
          "/api/recall": expect.any(Object),
        },
      });

      const html = await fetch(`${base}/workbench`);
      expect(html.status).toBe(200);
      expect(html.headers.get("content-type")).toContain("text/html");
      expect(html.headers.get("content-security-policy")).toContain("connect-src 'self'");
      const htmlBody = await html.text();
      expect(htmlBody).toContain("Memory Workbench");
      expect(htmlBody).toContain("memory-search-form");
      expect(htmlBody).toContain("memory-smart-search-link");
      expect(htmlBody).toContain('href="/search?query=memory"');
      expect(htmlBody).toContain("memory-context-pack-form");
      expect(htmlBody).toContain('href="/context-pack?goal=memory"');
      expect(htmlBody).toContain("Open Context Pack");
      expect(htmlBody).toContain("memory-docs-form");
      expect(htmlBody).toContain("memory-docs-search-link");
      expect(htmlBody).toContain('href="/docs/search?query=memory"');
      expect(htmlBody).toContain("memory-docs-brief-button");
      expect(htmlBody).toContain("memory-docs-brief-link");
      expect(htmlBody).toContain('href="/docs/brief?query=memory"');
      expect(htmlBody).toContain("memory-docs-bundle-link");
      expect(htmlBody).toContain('href="/docs/bundle?query=memory"');
      expect(htmlBody).toContain("memory-assets-link");
      expect(htmlBody).toContain('href="/assets"');
      expect(htmlBody).toContain("/docs/evidence-pack?rid=");
      expect(htmlBody).toContain("memory-docs-coverage-refresh");
      expect(htmlBody).toContain("memory-docs-reference-graph-refresh");
      expect(htmlBody).toContain('href="/docs/reference-graph"');
      expect(htmlBody).toContain("memory-path-form");
      expect(htmlBody).toContain("memory-onboarding-refresh");
      expect(htmlBody).toContain('href="/onboarding-map"');
      expect(htmlBody).toContain("Open Onboarding Map");
      expect(htmlBody).toContain("memory-communities-refresh");
      expect(htmlBody).toContain('href="/communities"');
      expect(htmlBody).toContain("Open Communities");
      expect(htmlBody).toContain("memory-vector-form");
      expect(htmlBody).toContain('href="/vector/status"');
      expect(htmlBody).toContain("Open Vector Status");
      expect(htmlBody).toContain("memory-extraction-refresh");
      expect(htmlBody).toContain('href="/extraction/status"');
      expect(htmlBody).toContain("Open Extraction Status");
      expect(htmlBody).toContain("memory-governance-refresh");
      expect(htmlBody).toContain('href="/governance"');
      expect(htmlBody).toContain("Open Governance");
      expect(htmlBody).toContain("memory-decay-refresh");
      expect(htmlBody).toContain('href="/decay"');
      expect(htmlBody).toContain("Open Decay");
      expect(htmlBody).toContain("memory-handoff-form");
      expect(htmlBody).toContain('href="/handoff"');
      expect(htmlBody).toContain("Open Handoff");
      expect(htmlBody).toContain("memory-frontier-form");
      expect(htmlBody).toContain('href="/frontier"');
      expect(htmlBody).toContain("Open Frontier");
      expect(htmlBody).toContain("memory-routing-guide-form");
      expect(htmlBody).toContain('href="/routing-guide?agent=codex"');
      expect(htmlBody).toContain("Open Routing Guide");
      expect(htmlBody).toContain("memory-agent-integration-refresh");
      expect(htmlBody).toContain('href="/integration-status"');
      expect(htmlBody).toContain("Open Integration Status");
      expect(htmlBody).toContain("memory-learning-debt-refresh");
      expect(htmlBody).toContain('href="/learning-debt"');
      expect(htmlBody).toContain("Open Learning Debt");
      expect(htmlBody).toContain("memory-health-refresh");
      expect(htmlBody).toContain('href="/memory/health"');
      expect(htmlBody).toContain("Open Memory Health");
      expect(htmlBody).toContain("memory-hooks-form");
      expect(htmlBody).toContain('href="/hooks/coverage"');
      expect(htmlBody).toContain("memory-layers-refresh");
      expect(htmlBody).toContain('href="/layers"');
      expect(htmlBody).toContain("Open Memory Layers");

      const dashboard = await fetch(`${base}/api/dashboard`);
      expect(dashboard.status).toBe(200);
      expect(await dashboard.json()).toMatchObject({
        schema_version: "memory.operational_dashboard.v1",
        read_only: true,
        decay: expect.any(Object),
        sources: {
          decay_plan: { schema_version: "memory.decay_plan.v1" },
        },
      });

      const referenceGraphHtml = await fetch(`${base}/docs/reference-graph`);
      expect(referenceGraphHtml.status).toBe(200);
      expect(referenceGraphHtml.headers.get("content-type")).toContain("text/html");
      const referenceGraphHtmlBody = await referenceGraphHtml.text();
      expect(referenceGraphHtmlBody).toContain("Documentation Reference Graph");
      expect(referenceGraphHtmlBody).toContain('id="doc-reference-graph-data"');
      expect(referenceGraphHtmlBody).toContain("<svg");

      const backlinksHtml = await fetch(`${base}/docs/backlinks?query=JWT_SECRET`);
      expect(backlinksHtml.status).toBe(200);
      expect(backlinksHtml.headers.get("content-type")).toContain("text/html");
      const backlinksHtmlBody = await backlinksHtml.text();
      expect(backlinksHtmlBody).toContain("Documentation Backlinks");
      expect(backlinksHtmlBody).toContain('id="doc-backlinks-data"');

      const radar = await fetch(`${base}/api/references-radar`);
      expect(radar.status).toBe(200);
      expect(await radar.json()).toMatchObject({
        schema_version: "memory.reference_radar.v1",
        read_only: true,
        summary: { references: 5 },
      });

      const communities = await fetch(`${base}/api/communities`);
      expect(communities.status).toBe(200);
      expect(await communities.json()).toMatchObject({
        schema_version: "memory.communities.v1",
        read_only: true,
        assignments: expect.any(Array),
        communities: expect.any(Array),
      });

      const communitiesViewer = await fetch(`${base}/communities`);
      expect(communitiesViewer.status).toBe(200);
      expect(communitiesViewer.headers.get("content-type")).toContain("text/html");
      const communitiesViewerHtml = await communitiesViewer.text();
      expect(communitiesViewerHtml).toContain("Graph Communities");
      expect(communitiesViewerHtml).toContain('id="communities-data"');

      const contextPack = await fetch(`${base}/api/context-pack?goal=jwt%20rotation`);
      expect(contextPack.status).toBe(200);
      expect(await contextPack.json()).toMatchObject({
        goal: "jwt rotation",
        status: "ok",
        markdown: expect.stringContaining("Memory context pack"),
      });

      const contextPackViewer = await fetch(`${base}/context-pack?goal=jwt%20rotation`);
      expect(contextPackViewer.status).toBe(200);
      expect(contextPackViewer.headers.get("content-type")).toContain("text/html");
      const contextPackViewerHtml = await contextPackViewer.text();
      expect(contextPackViewerHtml).toContain("Memory Context Pack");
      expect(contextPackViewerHtml).toContain('id="memory-context-pack-data"');

      const extraction = await fetch(`${base}/api/extraction/status`);
      expect(extraction.status).toBe(200);
      expect(await extraction.json()).toMatchObject({
        schema_version: "memory.extraction_status.v1",
        read_only: true,
        deterministic: { structured_transcript: true },
        inferred: { hook_stop_enabled: true },
      });

      const extractionViewer = await fetch(`${base}/extraction/status`);
      expect(extractionViewer.status).toBe(200);
      expect(extractionViewer.headers.get("content-type")).toContain("text/html");
      const extractionViewerHtml = await extractionViewer.text();
      expect(extractionViewerHtml).toContain("Extraction Status");
      expect(extractionViewerHtml).toContain("Inferred Extraction");
      expect(extractionViewerHtml).toContain('id="extraction-status-data"');

      const governance = await fetch(`${base}/api/governance`);
      expect(governance.status).toBe(200);
      expect(await governance.json()).toMatchObject({
        schema_version: "memory.governance.v1",
        read_only: true,
        summary: expect.any(Object),
        tidy_availability: {
          status: "unavailable",
          reason: "no AI provider configured for governance tidy",
          next_action: expect.stringContaining("deterministic governance remains available"),
        },
      });

      const governanceViewer = await fetch(`${base}/governance`);
      expect(governanceViewer.status).toBe(200);
      expect(governanceViewer.headers.get("content-type")).toContain("text/html");
      const governanceViewerHtml = await governanceViewer.text();
      expect(governanceViewerHtml).toContain("Memory Governance");
      expect(governanceViewerHtml).toContain('id="memory-governance-data"');
      expect(governanceViewerHtml).toContain("Tidy availability");

      const decay = await fetch(`${base}/api/decay`);
      expect(decay.status).toBe(200);
      expect(await decay.json()).toMatchObject({
        schema_version: "memory.decay_plan.v1",
        read_only: true,
        summary: expect.any(Object),
      });

      const decayViewer = await fetch(`${base}/decay`);
      expect(decayViewer.status).toBe(200);
      expect(decayViewer.headers.get("content-type")).toContain("text/html");
      const decayViewerHtml = await decayViewer.text();
      expect(decayViewerHtml).toContain("Memory Decay Plan");
      expect(decayViewerHtml).toContain('id="memory-decay-data"');

      const routingGuide = await fetch(`${base}/api/routing-guide?agent=cursor`);
      expect(routingGuide.status).toBe(200);
      expect(await routingGuide.json()).toMatchObject({
        schemaVersion: "memory.routing_guide.v1",
        agent: "cursor",
        integration: { displayName: "Cursor" },
      });

      const routingGuideViewer = await fetch(`${base}/routing-guide?agent=cursor`);
      expect(routingGuideViewer.status).toBe(200);
      expect(routingGuideViewer.headers.get("content-type")).toContain("text/html");
      const routingGuideViewerHtml = await routingGuideViewer.text();
      expect(routingGuideViewerHtml).toContain("Memory Routing Guide");
      expect(routingGuideViewerHtml).toContain('id="memory-routing-guide-data"');

      const integrationStatus = await fetch(`${base}/api/integration-status?agent=codex`);
      expect(integrationStatus.status).toBe(200);
      expect(await integrationStatus.json()).toMatchObject({
        schema_version: "memory.agent_integration_status.v1",
        read_only: true,
        summary: { agents: 1 },
      });

      const integrationStatusViewer = await fetch(`${base}/integration-status?agent=codex`);
      expect(integrationStatusViewer.status).toBe(200);
      expect(integrationStatusViewer.headers.get("content-type")).toContain("text/html");
      const integrationStatusViewerHtml = await integrationStatusViewer.text();
      expect(integrationStatusViewerHtml).toContain("Memory Agent Integration Status");
      expect(integrationStatusViewerHtml).toContain('id="memory-agent-integration-status-data"');

      const handoff = await fetch(`${base}/api/handoff?focus=jwt`);
      expect(handoff.status).toBe(200);
      expect(await handoff.json()).toMatchObject({
        schema_version: "memory.handoff.v1",
        read_only: true,
      });

      const handoffViewer = await fetch(`${base}/handoff?focus=jwt`);
      expect(handoffViewer.status).toBe(200);
      expect(handoffViewer.headers.get("content-type")).toContain("text/html");
      const handoffViewerHtml = await handoffViewer.text();
      expect(handoffViewerHtml).toContain("Memory Handoff");
      expect(handoffViewerHtml).toContain('id="memory-handoff-data"');

      const frontier = await fetch(`${base}/api/frontier?focus=jwt`);
      expect(frontier.status).toBe(200);
      expect(await frontier.json()).toMatchObject({
        schema_version: "memory.work_frontier.v1",
        read_only: true,
        status: "ready",
        summary: { ready: 1 },
      });

      const frontierViewer = await fetch(`${base}/frontier?focus=jwt`);
      expect(frontierViewer.status).toBe(200);
      expect(frontierViewer.headers.get("content-type")).toContain("text/html");
      const frontierViewerHtml = await frontierViewer.text();
      expect(frontierViewerHtml).toContain("Memory Work Frontier");
      expect(frontierViewerHtml).toContain('id="memory-work-frontier-data"');

      const hooks = await fetch(`${base}/api/hooks/coverage`);
      expect(hooks.status).toBe(200);
      expect(await hooks.json()).toMatchObject({
        schema_version: "memory.hook_coverage.v1",
        read_only: true,
        config_found: true,
      });

      const layers = await fetch(`${base}/api/layers`);
      expect(layers.status).toBe(200);
      expect(await layers.json()).toMatchObject({
        schema_version: "memory.memory_layers.v1",
        read_only: true,
        summary: { total_layers: 5 },
      });

      const layersViewer = await fetch(`${base}/layers`);
      expect(layersViewer.status).toBe(200);
      expect(layersViewer.headers.get("content-type")).toContain("text/html");
      const layersViewerHtml = await layersViewer.text();
      expect(layersViewerHtml).toContain("Memory Layers");
      expect(layersViewerHtml).toContain('id="memory-layers-data"');

      const memoryHealth = await fetch(`${base}/api/memory/health`);
      expect(memoryHealth.status).toBe(200);
      expect(await memoryHealth.json()).toMatchObject({
        schema_version: "memory.health.v1",
        read_only: true,
        stats: expect.any(Object),
      });

      const memoryHealthViewer = await fetch(`${base}/memory/health`);
      expect(memoryHealthViewer.status).toBe(200);
      expect(memoryHealthViewer.headers.get("content-type")).toContain("text/html");
      const memoryHealthViewerHtml = await memoryHealthViewer.text();
      expect(memoryHealthViewerHtml).toContain("Memory Health");
      expect(memoryHealthViewerHtml).toContain('id="memory-health-data"');

      const learningDebt = await fetch(`${base}/api/learning-debt`);
      expect(learningDebt.status).toBe(200);
      expect(await learningDebt.json()).toMatchObject({
        schema_version: "memory.learning_debt.v1",
        read_only: true,
        summary: expect.any(Object),
      });

      const learningDebtViewer = await fetch(`${base}/learning-debt`);
      expect(learningDebtViewer.status).toBe(200);
      expect(learningDebtViewer.headers.get("content-type")).toContain("text/html");
      const learningDebtViewerHtml = await learningDebtViewer.text();
      expect(learningDebtViewerHtml).toContain("Learning Debt");
      expect(learningDebtViewerHtml).toContain('id="learning-debt-data"');

      const onboarding = await fetch(`${base}/api/onboarding-map`);
      expect(onboarding.status).toBe(200);
      expect(await onboarding.json()).toMatchObject({
        schema_version: "memory.onboarding_map.v1",
        read_only: true,
        sections: expect.any(Object),
        markdown: expect.stringContaining("Memory onboarding map"),
      });

      const onboardingViewer = await fetch(`${base}/onboarding-map`);
      expect(onboardingViewer.status).toBe(200);
      expect(onboardingViewer.headers.get("content-type")).toContain("text/html");
      const onboardingViewerHtml = await onboardingViewer.text();
      expect(onboardingViewerHtml).toContain("Onboarding Map");
      expect(onboardingViewerHtml).toContain('id="onboarding-map-data"');

      const timeline = await fetch(`${base}/api/session/timeline?limit=10`);
      expect(timeline.status).toBe(200);
      expect(await timeline.json()).toMatchObject({
        schema_version: "memory.session_timeline.v1",
        read_only: true,
        filter: { limit: 10 },
      });

      const assets = await fetch(`${base}/api/assets`);
      expect(assets.status).toBe(200);
      expect(await assets.json()).toMatchObject({
        schema_version: "memory.asset_inventory.v1",
        read_only: true,
        total_assets: 1,
        assets: [expect.objectContaining({ asset_kind: "document" })],
      });

      const assetsViewer = await fetch(`${base}/assets`);
      expect(assetsViewer.status).toBe(200);
      const assetsViewerHtml = await assetsViewer.text();
      expect(assetsViewerHtml).toContain("Asset Inventory");
      expect(assetsViewerHtml).toContain("architecture.pdf");
      expect(assetsViewerHtml).toContain('id="asset-inventory-data"');

      const hookCoverageViewer = await fetch(`${base}/hooks/coverage`);
      expect(hookCoverageViewer.status).toBe(200);
      const hookCoverageViewerHtml = await hookCoverageViewer.text();
      expect(hookCoverageViewerHtml).toContain("Hook Coverage");
      expect(hookCoverageViewerHtml).toContain("claude");
      expect(hookCoverageViewerHtml).toContain('id="hook-coverage-data"');

      const smartSearchViewer = await fetch(`${base}/search?query=architecture%20pdf`);
      expect(smartSearchViewer.status).toBe(200);
      const smartSearchViewerHtml = await smartSearchViewer.text();
      expect(smartSearchViewerHtml).toContain("Smart Search");
      expect(smartSearchViewerHtml).toContain("architecture.pdf");
      expect(smartSearchViewerHtml).toContain('id="smart-search-data"');

      const docCoverage = await fetch(`${base}/api/docs/coverage`);
      expect(docCoverage.status).toBe(200);
      expect(await docCoverage.json()).toMatchObject({
        schema_version: "memory.doc_coverage.v1",
        read_only: true,
        total_docs: 1,
        grounded_docs: 1,
      });

      const docReferenceGraph = await fetch(`${base}/api/docs/reference-graph`);
      expect(docReferenceGraph.status).toBe(200);
      expect(await docReferenceGraph.json()).toMatchObject({
        schema_version: "memory.doc_reference_graph.v1",
        read_only: true,
        total_docs: 1,
        grounded_docs: 1,
        nodes: expect.arrayContaining([expect.objectContaining({ kind: "doc" })]),
      });

      const docs = await fetch(`${base}/api/docs/search?query=jwt%20fixtures`);
      expect(docs.status).toBe(200);
      const docsBody = await docs.json() as {
        total_docs: number;
        hits: Array<{ rid: number; path: string; excerpt: string }>;
      };
      expect(docsBody.total_docs).toBe(1);
      expect(docsBody.hits[0]).toMatchObject({
        path: join(root, "docs", "jwt.md"),
        excerpt: expect.stringContaining("JWT rotation requires signed fixtures"),
      });

      const docSearchViewer = await fetch(`${base}/docs/search?query=jwt%20fixtures&limit=2`);
      expect(docSearchViewer.status).toBe(200);
      const docSearchViewerHtml = await docSearchViewer.text();
      expect(docSearchViewerHtml).toContain("Documentation Search");
      expect(docSearchViewerHtml).toContain("JWT Guide");
      expect(docSearchViewerHtml).toContain('id="doc-search-data"');

      const docBundle = await fetch(`${base}/api/docs/bundle?query=jwt%20fixtures&limit=2`);
      expect(docBundle.status).toBe(200);
      expect(await docBundle.json()).toMatchObject({
        schema_version: "memory.doc_bundle.v1",
        read_only: true,
        query: "jwt fixtures",
        hits: [expect.objectContaining({ path: join(root, "docs", "jwt.md") })],
        packs: [expect.objectContaining({ found: true })],
        markdown: expect.stringContaining("Memory Docs Bundle"),
      });

      const docBrief = await fetch(`${base}/api/docs/brief?query=jwt%20fixtures&limit=2`);
      expect(docBrief.status).toBe(200);
      expect(await docBrief.json()).toMatchObject({
        schema_version: "memory.doc_brief.v1",
        read_only: true,
        query: "jwt fixtures",
        status: "partial",
        citations: [
          expect.objectContaining({
            marker: "[D1]",
            path: join(root, "docs", "jwt.md"),
          }),
        ],
        markdown: expect.stringContaining("Memory Docs Brief"),
      });

      const docBriefViewer = await fetch(`${base}/docs/brief?query=jwt%20fixtures&limit=2`);
      expect(docBriefViewer.status).toBe(200);
      const docBriefViewerHtml = await docBriefViewer.text();
      expect(docBriefViewerHtml).toContain("Documentation Brief");
      expect(docBriefViewerHtml).toContain("JWT Guide");
      expect(docBriefViewerHtml).toContain('id="doc-brief-data"');

      const docBundleViewer = await fetch(`${base}/docs/bundle?query=jwt%20fixtures&limit=2`);
      expect(docBundleViewer.status).toBe(200);
      const docBundleViewerHtml = await docBundleViewer.text();
      expect(docBundleViewerHtml).toContain("Documentation Bundle");
      expect(docBundleViewerHtml).toContain("JWT Guide");
      expect(docBundleViewerHtml).toContain('id="doc-bundle-data"');

      const docRelated = await fetch(`${base}/api/docs/related?rid=${docsBody.hits[0]?.rid}`);
      expect(docRelated.status).toBe(200);
      expect(await docRelated.json()).toMatchObject({
        schema_version: "memory.doc_related.v1",
        read_only: true,
        found: true,
      });

      const docRelatedViewer = await fetch(`${base}/docs/related?rid=${docsBody.hits[0]?.rid}`);
      expect(docRelatedViewer.status).toBe(200);
      const docRelatedViewerHtml = await docRelatedViewer.text();
      expect(docRelatedViewerHtml).toContain("Related Documentation");
      expect(docRelatedViewerHtml).toContain("JWT Guide");
      expect(docRelatedViewerHtml).toContain('id="doc-related-data"');

      const docBacklinks = await fetch(`${base}/api/docs/backlinks?query=JWT_SECRET`);
      expect(docBacklinks.status).toBe(200);
      expect(await docBacklinks.json()).toMatchObject({
        schema_version: "memory.doc_backlinks.v1",
        read_only: true,
        found: true,
        docs: [expect.objectContaining({ path: join(root, "docs", "jwt.md") })],
      });

      const docEvidencePack = await fetch(
        `${base}/api/docs/evidence-pack?rid=${docsBody.hits[0]?.rid}&max_bytes=120`,
      );
      expect(docEvidencePack.status).toBe(200);
      expect(await docEvidencePack.json()).toMatchObject({
        schema_version: "memory.doc_evidence_pack.v1",
        read_only: true,
        found: true,
        doc: expect.objectContaining({ path: join(root, "docs", "jwt.md") }),
        markdown: expect.stringContaining("Memory Doc Evidence Pack"),
      });

      const docEvidencePackViewer = await fetch(
        `${base}/docs/evidence-pack?rid=${docsBody.hits[0]?.rid}&max_bytes=120`,
      );
      expect(docEvidencePackViewer.status).toBe(200);
      const docEvidencePackViewerHtml = await docEvidencePackViewer.text();
      expect(docEvidencePackViewerHtml).toContain("Doc Evidence Pack");
      expect(docEvidencePackViewerHtml).toContain("JWT Guide");
      expect(docEvidencePackViewerHtml).toContain('id="doc-evidence-pack-data"');

      const docRead = await fetch(
        `${base}/api/docs/read?rid=${docsBody.hits[0]?.rid}&max_bytes=30`,
      );
      expect(docRead.status).toBe(200);
      expect(await docRead.json()).toMatchObject({
        found: true,
        matched_by: "rid",
        path: join(root, "docs", "jwt.md"),
        truncated: true,
      });

      const path = await fetch(
        `${base}/api/path-explain?from=auth-service&to=jwt-rotation&max_depth=4`,
      );
      expect(path.status).toBe(200);
      expect(await path.json()).toMatchObject({
        schema_version: "memory.path_explain.v1",
        read_only: true,
        reachable: true,
        hop_count: 1,
        edges: [expect.objectContaining({ label: "REFERENCES" })],
      });

      const vectorStatus = await fetch(`${base}/api/vector/status`);
      expect(vectorStatus.status).toBe(200);
      expect(await vectorStatus.json()).toMatchObject({
        schema_version: "memory.vector_status.v1",
        read_only: true,
        total: expect.any(Number),
        ready: expect.any(Number),
        unavailable: expect.any(Number),
      });

      const vectorStatusViewer = await fetch(`${base}/vector/status`);
      expect(vectorStatusViewer.status).toBe(200);
      expect(vectorStatusViewer.headers.get("content-type")).toContain("text/html");
      const vectorStatusViewerHtml = await vectorStatusViewer.text();
      expect(vectorStatusViewerHtml).toContain("Vector Status");
      expect(vectorStatusViewerHtml).toContain("Documentation Chunks");
      expect(vectorStatusViewerHtml).toContain('id="vector-status-data"');

      const vectorSearch = await fetch(`${base}/api/vector/search?query=jwt%20rotation`);
      expect(vectorSearch.status).toBe(200);
      expect(await vectorSearch.json()).toMatchObject({
        query: "jwt rotation",
        read_only: true,
        status: expect.stringMatching(/available|unavailable/),
      });

      const recall = await fetch(`${base}/api/recall?query=jwt%20rotation`);
      expect(recall.status).toBe(200);
      const body = await recall.json() as { query: string; nodes: Array<{ label: string }> };
      expect(body.query).toBe("jwt rotation");
      expect(body.nodes.some((node) => node.label === "jwt-rotation")).toBe(true);

      const search = await fetch(`${base}/api/search?query=jwt%20rotation`);
      expect(search.status).toBe(200);
      const searchBody = await search.json() as { top_results: unknown[] };
      expect(searchBody).toMatchObject({
        schema_version: "memory.smart_search.v1",
        read_only: true,
        query: "jwt rotation",
      });
      expect(searchBody.top_results.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "requires bearer auth when a token is configured",
    async () => {
      const { root, store } = await graphRoot();
      const base = await listen(root, store, "secret-token");

      const health = await fetch(`${base}/api/health`);
      expect(await health.json()).toMatchObject({ auth: "bearer" });

      const openapi = await fetch(`${base}/api/openapi.json`);
      expect(openapi.status).toBe(200);
      expect(await openapi.json()).toMatchObject({
        security: [{ bearerAuth: [] }],
      });

      const denied = await fetch(`${base}/api/recall?query=jwt`);
      expect(denied.status).toBe(401);

      const allowed = await fetch(`${base}/api/recall?query=jwt`, {
        headers: { authorization: "Bearer secret-token" },
      });
      expect(allowed.status).toBe(200);
      const body = await allowed.json() as { nodes: unknown[] };
      expect(body.nodes.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
