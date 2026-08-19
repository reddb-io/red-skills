import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildReadinessEnvelope } from "../src/readiness.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { appendMemoryEvent, parseMemoryEvent } from "../src/memory-events.js";

const TIMEOUT = 90_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];
const NOW = new Date("2030-05-24T20:00:00.000Z");
const OLD_GUIDANCE_AT = Date.parse("2025-01-01T00:00:00.000Z");

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-readiness-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function seedEvidence(store: MemoryStore): Promise<{ oldRid: number; currentRid: number }> {
  const oldRid = await store.upsertNode({
    label: "readiness-old-guidance",
    node_type: "decision",
    properties: {
      title: "old readiness guidance",
      content: "Decision: readiness envelopes may be ad hoc prose.",
      source: "manual",
      created_at: OLD_GUIDANCE_AT,
      accessed_at: OLD_GUIDANCE_AT,
      provenance: {
        source_kind: "manual",
        writer: "test",
        command: "seed readiness",
        evidence: ["old guidance"],
      },
    },
  });
  const currentRid = await store.upsertNode({
    label: "readiness-contract",
    node_type: "decision",
    properties: {
      title: "readiness contract",
      content:
        "Decision: readiness envelopes must expose stable JSON for future UI and references:eval:v2.",
      source: "manual",
      created_at: OLD_GUIDANCE_AT,
      accessed_at: OLD_GUIDANCE_AT,
      provenance: {
        source_kind: "manual",
        writer: "test",
        command: "seed readiness",
        evidence: ["contract decision"],
      },
    },
  });
  const conflictRid = await store.upsertNode({
    label: "readiness-conflict",
    node_type: "problem",
    properties: {
      title: "readiness conflict",
      content: "Pitfall: readiness JSON conflicts with free-form prose output.",
      source: "manual",
      created_at: OLD_GUIDANCE_AT,
      accessed_at: OLD_GUIDANCE_AT,
    },
  });
  const validationRid = await store.upsertNode({
    label: "readiness-validation",
    node_type: "validation",
    properties: {
      title: "readiness validation",
      content: "Validation: run pnpm test for readiness envelope changes.",
      source: "manual",
      created_at: OLD_GUIDANCE_AT,
      accessed_at: OLD_GUIDANCE_AT,
      provenance: {
        source_kind: "system",
        writer: "vitest",
        command: "pnpm test -- readiness",
        evidence: ["test fixture"],
      },
    },
  });
  await store.upsertNode({
    label: "readiness-tdd-skill",
    node_type: "workflow",
    properties: {
      title: "readiness TDD skill",
      content: "Workflow: use dev:tdd when changing readiness stable json behavior.",
      tags: ["skill:dev:tdd"],
      source: "manual",
      created_at: OLD_GUIDANCE_AT,
      accessed_at: OLD_GUIDANCE_AT,
      provenance: {
        source_kind: "manual",
        writer: "test",
        command: "seed readiness",
        evidence: ["skill guidance"],
      },
    },
  });

  await store.supersede(oldRid, currentRid, "stable JSON replaced prose");
  await store.upsertEdge({
    label: "CONTRADICTS",
    from_rid: currentRid,
    to_rid: conflictRid,
    properties: { reason: "free prose conflicts with stable JSON" },
  });
  await store.upsertEdge({ label: "REFERENCES", from_rid: currentRid, to_rid: validationRid });

  await appendMemoryEvent(
    store,
    parseMemoryEvent({
      id: "skill-event:readiness-1",
      occurred_at: NOW.toISOString(),
      kind: "skill.telemetry",
      source: { kind: "hook", name: "memory event skill" },
      actor: { kind: "agent", id: "codex" },
      scope: { level: "session", id: "session-1" },
      subject: { kind: "skill", id: "plugin:dev:tdd" },
      payload: {
        event_type: "result",
        event_id: "readiness-1",
        timestamp: NOW.toISOString(),
        session_id: "session-1",
        turn_id: "turn-1",
        name: "dev:tdd",
        source_kind: "plugin",
        path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
        runner: "codex",
        result: { status: "succeeded", duration_ms: 1200 },
      },
      provenance: {
        source_kind: "hook",
        writer: "memory",
        command: "memory event skill",
        evidence: ["event_id:readiness-1"],
      },
    }),
  );

  return { oldRid, currentRid };
}

describe("Memory readiness envelope", () => {
  test(
    "combines task readiness, retrieval, governance, VCS, telemetry, and communities",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const store = await openStore(root);
      const { oldRid } = await seedEvidence(store);

      const envelope = await buildReadinessEnvelope(store, "readiness stable json", {
        now: NOW,
        minEvidence: 2,
        staleDays: 1,
      });

      expect(envelope.contract).toEqual({
        name: "memory.readiness",
        version: "memory.readiness.v1",
        consumer_targets: ["memory-ui", "references:eval:v2"],
      });
      expect(envelope.request.goal).toBe("readiness stable json");
      expect(envelope.governance).toMatchObject({
        min_evidence: 2,
        stale_days: 1,
        ranking_signals: ["scope", "tier", "supersession", "confidence", "freshness"],
      });
      expect(envelope.task.preflight.summary.evidenceCount).toBeGreaterThanOrEqual(2);
      expect(envelope.evidence.active.length).toBeGreaterThan(0);
      expect(envelope.evidence.missing.missing).toBe(false);
      expect(envelope.evidence.contradictions.length).toBe(1);
      expect(envelope.evidence.superseded.map((item) => item.urn)).toContain(
        `memory_nodes:${oldRid}`,
      );
      expect(envelope.evidence.stale.length).toBeGreaterThan(0);
      expect(envelope.retrieval.vector.total).toBeGreaterThanOrEqual(4);
      expect(envelope.trust.provenance.nodes_with_provenance).toBeGreaterThan(0);
      expect(envelope.trust.supersession.superseded_nodes).toBe(1);
      expect(envelope.trust.contradictions.unresolved).toBe(1);
      expect(envelope.trust.privacy.read_only).toBe(true);
      expect(envelope.trust.claim_check.status).not.toBe("insufficient-evidence");
      expect(envelope.vcs.collections.find((c) => c.name === "memory_nodes")).toMatchObject({
        expected: "versioned",
        status: "versioned",
      });
      expect(envelope.vcs.collections.find((c) => c.name === "memory_kv")).toMatchObject({
        expected: "non-versioned",
      });
      expect(envelope.operations.event_log.total_events).toBeGreaterThanOrEqual(1);
      expect(envelope.operations.event_log.kinds["skill.telemetry"]).toBe(1);
      expect(envelope.communities.assignments).toBeGreaterThanOrEqual(4);
      expect(envelope.communities.communities).toBeGreaterThan(0);
      expect(envelope.skills.status).toBe("ok");
      expect(envelope.skills.recommendations[0]).toMatchObject({
        name: "dev:tdd",
        evidenceStrength: "moderate",
      });
      expect(envelope.learning_debt.status).toBe("available");
      expect(envelope.learning_debt.debt_status).toBe("debt-found");
      expect(envelope.next_actions).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Resolve or supersede contradictory Memory evidence"),
          expect.stringContaining("Load recommended skills: dev:tdd"),
        ]),
      );
    },
    TIMEOUT,
  );

  test(
    "reports missing evidence explicitly instead of failing the readiness command",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const store = await openStore(root);

      const envelope = await buildReadinessEnvelope(store, "unseen readiness task", {
        now: NOW,
        minEvidence: 1,
      });

      expect(envelope.status).toBe("needs-evidence");
      expect(envelope.evidence.missing).toEqual({
        missing: true,
        expected_minimum: 1,
        active_count: 0,
        messages: [
          "Only 0 active Memory evidence item(s) matched; at least 1 are expected for a task preflight.",
        ],
      });
      expect(envelope.skills.status).toBe("insufficient-evidence");
      expect(envelope.learning_debt.status).toBe("available");
      expect(envelope.next_actions).toContain(
        "Capture or ingest Memory evidence for this task before implementation.",
      );
    },
    TIMEOUT,
  );

  test(
    "CLI callers can request a stable JSON readiness envelope for a goal",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const store = await openStore(root);
      await seedEvidence(store);
      await store.close();
      stores.pop();

      const result = runMemory([
        "readiness",
        "readiness",
        "stable",
        "json",
        "--root",
        root,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        contract: { version: string; consumer_targets: string[] };
        request: { goal: string };
        retrieval: { vector: { overall: string } };
        trust: { provenance: { total_nodes: number }; privacy: { read_only: boolean } };
        vcs: { time_travel: string };
        operations: { event_log: { total_events: number } };
        communities: { communities: number };
      };
      expect(body.contract.version).toBe("memory.readiness.v1");
      expect(body.contract.consumer_targets).toContain("references:eval:v2");
      expect(body.request.goal).toBe("readiness stable json");
      expect(body.retrieval.vector.overall).toMatch(/ready|stale|unavailable|failed/);
      expect(body.trust.provenance.total_nodes).toBeGreaterThan(0);
      expect(body.trust.privacy.read_only).toBe(true);
      expect(body.vcs.time_travel).toBe("available");
      expect(body.operations.event_log.total_events).toBeGreaterThanOrEqual(1);
      expect(body.communities.communities).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
