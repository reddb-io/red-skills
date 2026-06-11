import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { indexFile } from "../src/ingest.js";
import { initGraph } from "../src/init.js";
import { appendMemoryEvent, hookLifecycleToMemoryEvent } from "../src/memory-events.js";
import {
  buildMemoryWorkbench,
  buildMemoryWorkbenchArtifact,
} from "../src/workbench.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "memory-workbench-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { hooks: true, skillTelemetry: true });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  return { root, store };
}

async function seedDoc(root: string, store: MemoryStore): Promise<void> {
  const doc = join(root, "docs/security.md");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    doc,
    "# Security\n\nJWT rotation references `JWT_SECRET` and signed fixtures.\n",
    "utf8",
  );
  await indexFile(store, doc);
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory workbench", () => {
  test("builds a unified local UI artifact over dashboard, capabilities, and timeline", async () => {
    const { root, store } = await graphRoot();
    await seedDoc(root, store);
    await store.upsertNode({
      label: "pinned-memory-workbench-context",
      node_type: "decision",
      properties: {
        title: "Pinned Memory Workbench context",
        content: "Decision: memory workbench context packs must show pinned core context first.",
        confidence: "EXTRACTED",
        source: "manual",
        importance: 0.95,
        tier: "durable",
        created_at: 1_700_000_000_000,
      },
    });
    await appendMemoryEvent(
      store,
      hookLifecycleToMemoryEvent(
        {
          event: "SessionStart",
          runner: "codex",
          sessionId: "session-workbench",
          cwd: root,
          changedFiles: [],
          goal: "security",
        },
        { noop: false, inject: "# Memory context\n" },
        { timestamp: "2026-05-22T16:05:00.000Z", eventId: "hook:start:workbench" },
      ),
    );

    const workbench = await buildMemoryWorkbench(store, root, {
      sessionId: "session-workbench",
      now: 1_700_000_000_000,
    });
    const artifact = buildMemoryWorkbenchArtifact(workbench);

    expect(workbench).toMatchObject({
      schema_version: "memory.workbench.v1",
      read_only: true,
      dashboard: { schema_version: "memory.operational_dashboard.v1" },
      capabilities: { schema_version: "memory.capability_catalog.v1" },
      references_radar: { schema_version: "memory.reference_radar.v1" },
      context_pack: {
        goal: "memory",
      },
      extraction_status: {
        schema_version: "memory.extraction_status.v1",
        deterministic: { structured_transcript: true },
      },
      governance: {
        schema_version: "memory.governance.v1",
        read_only: true,
        tidy_availability: {
          status: "unavailable",
          reason: "no AI provider configured for governance tidy",
        },
      },
      memory_decay: {
        schema_version: "memory.decay_plan.v1",
        read_only: true,
      },
      handoff: {
        schema_version: "memory.handoff.v1",
        read_only: true,
      },
      work_frontier: {
        schema_version: "memory.work_frontier.v1",
        read_only: true,
      },
      learning_debt: {
        schema_version: "memory.learning_debt.v1",
        read_only: true,
      },
      memory_health: {
        schema_version: "memory.health.v1",
        read_only: true,
      },
      memory_layers: {
        schema_version: "memory.memory_layers.v1",
        summary: { total_layers: 5 },
      },
      routing_guide: {
        schemaVersion: "memory.routing_guide.v1",
        agent: "codex",
      },
      agent_integration_status: {
        schema_version: "memory.agent_integration_status.v1",
      },
      session_timeline: {
        schema_version: "memory.session_timeline.v1",
        summary: { events: 1 },
      },
    });
    expect(artifact.contract).toEqual({
      name: "memory.workbench.viewer",
      version: "memory.workbench.viewer.v1",
      consumes: [
        "memory.operational_dashboard.v1",
        "memory.capability_catalog.v1",
        "memory.reference_radar.v1",
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
        "memory.whatif.v1",
        "memory.federation.v1",
        "memory.autocure.v1",
      ],
    });
    expect(artifact.html).toContain("Memory Workbench");
    expect(artifact.html).toContain("Command map");
    expect(artifact.html).toContain("Get context before acting");
    expect(artifact.html).toContain("memory recall &quot;topic&quot;");
    expect(artifact.html).toContain("Everything else in the Workbench is an operator or diagnostic view");
    expect(artifact.html).toContain("Operational Summary");
    expect(artifact.html).toContain("Memory Layers");
    expect(artifact.html).toContain('id="memory-layers-refresh"');
    expect(artifact.html).toContain('href="/layers"');
    expect(artifact.html).toContain("Open Memory Layers");
    expect(artifact.html).toContain('fetch("/api/layers"');
    expect(artifact.html).toContain("Capabilities");
    expect(artifact.html).toContain("References Radar");
    expect(artifact.html).toContain("not public benchmark claims");
    expect(artifact.html).toContain("Search Console");
    expect(artifact.html).toContain('action="/api/search"');
    expect(artifact.html).toContain('id="memory-search-form"');
    expect(artifact.html).toContain('id="memory-smart-search-link"');
    expect(artifact.html).toContain('href="/search?query=memory"');
    expect(artifact.html).toContain("Open Smart Search Viewer");
    expect(artifact.html).toContain('id="memory-search-summary"');
    expect(artifact.html).toContain('id="memory-search-actions"');
    expect(artifact.html).toContain('fetch("/api/search');
    expect(artifact.html).toContain("asset_hits");
    expect(artifact.html).toContain("vector_hits");
    expect(artifact.html).toContain("Context Pack");
    expect(workbench.context_pack.coreContext.map((entry) => entry.title)).toContain(
      "Pinned Memory Workbench context",
    );
    expect(artifact.html).toContain("core_context");
    expect(artifact.html).toContain("Pinned Memory Workbench context");
    expect(artifact.html.indexOf("core_context")).toBeLessThan(
      artifact.html.indexOf("memory-context-pack-markdown"),
    );
    expect(artifact.html).toContain('id="memory-context-pack-form"');
    expect(artifact.html).toContain('href="/context-pack?goal=memory"');
    expect(artifact.html).toContain("Open Context Pack");
    expect(artifact.html).toContain('fetch("/api/context-pack');
    expect(artifact.html).toContain("Docs Explorer");
    expect(artifact.html).toContain('action="/api/docs/search"');
    expect(artifact.html).toContain('id="memory-docs-form"');
    expect(artifact.html).toContain('id="memory-docs-search-link"');
    expect(artifact.html).toContain('href="/docs/search?query=memory"');
    expect(artifact.html).toContain("Open Search Viewer");
    expect(artifact.html).toContain('id="memory-docs-brief-button"');
    expect(artifact.html).toContain('id="memory-docs-brief-link"');
    expect(artifact.html).toContain('href="/docs/brief?query=memory"');
    expect(artifact.html).toContain("Open Brief Viewer");
    expect(artifact.html).toContain('id="memory-docs-bundle-link"');
    expect(artifact.html).toContain('href="/docs/bundle?query=memory"');
    expect(artifact.html).toContain("Open Bundle Viewer");
    expect(artifact.html).toContain('id="memory-docs-evidence-pack"');
    expect(artifact.html).toContain('id="memory-docs-related-results"');
    expect(artifact.html).toContain('id="memory-docs-backlinks-form"');
    expect(artifact.html).toContain('id="memory-docs-coverage-refresh"');
    expect(artifact.html).toContain('id="memory-docs-reference-graph-refresh"');
    expect(artifact.html).toContain('href="/docs/reference-graph"');
    expect(artifact.html).toContain("Open Reference Graph");
    expect(artifact.html).toContain('fetch("/api/docs/search');
    expect(artifact.html).toContain('fetch("/api/docs/brief');
    expect(artifact.html).toContain('fetch("/api/docs/read');
    expect(artifact.html).toContain('fetch("/api/docs/evidence-pack');
    expect(artifact.html).toContain("/docs/evidence-pack?rid=");
    expect(artifact.html).toContain('fetch("/api/docs/related');
    expect(artifact.html).toContain("/docs/related?rid=");
    expect(artifact.html).toContain("Related Viewer");
    expect(artifact.html).toContain('fetch("/api/docs/backlinks');
    expect(artifact.html).toContain('fetch("/api/docs/coverage"');
    expect(artifact.html).toContain('fetch("/api/docs/reference-graph"');
    expect(artifact.html).toContain('fetch("/api/assets"');
    expect(artifact.html).toContain('href="/assets"');
    expect(artifact.html).toContain("Open Asset Inventory");
    expect(artifact.html).toContain("Agent Handoff");
    expect(artifact.html).toContain('id="memory-handoff-form"');
    expect(artifact.html).toContain('href="/handoff"');
    expect(artifact.html).toContain("Open Handoff");
    expect(artifact.html).toContain('fetch("/api/handoff');
    expect(artifact.html).toContain("Work Frontier");
    expect(artifact.html).toContain('id="memory-frontier-form"');
    expect(artifact.html).toContain('href="/frontier"');
    expect(artifact.html).toContain("Open Frontier");
    expect(artifact.html).toContain('fetch("/api/frontier');
    expect(artifact.html).toContain("Agent Routing");
    expect(artifact.html).toContain('id="memory-routing-guide-form"');
    expect(artifact.html).toContain('href="/routing-guide?agent=codex"');
    expect(artifact.html).toContain("Open Routing Guide");
    expect(artifact.html).toContain('fetch("/api/routing-guide');
    expect(artifact.html).toContain("Agent Integration Status");
    expect(artifact.html).toContain('id="memory-agent-integration-refresh"');
    expect(artifact.html).toContain('href="/integration-status"');
    expect(artifact.html).toContain("Open Integration Status");
    expect(artifact.html).toContain('fetch("/api/integration-status"');
    expect(artifact.html).toContain("Graph Path Explorer");
    expect(artifact.html).toContain('action="/api/path-explain"');
    expect(artifact.html).toContain('id="memory-path-form"');
    expect(artifact.html).toContain('fetch("/api/path-explain');
    expect(artifact.html).toContain("Onboarding Map");
    expect(artifact.html).toContain('id="memory-onboarding-refresh"');
    expect(artifact.html).toContain('href="/onboarding-map"');
    expect(artifact.html).toContain('fetch("/api/onboarding-map"');
    expect(artifact.html).toContain("Graph Communities");
    expect(artifact.html).toContain('id="memory-communities-refresh"');
    expect(artifact.html).toContain('href="/communities"');
    expect(artifact.html).toContain('fetch("/api/communities"');
    expect(artifact.html).toContain("Vector Diagnostics");
    expect(artifact.html).toContain('action="/api/vector/search"');
    expect(artifact.html).toContain('id="memory-vector-form"');
    expect(artifact.html).toContain('href="/vector/status"');
    expect(artifact.html).toContain("Open Vector Status");
    expect(artifact.html).toContain('fetch("/api/vector/status"');
    expect(artifact.html).toContain('fetch("/api/vector/search');
    expect(artifact.html).toContain("asset_kind");
    expect(artifact.html).toContain("media_type");
    expect(artifact.html).toContain("Extraction Status");
    expect(artifact.html).toContain('id="memory-extraction-refresh"');
    expect(artifact.html).toContain('href="/extraction/status"');
    expect(artifact.html).toContain("Open Extraction Status");
    expect(artifact.html).toContain('fetch("/api/extraction/status"');
    expect(artifact.html).toContain("Governance");
    expect(artifact.html).toContain("Tidy availability");
    expect(artifact.html).toContain("no AI provider configured for governance tidy");
    expect(artifact.html).toContain('id="memory-governance-refresh"');
    expect(artifact.html).toContain('href="/governance"');
    expect(artifact.html).toContain("Open Governance");
    expect(artifact.html).toContain('fetch("/api/governance"');
    expect(artifact.html).toContain("Memory Decay");
    expect(artifact.html).toContain('id="memory-decay-refresh"');
    expect(artifact.html).toContain('href="/decay"');
    expect(artifact.html).toContain("Open Decay");
    expect(artifact.html).toContain('fetch("/api/decay"');
    expect(artifact.html).toContain("Learning Debt");
    expect(artifact.html).toContain('id="memory-learning-debt-refresh"');
    expect(artifact.html).toContain('href="/learning-debt"');
    expect(artifact.html).toContain("Open Learning Debt");
    expect(artifact.html).toContain('fetch("/api/learning-debt"');
    expect(artifact.html).toContain("Memory Health");
    expect(artifact.html).toContain('id="memory-health-refresh"');
    expect(artifact.html).toContain('href="/memory/health"');
    expect(artifact.html).toContain("Open Memory Health");
    expect(artifact.html).toContain('fetch("/api/memory/health"');
    expect(artifact.html).toContain("Hook Diagnostics");
    expect(artifact.html).toContain('action="/api/session/timeline"');
    expect(artifact.html).toContain('id="memory-hooks-form"');
    expect(artifact.html).toContain('id="memory-hooks-refresh"');
    expect(artifact.html).toContain('href="/hooks/coverage"');
    expect(artifact.html).toContain("Open Hook Coverage");
    expect(artifact.html).toContain('fetch("/api/hooks/coverage"');
    expect(artifact.html).toContain('fetch("/api/session/timeline');
    expect(artifact.html).toContain("Session Timeline");
    expect(artifact.html).toContain('id="memory-workbench-data"');
    expect(artifact.html).toContain("Reasoning Replay");
    expect(artifact.html).toContain("No recent reasoning replays yet");
    expect(artifact.html).toContain("Federation Status");
    expect(artifact.html).toContain("No federation roots configured");
    expect(artifact.html).toContain("Autocure Health");
    expect(artifact.html).not.toContain("<script src=");
  }, TIMEOUT);

  test(
    "CLI writes the workbench HTML and can emit JSON",
    async () => {
      const { root, store } = await graphRoot();
      await seedDoc(root, store);
      await store.close();
      stores.pop();

      const out = join(root, "workbench.html");
      const result = runMemory(["workbench", "--root", root, "--out", out]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: workbench written");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Memory Workbench");
      expect(html).toContain("memory-workbench-data");
      expect(html).toContain("memory-search-form");
      expect(html).toContain("memory-context-pack-form");
      expect(html).toContain("Open Context Pack");
      expect(html).toContain("memory-docs-form");
      expect(html).toContain("memory-docs-search-link");
      expect(html).toContain("Open Search Viewer");
      expect(html).toContain("memory-docs-brief-button");
      expect(html).toContain("memory-docs-brief-link");
      expect(html).toContain("Open Brief Viewer");
      expect(html).toContain("memory-docs-bundle-link");
      expect(html).toContain("/docs/evidence-pack?rid=");
      expect(html).toContain("Open Bundle Viewer");
      expect(html).toContain("memory-docs-related-results");
      expect(html).toContain("memory-docs-coverage-refresh");
      expect(html).toContain("memory-docs-reference-graph-refresh");
      expect(html).toContain("Open Reference Graph");
      expect(html).toContain("memory-path-form");
      expect(html).toContain("memory-onboarding-refresh");
      expect(html).toContain("Open Onboarding Map");
      expect(html).toContain("memory-communities-refresh");
      expect(html).toContain("Open Communities");
      expect(html).toContain("memory-vector-form");
      expect(html).toContain("Open Vector Status");
      expect(html).toContain('href="/vector/status"');
      expect(html).toContain("memory-extraction-refresh");
      expect(html).toContain('href="/extraction/status"');
      expect(html).toContain("Open Extraction Status");
      expect(html).toContain("memory-governance-refresh");
      expect(html).toContain('href="/governance"');
      expect(html).toContain("Open Governance");
      expect(html).toContain("memory-decay-refresh");
      expect(html).toContain('href="/decay"');
      expect(html).toContain("Open Decay");
      expect(html).toContain("memory-handoff-form");
      expect(html).toContain('href="/handoff"');
      expect(html).toContain("Open Handoff");
      expect(html).toContain("memory-frontier-form");
      expect(html).toContain('href="/frontier"');
      expect(html).toContain("Open Frontier");
      expect(html).toContain("memory-routing-guide-form");
      expect(html).toContain('href="/routing-guide?agent=codex"');
      expect(html).toContain("Open Routing Guide");
      expect(html).toContain("memory-agent-integration-refresh");
      expect(html).toContain('href="/integration-status"');
      expect(html).toContain("Open Integration Status");
      expect(html).toContain("memory-learning-debt-refresh");
      expect(html).toContain('href="/learning-debt"');
      expect(html).toContain("Open Learning Debt");
      expect(html).toContain("memory-health-refresh");
      expect(html).toContain('href="/memory/health"');
      expect(html).toContain("Open Memory Health");
      expect(html).toContain("memory-hooks-form");
      expect(html).toContain("Open Hook Coverage");
      expect(html).toContain("memory-layers-refresh");
      expect(html).toContain('href="/layers"');
      expect(html).toContain("Open Memory Layers");

      const json = runMemory(["workbench", "--root", root, "--json"]);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schema_version: "memory.workbench.v1",
        dashboard: { schema_version: "memory.operational_dashboard.v1" },
        references_radar: { schema_version: "memory.reference_radar.v1" },
        context_pack: { goal: "memory" },
        extraction_status: { schema_version: "memory.extraction_status.v1" },
        governance: { schema_version: "memory.governance.v1" },
        memory_decay: { schema_version: "memory.decay_plan.v1" },
        handoff: { schema_version: "memory.handoff.v1" },
        work_frontier: { schema_version: "memory.work_frontier.v1" },
        learning_debt: { schema_version: "memory.learning_debt.v1" },
        memory_health: { schema_version: "memory.health.v1" },
        memory_layers: { schema_version: "memory.memory_layers.v1" },
        routing_guide: { schemaVersion: "memory.routing_guide.v1" },
        agent_integration_status: { schema_version: "memory.agent_integration_status.v1" },
      });
    },
    TIMEOUT,
  );
});
