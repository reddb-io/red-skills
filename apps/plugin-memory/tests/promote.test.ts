import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { readMemoryEvents } from "../src/memory-events.js";
import { runPromote } from "../src/promote.js";
import { start as sessionStart } from "../src/session-manager.js";
import { appendEvent } from "../src/working-memory.js";

const TIMEOUT = 60_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-promote-"));
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

describe("memory promote", () => {
  test(
    "promotes typed L2 candidates into L3 and emits one engine.op event per decision",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "sess-promote-A" });
      const store = await openStore(root);

      await appendEvent(store, root, {
        type: "decision_candidate",
        value: "Adopt Vitest as the test runner",
      });
      await appendEvent(store, root, {
        type: "fix_candidate",
        value: "Quote variables in shell scripts to handle spaces",
      });
      await appendEvent(store, root, {
        type: "tool_call",
        value: "grep foo",
      });

      const report = await runPromote(store, root);
      expect(report.promoted).toBe(2);
      expect(report.reinforced).toBe(0);
      expect(report.skipped).toBe(1);
      expect(report.promoted_rids.length).toBe(2);

      const events = await readMemoryEvents(store);
      const promoteEvents = events.filter(
        (e) => e.kind === "engine.op" && "op" in e.payload && e.payload.op === "promote",
      );
      expect(promoteEvents.length).toBe(2);
      for (const ev of promoteEvents) {
        expect("outcome" in ev.payload && ev.payload.outcome).toBe("created");
      }
    },
    TIMEOUT,
  );

  test(
    "reinforces existing L3 nodes instead of double-promoting near-dup candidates",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "sess-promote-B" });
      const store = await openStore(root);

      // Seed L3 by promoting once.
      await appendEvent(store, root, {
        type: "decision_candidate",
        value: "Standardise on pnpm for this repo",
      });
      const first = await runPromote(store, root);
      expect(first.promoted).toBe(1);

      // Drop and re-mint a fresh session to avoid the prior L2 events.
      await sessionStart(root, { id: "sess-promote-B2" });
      await appendEvent(store, root, {
        type: "decision_candidate",
        value: "Standardise on pnpm for this repo",
      });
      const second = await runPromote(store, root);
      expect(second.promoted).toBe(0);
      expect(second.reinforced).toBe(1);
      expect(second.reinforced_rids[0]).toBe(first.promoted_rids[0]);

      // Reinforcement overlay reflects the bump.
      const count = await store.reinforcedCount(first.promoted_rids[0]);
      expect(count).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "L2 overflow threshold triggers promotion before eviction",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "sess-overflow" });
      const store = await openStore(root);

      const prevThreshold = process.env.RED_MEMORY_L2_OVERFLOW_THRESHOLD;
      process.env.RED_MEMORY_L2_OVERFLOW_THRESHOLD = "3";
      try {
        await appendEvent(store, root, {
          type: "decision_candidate",
          value: "Pick TypeScript strict mode",
        });
        await appendEvent(store, root, { type: "tool_call", value: "ls" });
        // Third append crosses the threshold (sequence >= 3) → backstop fires.
        await appendEvent(store, root, {
          type: "fix_candidate",
          value: "Quote shell variables to handle spaces",
        });

        const events = await readMemoryEvents(store);
        const promoteEvents = events.filter(
          (e) => e.kind === "engine.op" && "op" in e.payload && e.payload.op === "promote",
        );
        expect(promoteEvents.length).toBeGreaterThanOrEqual(1);
      } finally {
        if (prevThreshold === undefined) delete process.env.RED_MEMORY_L2_OVERFLOW_THRESHOLD;
        else process.env.RED_MEMORY_L2_OVERFLOW_THRESHOLD = prevThreshold;
      }
    },
    TIMEOUT,
  );

  test(
    "BLOCKED with NO_SESSION_MSG when no session is active",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      await expect(runPromote(store, root)).rejects.toThrow(/session/);
    },
    TIMEOUT,
  );
});
