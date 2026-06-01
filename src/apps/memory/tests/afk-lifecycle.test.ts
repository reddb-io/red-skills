import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runAfkLifecycle } from "../src/afk-lifecycle.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { start as sessionStart } from "../src/session-manager.js";
import { appendEvent, setRawTranscript } from "../src/working-memory.js";

const TIMEOUT = 60_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-afk-lifecycle-"));
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

describe("AFK lifecycle hook", () => {
  test(
    "promotes typed L2, archives the raw transcript into L3 as `transcript`, and drops L2",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const session_id = "sess-afk-A";
      const worktreeId = "wAFK01-i1";
      await sessionStart(root, { id: session_id });
      const store = await openStore(root);

      await appendEvent(store, root, {
        type: "decision_candidate",
        value: "Adopt Vitest as the test runner",
      });
      await appendEvent(store, root, {
        type: "fix_candidate",
        value: "Quote shell variables to handle spaces",
      });
      await appendEvent(store, root, {
        type: "tool_call",
        value: "grep foo bar",
      });
      await setRawTranscript(store, root, "user: hi\nagent: hello there\nuser: bye");

      const report = await runAfkLifecycle(store, root, { worktreeId });

      // promote-all picked up the typed candidates, skipped the tool_call.
      expect(report.session_id).toBe(session_id);
      expect(report.worktree_id).toBe(worktreeId);
      expect(report.promote.promoted).toBe(2);
      expect(report.promote.skipped).toBe(1);

      // L3 transcript node archived.
      expect(report.transcript_rid).not.toBeNull();
      expect(report.transcript_created).toBe(true);
      const all = await store.listNodes();
      const transcripts = all.filter((n) => n.node_type === "transcript");
      expect(transcripts.length).toBe(1);
      const t = transcripts[0];
      expect(t.properties.session_id).toBe(session_id);
      expect(t.properties.worktree_id).toBe(worktreeId);
      expect(t.properties.scope).toBe("worktree");
      expect(t.properties.scope_id).toBe(worktreeId);
      expect(t.properties.content).toContain("hello there");

      // No L2 nodes left for the session.
      const remainingL2 = all.filter(
        (n) => n.properties.layer === "L2" && n.properties.session_id === session_id,
      );
      expect(remainingL2.length).toBe(0);
      expect(report.dropped_rids.length).toBeGreaterThanOrEqual(4); // 3 events + 1 transcript
    },
    TIMEOUT,
  );

  test(
    "re-invocation for the same session is a no-op (does not error, does not duplicate)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const session_id = "sess-afk-idem";
      const worktreeId = "wAFK02-i1";
      await sessionStart(root, { id: session_id });
      const store = await openStore(root);

      await appendEvent(store, root, {
        type: "decision_candidate",
        value: "Use pnpm for this repo",
      });
      await setRawTranscript(store, root, "transcript blob @idem");

      const first = await runAfkLifecycle(store, root, { worktreeId });
      expect(first.promote.promoted).toBe(1);
      expect(first.transcript_created).toBe(true);
      expect(first.dropped_rids.length).toBeGreaterThanOrEqual(2);

      // Re-run: nothing left in L2, archival dedups, drop pass finds nothing.
      const second = await runAfkLifecycle(store, root, { worktreeId });
      expect(second.promote.promoted).toBe(0);
      expect(second.promote.reinforced).toBe(0);
      expect(second.transcript_rid).toBeNull();
      expect(second.transcript_created).toBe(false);
      expect(second.dropped_rids.length).toBe(0);

      // Exactly one transcript node in L3.
      const all = await store.listNodes();
      const transcripts = all.filter((n) => n.node_type === "transcript");
      expect(transcripts.length).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "works after the session file has been torn down (sessionId override path)",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const session_id = "sess-afk-detached";
      const worktreeId = "wAFK03-i1";
      await sessionStart(root, { id: session_id });
      const store = await openStore(root);

      await appendEvent(store, root, {
        type: "decision_candidate",
        value: "Pin tsconfig to ES2022",
      });
      await setRawTranscript(store, root, "detached transcript");

      // Simulate the runner already dropping the session file before the hook
      // fires — we still need to finalize that session id.
      await sessionStart(root, { id: "sess-other" });

      const report = await runAfkLifecycle(store, root, {
        worktreeId,
        sessionId: session_id,
      });
      expect(report.session_id).toBe(session_id);
      expect(report.promote.promoted).toBe(1);
      expect(report.transcript_rid).not.toBeNull();
      expect(report.transcript_created).toBe(true);

      const all = await store.listNodes();
      const remaining = all.filter(
        (n) => n.properties.layer === "L2" && n.properties.session_id === session_id,
      );
      expect(remaining.length).toBe(0);
    },
    TIMEOUT,
  );
});
