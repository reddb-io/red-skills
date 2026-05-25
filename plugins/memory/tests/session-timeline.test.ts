import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import {
  appendMemoryEvent,
  hookLifecycleToMemoryEvent,
  parseMemoryEvent,
} from "../src/memory-events.js";
import { buildSessionTimeline } from "../src/session-timeline.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "memory-session-timeline-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { hooks: true, skillTelemetry: true });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  return { root, store };
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory session timeline", () => {
  test("normalizes hook lifecycle and skill telemetry events into replay entries", async () => {
    const { store } = await graphRoot();
    await appendMemoryEvent(
      store,
      hookLifecycleToMemoryEvent(
        {
          event: "SessionStart",
          runner: "codex",
          sessionId: "session-1",
          cwd: "/repo",
          changedFiles: [],
          goal: "auth",
        },
        { noop: false, inject: "# Memory context\n" },
        { timestamp: "2026-05-22T16:00:00.000Z", eventId: "hook:start:1" },
      ),
    );
    await appendMemoryEvent(
      store,
      parseMemoryEvent({
        id: "skill-event:evt-1",
        occurred_at: "2026-05-22T16:01:00.000Z",
        kind: "skill.telemetry",
        source: { kind: "hook", name: "memory event skill" },
        actor: { kind: "agent", id: "codex" },
        scope: { level: "session", id: "session-1" },
        subject: { kind: "skill", id: "plugin:dev:tdd" },
        payload: {
          event_type: "result",
          event_id: "evt-1",
          timestamp: "2026-05-22T16:01:00.000Z",
          session_id: "session-1",
          turn_id: "turn-1",
          name: "dev:tdd",
          source_kind: "plugin",
          path: "/skills/tdd/SKILL.md",
          runner: "codex",
          result: { status: "failed", duration_ms: 1200, error_stage: "verify" },
        },
        provenance: {
          source_kind: "hook",
          writer: "memory",
          command: "memory event skill",
          evidence: ["event_id:evt-1"],
        },
      }),
    );

    const timeline = await buildSessionTimeline(store, { sessionId: "session-1" });

    expect(timeline).toMatchObject({
      schema_version: "memory.session_timeline.v1",
      read_only: true,
      summary: {
        sessions: 1,
        events: 2,
        hook_events: 1,
        skill_events: 1,
        failures: 1,
      },
    });
    expect(timeline.entries.map((entry) => entry.title)).toEqual([
      "SessionStart hook",
      "dev:tdd result",
    ]);
    expect(timeline.entries[0]?.detail).toContain("injected chars");
    expect(timeline.entries[1]?.outcome).toBe("failed");
  });

  test(
    "CLI emits session timeline JSON",
    async () => {
      const { root, store } = await graphRoot();
      await appendMemoryEvent(
        store,
        hookLifecycleToMemoryEvent(
          {
            event: "PostToolUse",
            runner: "claude",
            sessionId: "session-cli",
            cwd: root,
            changedFiles: [join(root, "src/auth.ts")],
          },
          { noop: false, indexed: 1 },
          { timestamp: "2026-05-22T16:02:00.000Z", eventId: "hook:post:cli" },
        ),
      );
      await store.close();
      stores.pop();

      const result = runMemory([
        "session",
        "timeline",
        "--root",
        root,
        "--session",
        "session-cli",
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schema_version: "memory.session_timeline.v1",
        filter: { session_id: "session-cli" },
        summary: { events: 1, hook_events: 1 },
      });
    },
    TIMEOUT,
  );
});
