import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import {
  appendMemoryEvent,
  hookLifecycleToMemoryEvent,
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
});
