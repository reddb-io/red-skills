import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { appendMemoryEvent, parseMemoryEvent } from "../src/memory-events.js";
import { COLLECTIONS } from "../src/schema.js";
import { MEMORY_COLLECTION_VERSIONING } from "../src/vcs-versioned-collections.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const RED = join(PLUGIN_ROOT, "node_modules", "@reddb-io", "sdk", "bin", "red");
const roots: string[] = [];
const stores: MemoryStore[] = [];

const RAW_EVENT = {
  id: "skill-event:vcs-boundary",
  occurred_at: "2026-05-22T16:00:00.000Z",
  kind: "skill.telemetry",
  source: { kind: "hook", name: "memory event skill" },
  actor: { kind: "agent", id: "codex" },
  scope: { level: "session", id: "session-1" },
  subject: { kind: "skill", id: "plugin:dev:tdd" },
  payload: {
    event_type: "result",
    event_id: "vcs-boundary",
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
    evidence: ["event_id:vcs-boundary"],
  },
} as const;

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-vcs-commit-"));
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

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function redVcsLog(root: string) {
  const result = spawnSync(
    RED,
    ["vcs", "log", "--path", join(root, ".red/memory/graph.rdb"), "--json"],
    { encoding: "utf8", timeout: TIMEOUT },
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as {
    data: Array<{ hash: string; message: string; height: number }>;
  };
}

describe("explicit Memory graph VCS commit", () => {
  test("commits the versioned Memory graph and reports included/skipped collections", async () => {
    const root = await tempRoot();
    await initGraph(root);
    const store = await openStore(root);
    await store.upsertNode({
      label: "decision:vcs-commit",
      node_type: "decision",
      properties: { title: "VCS commit", content: "Memory graph commits are explicit." },
    });
    await store.close();

    const result = runMemory([
      "commit",
      "--root",
      root,
      "--message",
      "manual memory checkpoint",
      "--json",
    ]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);

    const expectedIncluded = MEMORY_COLLECTION_VERSIONING.filter((c) =>
      c.tiers.some((tier) => tier === "durable" || tier === "reasoning"),
    ).map((c) => c.name);
    const expectedSkipped = MEMORY_COLLECTION_VERSIONING.filter((c) =>
      c.tiers.every((tier) => tier === "ephemeral"),
    ).map((c) => c.name);

    expect(body).toMatchObject({
      status: "committed",
      committed: true,
      message: "manual memory checkpoint",
      included: expectedIncluded,
      skipped: expectedSkipped,
    });
    expect(body.commit.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(body.included).toContain(COLLECTIONS.nodes);
    expect(body.skipped).toContain(COLLECTIONS.kv);

    const log = redVcsLog(root);
    expect(log.data).toHaveLength(1);
    expect(log.data[0]).toMatchObject({
      hash: body.commit.hash,
      message: "manual memory checkpoint",
      height: 0,
    });
  }, TIMEOUT);

  test("reports unchanged instead of creating duplicate commits", async () => {
    const root = await tempRoot();
    await initGraph(root);
    const store = await openStore(root);
    await store.upsertNode({
      label: "decision:idempotent-vcs-commit",
      node_type: "decision",
      properties: { title: "Idempotent commit", content: "No-op commits are reported." },
    });
    await store.close();

    const first = runMemory(["commit", "--root", root, "--json"]);
    expect(first.status).toBe(0);
    const firstBody = JSON.parse(first.stdout);
    expect(firstBody.committed).toBe(true);

    const second = runMemory(["commit", "--root", root, "--json"]);
    expect(second.status).toBe(0);
    const secondBody = JSON.parse(second.stdout);

    expect(secondBody).toMatchObject({
      status: "unchanged",
      committed: false,
      previousCommit: firstBody.commit.hash,
      included: firstBody.included,
      skipped: firstBody.skipped,
    });
    expect(redVcsLog(root).data).toHaveLength(1);
  }, TIMEOUT);

  test("skipped ephemeral/session/cache metadata does not create a new commit", async () => {
    const root = await tempRoot();
    await initGraph(root);
    const store = await openStore(root);
    await store.upsertNode({
      label: "decision:skip-transient-vcs-data",
      node_type: "decision",
      properties: { title: "Skip transient data", content: "Only durable graph data is committed." },
    });
    await store.close();

    const first = runMemory(["commit", "--root", root, "--json"]);
    expect(first.status).toBe(0);

    const afterCommit = await openStore(root);
    await afterCommit.kvPut("session:current", { turn: "transient" });
    await afterCommit.kvPut("cache:search", { value: "temporary cache" });
    await afterCommit.kvPut("event-log:last", { event: "temporary event log" });
    await afterCommit.close();

    const second = runMemory(["commit", "--root", root, "--json"]);
    expect(second.status).toBe(0);
    const body = JSON.parse(second.stdout);

    expect(body).toMatchObject({
      status: "unchanged",
      committed: false,
    });
    expect(body.skipped).toContain(COLLECTIONS.kv);
    expect(redVcsLog(root).data).toHaveLength(1);
  }, TIMEOUT);

  test("raw event log writes are skipped and do not create historical commits", async () => {
    const root = await tempRoot();
    await initGraph(root);
    const store = await openStore(root);
    await store.upsertNode({
      label: "decision:raw-events-outside-vcs",
      node_type: "decision",
      properties: {
        title: "Raw events outside VCS",
        content: "Memory commits exclude operational event logs.",
      },
    });
    await store.close();

    const first = runMemory(["commit", "--root", root, "--json"]);
    expect(first.status).toBe(0);

    const afterCommit = await openStore(root);
    await appendMemoryEvent(afterCommit, parseMemoryEvent(RAW_EVENT));
    await afterCommit.close();

    const second = runMemory(["commit", "--root", root, "--json"]);
    expect(second.status).toBe(0);
    const body = JSON.parse(second.stdout);

    expect(body).toMatchObject({
      status: "unchanged",
      committed: false,
    });
    expect(body.skipped).toContain(COLLECTIONS.events);
    expect(redVcsLog(root).data).toHaveLength(1);
  }, TIMEOUT);
});
