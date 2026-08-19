import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph, initMarkdownOnly } from "../src/init.js";
import { readMemoryEvents } from "../src/memory-events.js";
import { MemoryStore } from "../src/graph-store.js";
import {
  ingestSkillEvents,
  parseSkillEventInput,
  readRecentSkillEvents,
  readSkillRollups,
  type SkillEvent,
} from "../src/skill-events.js";

const EVENT = {
  event_type: "result",
  event_id: "evt-1",
  timestamp: "2026-05-22T16:00:00.000Z",
  session_id: "session-1",
  turn_id: "turn-1",
  name: "dev:tdd",
  source_kind: "plugin",
  path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
  runner: "codex",
  result: {
    status: "succeeded",
    duration_ms: 1200,
    error_class: "none",
  },
} satisfies SkillEvent;

const TIMEOUT = 90_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-skill-event-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

function runMemory(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    input,
    timeout: TIMEOUT,
  });
}

async function packageJsonFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await packageJsonFiles(path)));
    } else if (entry.name === "package.json") {
      files.push(path);
    }
  }
  return files;
}

describe("Skill telemetry event contract", () => {
  test("parses one safe skill result event", () => {
    const events = parseSkillEventInput(JSON.stringify(EVENT));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "result",
      event_id: "evt-1",
      turn_id: "turn-1",
      name: "dev:tdd",
      runner: "codex",
      result: {
        status: "succeeded",
        duration_ms: 1200,
      },
    });
  });

  test("parses JSON array and JSONL batches", () => {
    const used = { ...EVENT, event_id: "evt-used", event_type: "used", result: undefined };

    expect(parseSkillEventInput(JSON.stringify([EVENT, used]))).toHaveLength(2);
    expect(
      parseSkillEventInput(`${JSON.stringify(EVENT)}\n${JSON.stringify(used)}\n`),
    ).toHaveLength(2);
  });

  test("rejects transcripts and unsafe result payloads", () => {
    expect(() =>
      parseSkillEventInput(
        JSON.stringify({
          ...EVENT,
          transcript: "agent said a lot of raw text",
        }),
      ),
    ).toThrow(/transcript/i);

    expect(() =>
      parseSkillEventInput(
        JSON.stringify({
          ...EVENT,
          result: { status: "crashed", output: "raw logs" },
        }),
      ),
    ).toThrow(/result/i);
  });
});

describe("memory event skill CLI", () => {
  test(
    "ingests one skill event from flags in graph mode",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });

      const result = runMemory([
        "event",
        "skill",
        "--root",
        root,
        "--event-type",
        "viewed",
        "--event-id",
        "evt-flags",
        "--timestamp",
        "2026-05-22T16:00:00.000Z",
        "--session-id",
        "session-1",
        "--turn-id",
        "turn-1",
        "--name",
        "memory:recall",
        "--source-kind",
        "plugin",
        "--path",
        "/plugins/memory/skills/core/recall/SKILL.md",
        "--runner",
        "codex",
      ]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("memory: ingested 1 skill event");

      const stats = runMemory(["stats", "--root", root]);
      expect(stats.stdout).toContain("memory: 4 node(s)");
    },
    TIMEOUT,
  );

  test(
    "ingests a JSONL skill event batch from stdin",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const second = { ...EVENT, event_id: "evt-2", event_type: "used", result: undefined };
      const input = `${JSON.stringify(EVENT)}\n${JSON.stringify(second)}\n`;

      const result = runMemory(["event", "skill", "--root", root], input);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("memory: ingested 2 skill events");

      const stats = runMemory(["stats", "--root", root]);
      expect(stats.stdout).toContain("memory: 5 node(s)");
    },
    120_000,
  );

  test(
    "reports invalid explicit payloads without writing",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });

      const result = runMemory(
        ["event", "skill", "--root", root],
        JSON.stringify({ ...EVENT, transcript: "raw conversation text" }),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid skill event");
      expect(result.stderr).toContain("transcript");
    },
    TIMEOUT,
  );

  test(
    "no-ops clearly when memory is unavailable or not in graph mode",
    async () => {
      const uninitialized = await tempRoot();
      const missing = runMemory(["event", "skill", "--root", uninitialized], JSON.stringify(EVENT));
      expect(missing.status).toBe(0);
      expect(missing.stdout).toContain("not initialized");

      const markdown = await tempRoot();
      await initMarkdownOnly(markdown);
      const markdownResult = runMemory(
        ["event", "skill", "--root", markdown],
        JSON.stringify(EVENT),
      );
      expect(markdownResult.status).toBe(0);
      expect(markdownResult.stdout).toContain("needs graph mode");

      const optedOut = await tempRoot();
      await initGraph(optedOut);
      const optedOutResult = runMemory(
        ["event", "skill", "--root", optedOut],
        JSON.stringify(EVENT),
      );
      expect(optedOutResult.status).toBe(0);
      expect(optedOutResult.stdout).toContain("skill telemetry is not enabled");
    },
    TIMEOUT,
  );
});

describe("skill telemetry graph persistence", () => {
  test(
    "promoted graph evidence survives when raw events fall outside retention",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      await ingestSkillEvents(store, [EVENT]);

      const eventsInRetention = (
        await readMemoryEvents(store, {
          retentionMs: 24 * 60 * 60 * 1000,
          now: "2026-05-24T16:00:00.000Z",
        })
      ).filter((event) => event.kind === "skill.telemetry");
      expect(eventsInRetention).toEqual([]);
      await expect(readRecentSkillEvents(store)).resolves.toEqual([
        expect.objectContaining({
          event_type: "result",
          name: "dev:tdd",
          status: "succeeded",
        }),
      ]);
      await expect(readSkillRollups(store)).resolves.toEqual([
        expect.objectContaining({
          event_count: 1,
          result_count: 1,
          outcome_counts: { succeeded: 1 },
        }),
      ]);
    },
    TIMEOUT,
  );

  test(
    "dual-writes raw skill telemetry events while preserving deduped rollups",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      await ingestSkillEvents(store, [EVENT, EVENT]);

      const events = (await readMemoryEvents(store)).filter(
        (event) => event.kind === "skill.telemetry",
      );
      expect(events).toHaveLength(2);
      expect(events).toEqual([
        expect.objectContaining({
          id: "skill-event:evt-1",
          kind: "skill.telemetry",
          actor: { kind: "agent", id: "codex" },
          scope: { level: "session", id: "session-1" },
          subject: { kind: "skill", id: "plugin:dev:tdd" },
          payload: expect.objectContaining({
            event_type: "result",
            event_id: "evt-1",
            name: "dev:tdd",
            result: { status: "succeeded", duration_ms: 1200, error_class: "none" },
          }),
        }),
        expect.objectContaining({
          id: "skill-event:evt-1",
          kind: "skill.telemetry",
        }),
      ]);
      expect(await readSkillRollups(store)).toEqual([
        expect.objectContaining({
          event_count: 1,
          result_count: 1,
          outcome_counts: { succeeded: 1 },
        }),
      ]);
    },
    TIMEOUT,
  );

  test(
    "replaying a skill result event preserves one evidence graph and one rollup count",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      await ingestSkillEvents(store, [EVENT, EVENT]);

      const nodes = await store.listNodes();
      expect(nodes.map((node) => node.label).sort()).toEqual([
        "skill-event:evt-1",
        "skill-session:session-1",
        "skill-turn:turn-1",
        "skill:dev:tdd",
      ]);

      const edges = await store.listEdges();
      expect(edges).toHaveLength(4);

      const rollups = await readSkillRollups(store);
      expect(rollups).toEqual([
        expect.objectContaining({
          name: "dev:tdd",
          source_kind: "plugin",
          path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
          view_count: 0,
          use_count: 0,
          patch_count: 0,
          change_count: 0,
          result_count: 1,
          last_activity: "2026-05-22T16:00:00.000Z",
          outcome_counts: { succeeded: 1 },
          curatable_status: "active",
        }),
      ]);
    },
    TIMEOUT,
  );

  test(
    "rollups aggregate skill activity counts across event types",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      const events: SkillEvent[] = [
        { ...EVENT, event_id: "evt-viewed", event_type: "viewed", result: undefined },
        {
          ...EVENT,
          event_id: "evt-used",
          event_type: "used",
          timestamp: "2026-05-22T16:01:00.000Z",
          result: undefined,
        },
        {
          ...EVENT,
          event_id: "evt-changed",
          event_type: "changed",
          timestamp: "2026-05-22T16:02:00.000Z",
          result: undefined,
        },
        {
          ...EVENT,
          event_id: "evt-patched",
          event_type: "patched",
          timestamp: "2026-05-22T16:03:00.000Z",
          result: undefined,
        },
        {
          ...EVENT,
          event_id: "evt-result",
          event_type: "result",
          timestamp: "2026-05-22T16:04:00.000Z",
          result: { status: "failed", error_class: "runtime" },
        },
      ];

      await ingestSkillEvents(store, events);

      expect(await readSkillRollups(store)).toEqual([
        expect.objectContaining({
          event_count: 5,
          view_count: 1,
          use_count: 1,
          change_count: 1,
          patch_count: 1,
          result_count: 1,
          first_seen: "2026-05-22T16:00:00.000Z",
          last_activity: "2026-05-22T16:04:00.000Z",
          outcome_counts: { failed: 1 },
          archive_signal: false,
          consolidation_signal: false,
        }),
      ]);
    },
    TIMEOUT,
  );

  test(
    "partitions rollups so multi-skill telemetry batches do not exceed kv value limits",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      const events: SkillEvent[] = [];

      for (let skill = 1; skill <= 12; skill++) {
        for (let attempt = 1; attempt <= 5; attempt++) {
          events.push({
            ...EVENT,
            event_id: `skill-${skill}-result-${attempt}`,
            timestamp: `2026-05-22T16:${String(skill).padStart(2, "0")}:${String(attempt).padStart(2, "0")}.000Z`,
            turn_id: `skill-${skill}-turn-${attempt}`,
            name: `skill-${skill}`,
            path: `/plugins/dev/skills/engineering/skill-${skill}/SKILL.md`,
            result: {
              status: attempt <= 4 ? "failed" : "succeeded",
              error_class: attempt <= 4 ? "ValidationError" : undefined,
              error_stage: attempt <= 4 ? "verify" : undefined,
            },
          });
        }
      }

      await ingestSkillEvents(store, events);

      const rollups = await readSkillRollups(store);
      expect(rollups).toHaveLength(12);
      expect(rollups[0]).toEqual(
        expect.objectContaining({
          event_count: 5,
          result_count: 5,
          outcome_counts: { failed: 4, succeeded: 1 },
        }),
      );
    },
    TIMEOUT,
  );

});

describe("plugin dependency boundaries", () => {
  test("dev plugin package manifests do not depend directly on RedDB", async () => {
    const manifests = await packageJsonFiles(join(PLUGIN_ROOT, "..", "dev"));
    expect(manifests.length).toBeGreaterThan(0);

    for (const manifest of manifests) {
      const pkg = JSON.parse(await readFile(manifest, "utf8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const directDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      };
      expect(directDeps).not.toHaveProperty("@reddb-io/sdk");
    }
  });
});
