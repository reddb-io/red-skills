import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { start as sessionStart } from "../src/session-manager.js";
import {
  appendEvent,
  getRawTranscript,
  listEvents,
  NO_SESSION_MSG,
  setRawTranscript,
} from "../src/working-memory.js";

const TIMEOUT = 60_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-working-"));
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
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("working memory — module API", () => {
  test(
    "append writes a typed event, get reads it back, ordered by sequence",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "sess-A" });
      const store = await openStore(root);

      const a = await appendEvent(store, root, { type: "user_input", value: "hello" });
      const b = await appendEvent(store, root, { type: "tool_call", value: "grep foo" });
      const c = await appendEvent(store, root, { type: "user_input", value: "again" });

      expect(a.sequence).toBe(1);
      expect(b.sequence).toBe(2);
      expect(c.sequence).toBe(3);

      const all = await listEvents(store, root);
      expect(all.map((e) => e.value)).toEqual(["hello", "grep foo", "again"]);
      expect(all.map((e) => e.sequence)).toEqual([1, 2, 3]);

      const filtered = await listEvents(store, root, { type: "user_input" });
      expect(filtered.map((e) => e.value)).toEqual(["hello", "again"]);
    },
    TIMEOUT,
  );

  test(
    "raw transcript: write replaces, read returns the latest, at most one node per session",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "sess-T" });
      const store = await openStore(root);

      expect(await getRawTranscript(store, root)).toBeNull();

      await setRawTranscript(store, root, "first");
      let r = await getRawTranscript(store, root);
      expect(r?.value).toBe("first");

      await setRawTranscript(store, root, "second");
      r = await getRawTranscript(store, root);
      expect(r?.value).toBe("second");

      // at most one transcript node per session
      const nodes = await store.listNodes();
      const transcripts = nodes.filter(
        (n) =>
          n.properties.layer === "L2" &&
          n.properties.session_id === "sess-T" &&
          n.properties.working_kind === "transcript",
      );
      expect(transcripts).toHaveLength(1);
    },
    TIMEOUT,
  );

  test(
    "isolation: session A reads do not see events written by session B",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      await sessionStart(root, { id: "sess-A" });
      await appendEvent(store, root, { type: "user_input", value: "from-A-1" });
      await appendEvent(store, root, { type: "user_input", value: "from-A-2" });
      await setRawTranscript(store, root, "transcript-A");

      await sessionStart(root, { id: "sess-B" });
      await appendEvent(store, root, { type: "user_input", value: "from-B-1" });
      await setRawTranscript(store, root, "transcript-B");

      const bEvents = await listEvents(store, root);
      expect(bEvents.map((e) => e.value)).toEqual(["from-B-1"]);
      const bRaw = await getRawTranscript(store, root);
      expect(bRaw?.value).toBe("transcript-B");

      await sessionStart(root, { id: "sess-A" });
      const aEvents = await listEvents(store, root);
      expect(aEvents.map((e) => e.value)).toEqual(["from-A-1", "from-A-2"]);
      const aRaw = await getRawTranscript(store, root);
      expect(aRaw?.value).toBe("transcript-A");
    },
    TIMEOUT,
  );

  test(
    "writes without an active session error cleanly",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      await expect(
        appendEvent(store, root, { type: "user_input", value: "x" }),
      ).rejects.toThrow(NO_SESSION_MSG);
      await expect(setRawTranscript(store, root, "x")).rejects.toThrow(NO_SESSION_MSG);
      await expect(listEvents(store, root)).rejects.toThrow(NO_SESSION_MSG);
      await expect(getRawTranscript(store, root)).rejects.toThrow(NO_SESSION_MSG);
    },
    TIMEOUT,
  );
});

describe("working memory — CLI", () => {
  test(
    "append + get round-trip via the CLI",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "cli-sess" });

      const a = runMemory([
        "working",
        "append",
        "--root",
        root,
        "--type",
        "user_input",
        "--value",
        "hi",
        "--json",
      ]);
      expect(a.status, a.stderr).toBe(0);
      const appended = JSON.parse(a.stdout);
      expect(appended.type).toBe("user_input");
      expect(appended.session_id).toBe("cli-sess");

      const g = runMemory(["working", "get", "--root", root, "--json"]);
      expect(g.status, g.stderr).toBe(0);
      const { events } = JSON.parse(g.stdout);
      expect(events).toHaveLength(1);
      expect(events[0].value).toBe("hi");
    },
    TIMEOUT,
  );

  test(
    "raw set + read via the CLI",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await sessionStart(root, { id: "cli-raw" });

      const w = runMemory([
        "working",
        "raw",
        "--root",
        root,
        "--set",
        "hello transcript",
        "--json",
      ]);
      expect(w.status, w.stderr).toBe(0);

      const r = runMemory(["working", "raw", "--root", root, "--json"]);
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).value).toBe("hello transcript");
    },
    TIMEOUT,
  );

  test(
    "CLI errors cleanly when no session is active",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const r = runMemory([
        "working",
        "append",
        "--root",
        root,
        "--type",
        "user_input",
        "--value",
        "x",
      ]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/no session/);
    },
    TIMEOUT,
  );

  test(
    "working needs a known action",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const r = runMemory(["working", "bogus", "--root", root]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/working needs an action/);
    },
    TIMEOUT,
  );
});
