import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildContextPack, type ContextPack } from "../src/context-pack.js";
import {
  appendContextPackGenerationEvent,
  appendEngineOpEvent,
  appendMemoryEvent,
  contextPackGenerationToMemoryEvent,
  deriveMemoryInjectionRollups,
  driftCaughtToMemoryEvent,
  engineOpToMemoryEvent,
  hookLifecycleToMemoryEvent,
  memoryInjectionToMemoryEvent,
  parseMemoryEvent,
  readMemoryEvents,
} from "../src/memory-events.js";

const TIMEOUT = 90_000;
const roots: string[] = [];
const stores: MemoryStore[] = [];

const EVENT = {
  id: "skill-event:evt-1",
  occurred_at: "2026-05-22T16:00:00.000Z",
  kind: "skill.telemetry",
  source: { kind: "hook", name: "memory event skill" },
  actor: { kind: "agent", id: "codex" },
  scope: { level: "session", id: "session-1" },
  subject: { kind: "skill", id: "plugin:dev:tdd" },
  payload: {
    event_type: "result",
    event_id: "evt-1",
    timestamp: "2026-05-22T16:00:00.000Z",
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
    evidence: ["event_id:evt-1"],
  },
} as const;

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-event-log-"));
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

describe("Memory event log", () => {
  test(
    "reads only raw events inside a configurable retention horizon",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      const old = parseMemoryEvent({
        ...EVENT,
        id: "skill-event:old",
        occurred_at: "2026-04-01T00:00:00.000Z",
        payload: { ...EVENT.payload, event_id: "old", timestamp: "2026-04-01T00:00:00.000Z" },
        provenance: { ...EVENT.provenance, evidence: ["event_id:old"] },
      });
      const recent = parseMemoryEvent({
        ...EVENT,
        id: "skill-event:recent",
        occurred_at: "2026-05-20T00:00:00.000Z",
        payload: {
          ...EVENT.payload,
          event_id: "recent",
          timestamp: "2026-05-20T00:00:00.000Z",
        },
        provenance: { ...EVENT.provenance, evidence: ["event_id:recent"] },
      });

      await appendMemoryEvent(store, old);
      await appendMemoryEvent(store, recent);

      await expect(
        readMemoryEvents(store, {
          retentionMs: 30 * 24 * 60 * 60 * 1000,
          now: "2026-05-24T00:00:00.000Z",
        }),
      ).resolves.toEqual([recent]);
    },
    TIMEOUT,
  );

  test(
    "appends operational telemetry with a validated generic envelope",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      const event = parseMemoryEvent(EVENT);

      await appendMemoryEvent(store, event);

      await expect(() =>
        parseMemoryEvent({
          ...event,
          payload: { ...event.payload, result: { status: "crashed" } },
        }),
      ).toThrow(/payload/i);
      expect(await readMemoryEvents(store)).toEqual([event]);
    },
    TIMEOUT,
  );

  test(
    "appending the same event id does not mutate the prior raw event",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      const first = parseMemoryEvent(EVENT);
      const second = parseMemoryEvent({
        ...EVENT,
        payload: {
          ...EVENT.payload,
          result: { status: "failed", error_stage: "verify" },
        },
      });

      await appendMemoryEvent(store, first);
      await appendMemoryEvent(store, second);

      expect(await readMemoryEvents(store)).toEqual([first, second]);
    },
    TIMEOUT,
  );

  test(
    "engine ops emit through upsertNode / supersede / recall and surface in mem.events",
    async () => {
      const { graphRecallResult } = await import("../src/graph-recall.js");
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      // store (created), then store (deduped via second upsert)
      const ridA = await store.upsertNode({
        label: "engine-op-A",
        node_type: "concept",
        properties: { title: "engine op A", content: "alpha" },
      });
      const ridADup = await store.upsertNode({
        label: "engine-op-A",
        node_type: "concept",
        properties: { title: "engine op A", content: "alpha" },
      });
      expect(ridA).toBe(ridADup);

      const ridB = await store.upsertNode({
        label: "engine-op-B",
        node_type: "concept",
        properties: { title: "engine op B", content: "bravo" },
      });

      // conflict-detected via supersede
      await store.supersede(ridA, ridB, "newer evidence");

      // recall — hit
      await graphRecallResult(store, "engine op B");

      const events = await readMemoryEvents(store);
      const engineEvents = events.filter((e) => e.kind === "engine.op");
      const ops = engineEvents.map((e) => {
        const p = e.payload as { op: string; outcome: string };
        return `${p.op}:${p.outcome}`;
      });
      expect(ops).toContain("store:created");
      expect(ops).toContain("store:deduped");
      expect(ops).toContain("conflict-detected:succeeded");
      expect(ops.some((s) => s.startsWith("recall:"))).toBe(true);
    },
    TIMEOUT,
  );

  test("appendEngineOpEvent never throws on engine telemetry failures", async () => {
    const fakeStore = {
      raw: {
        execute: async () => {
          throw new Error("simulated engine outage");
        },
        query: async () => {
          throw new Error("simulated engine outage");
        },
      },
    } as unknown as MemoryStore;

    await expect(
      appendEngineOpEvent(fakeStore, { op: "store", outcome: "created", layer: "L3" }),
    ).resolves.toBeUndefined();
  });

  test("engineOpToMemoryEvent serializes the issue #181 fields", () => {
    const event = engineOpToMemoryEvent({
      op: "recall",
      outcome: "hit",
      layer: "L3",
      session_id: "session-X",
      query: "memory layers",
      hit_count: 3,
      timestamp: "2026-05-22T18:00:00.000Z",
      eventId: "engine:recall:1",
    });
    expect(event).toMatchObject({
      id: "engine:recall:1",
      kind: "engine.op",
      payload: {
        event_type: "engine.op",
        op: "recall",
        outcome: "hit",
        layer: "L3",
        session_id: "session-X",
        query: "memory layers",
        hit_count: 3,
      },
    });
  });

  test("validates context-pack generation observations with pack identity and citations", () => {
    const pack: ContextPack = {
      goal: "jwt rotation",
      status: "ok",
      budgetChars: 1200,
      usedChars: 320,
      markdown: "# Memory context pack: jwt rotation\n",
      coreContext: [],
      entries: [
        {
          section: "prior_decisions",
          title: "JWT rotation",
          nodeType: "decision",
          importance: 0.8,
          confidence: "EXTRACTED",
          trust: 1,
          provenance: null,
          citation: { marker: "[M1]", urn: "memory_nodes:7", rid: 7, source: "manual" },
          reason: "decision evidence matched the goal",
          excerpt: "Rotate JWT keys with signed fixtures.",
          score: 1,
          expandHandle: "memory:recall 7",
          compressed: false,
        },
      ],
      skillRecommendations: {
        task: "jwt rotation",
        status: "insufficient-evidence",
        recommendations: [],
        missingEvidence: [],
      },
      warnings: [],
      omittedEntries: 0,
    };

    const event = contextPackGenerationToMemoryEvent({
      pack,
      surface: "cli",
      timestamp: "2026-05-22T19:00:00.000Z",
      eventId: "context-pack:1",
    });

    expect(event).toMatchObject({
      id: "context-pack:1",
      kind: "memory.context-pack.generated",
      payload: {
        event_type: "memory.context-pack.generated",
        goal: "jwt rotation",
        surface: "cli",
        citation_ids: ["memory_nodes:7"],
        node_ids: [7],
        entry_count: 1,
      },
    });
    expect(event.payload).toHaveProperty("pack_id");
    expect(() => parseMemoryEvent(event)).not.toThrow();
  });

  test("validates Memory injection observations and rejects empty deliveries", () => {
    const event = memoryInjectionToMemoryEvent({
      deliveredCitationIds: ["memory_nodes:7"],
      deliveredNodeIds: [7],
      deliverySurface: "hook",
      goal: "jwt rotation",
      sessionId: "session-1",
      runner: "codex",
      hookEvent: "SessionStart",
      injectedChars: 512,
      timestamp: "2026-05-22T19:10:00.000Z",
      eventId: "injection:1",
    });

    expect(event).toMatchObject({
      id: "injection:1",
      kind: "memory.injection.delivered",
      payload: {
        event_type: "memory.injection.delivered",
        delivery_surface: "hook",
        delivered_citation_ids: ["memory_nodes:7"],
        delivered_node_ids: [7],
      },
    });
    expect(() =>
      memoryInjectionToMemoryEvent({
        deliverySurface: "hook",
        timestamp: "2026-05-22T19:10:00.000Z",
      }),
    ).toThrow(/delivered citation or node ids/);
  });

  test(
    "context-pack generation records generation without creating injection",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      await store.upsertNode({
        label: "context-pack-generation",
        node_type: "decision",
        properties: {
          title: "Context pack generation",
          content: "Decision: context-pack generation cites Memory nodes.",
          source: "manual",
        },
      });

      const pack = await buildContextPack(store, "context-pack generation", { budgetChars: 1200 });
      await appendContextPackGenerationEvent(store, { pack, surface: "cli" });

      const events = await readMemoryEvents(store);
      expect(events.filter((event) => event.kind === "memory.context-pack.generated")).toHaveLength(1);
      expect(events.filter((event) => event.kind === "memory.injection.delivered")).toHaveLength(0);
    },
    TIMEOUT,
  );

  test(
    "manual recall display records recall/access bookkeeping but not injection",
    async () => {
      const { graphRecallResult } = await import("../src/graph-recall.js");
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      const rid = await store.upsertNode({
        label: "manual-recall-display",
        node_type: "decision",
        properties: {
          title: "Manual recall display",
          content: "Decision: manual recall display is not Memory injection.",
          source: "manual",
        },
      });

      await graphRecallResult(store, "manual recall display");

      const access = await store.accessRecord(rid);
      expect(access?.count).toBeGreaterThan(0);
      const events = await readMemoryEvents(store);
      expect(events.some((event) => event.kind === "engine.op")).toBe(true);
      expect(events.filter((event) => event.kind === "memory.injection.delivered")).toHaveLength(0);
    },
    TIMEOUT,
  );

  test("derives injection counters and last timestamps from event-log observations", () => {
    const first = memoryInjectionToMemoryEvent({
      deliveredCitationIds: ["memory_nodes:7"],
      deliveredNodeIds: [7],
      deliverySurface: "hook",
      timestamp: "2026-05-22T19:00:00.000Z",
      eventId: "injection:rollup:1",
    });
    const second = memoryInjectionToMemoryEvent({
      deliveredCitationIds: ["memory_nodes:7"],
      deliveredNodeIds: [7],
      deliverySurface: "mcp",
      timestamp: "2026-05-22T20:00:00.000Z",
      eventId: "injection:rollup:2",
    });

    const rollups = deriveMemoryInjectionRollups([first, second]);

    expect(rollups).toContainEqual({
      id: "citation:memory_nodes:7",
      citation_id: "memory_nodes:7",
      delivered_count: 2,
      last_injected_at: "2026-05-22T20:00:00.000Z",
      delivery_surfaces: ["hook", "mcp"],
    });
    expect(rollups).toContainEqual({
      id: "node:7",
      node_id: 7,
      delivered_count: 2,
      last_injected_at: "2026-05-22T20:00:00.000Z",
      delivery_surfaces: ["hook", "mcp"],
    });
  });

  test("validates hook lifecycle events without storing raw transcript text", () => {
    const event = hookLifecycleToMemoryEvent(
      {
        event: "Stop",
        runner: "codex",
        sessionId: "session-42",
        cwd: "/repo",
        changedFiles: [],
        transcriptText: "We decided to keep the raw transcript out of replay.",
      },
      { noop: false, stored: 1 },
      { timestamp: "2026-05-22T17:00:00.000Z", eventId: "hook:stop:1" },
    );

    expect(event).toMatchObject({
      id: "hook:stop:1",
      kind: "hook.lifecycle",
      scope: { level: "session", id: "session-42" },
      payload: {
        event_type: "hook.lifecycle",
        hook_event: "Stop",
        result: { noop: false, stored: 1 },
        transcript_chars: expect.any(Number),
      },
    });
    expect(JSON.stringify(event)).not.toContain("keep the raw transcript");
  });

  test("driftCaughtToMemoryEvent builds a contract-valid memory.drift.caught event (#224)", () => {
    const event = driftCaughtToMemoryEvent({
      changedPaths: [".red/adr/0032.md", ".red/CONTEXT.md"],
      reason:
        "Run /memory:ingest .red/adr/0032.md and re-push (or add Memory-NoIngest: <reason> trailer).",
      prNumber: "224",
      headSha: "1a2b3c4",
      baseRef: "main",
      timestamp: "2026-05-28T18:00:00.000Z",
      eventId: "drift:224:1",
    });
    expect(event).toMatchObject({
      id: "drift:224:1",
      kind: "memory.drift.caught",
      scope: { level: "pull-request", id: "224" },
      payload: {
        event_type: "memory.drift.caught",
        changed_paths: [".red/adr/0032.md", ".red/CONTEXT.md"],
        pr_number: "224",
        head_sha: "1a2b3c4",
        base_ref: "main",
      },
    });
    // Round-trips through the strict envelope validator.
    expect(() => parseMemoryEvent(event)).not.toThrow();
  });

  test(
    "appendMemoryEvent persists a memory.drift.caught event onto the append-only log",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      const event = driftCaughtToMemoryEvent({
        changedPaths: [".red/adr/0040.md"],
        reason: "Run /memory:ingest .red/adr/0040.md and re-push (or add Memory-NoIngest: <reason> trailer).",
        eventId: "drift:pr:40",
        timestamp: "2026-05-28T19:00:00.000Z",
      });

      await appendMemoryEvent(store, event);

      const drift = (await readMemoryEvents(store)).filter(
        (e) => e.kind === "memory.drift.caught",
      );
      expect(drift).toEqual([event]);
    },
    TIMEOUT,
  );
});
