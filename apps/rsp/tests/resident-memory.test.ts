import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "@reddb-io/sdk";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graphRecall } from "../../memory/src/graph-recall.js";
import { MemoryStore } from "../../memory/src/graph-store.js";
import { withBrainRuntime } from "../../brain/src/runtime.js";
import { BrainStore } from "@reddb-io/brain-store/store.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/config.js";
import { ResidentRspElisionStore, resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import { runResidentServer } from "../src/resident-server.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-resident-memory-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resident memory transport", () => {
  it("writes the resident PID registry while serving and removes it on idle exit", async () => {
    const root = await tempRoot();
    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const timing = await calibratedResidentTiming(root);

    const server = runResidentServer({
      socketPath: paths.socketPath,
      rootDir: paths.rootDir,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      idleMs: 100,
      residentVersion: "9.8.7-test",
      registryPath: paths.registryPath,
    });

    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
    const entry = await waitForRegistry(paths.registryPath, timing.waitTimeoutMs);
    expect(entry).toMatchObject({
      pid: process.pid,
      socket_path: paths.socketPath,
      store_uri: storeUri,
      resident_version: "9.8.7-test",
    });
    expect(Date.parse(entry.started_at)).toBeGreaterThan(0);

    await server;
    await expect(readFile(paths.registryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("keeps concurrent memory writers in one resident-owned RedDB store", async () => {
    const root = await tempRoot();
    const writerA = join(root, "writer-a");
    const writerB = join(root, "writer-b");
    await mkdir(writerA, { recursive: true });
    await mkdir(writerB, { recursive: true });
    await writeFile(join(writerA, "a.md"), "alpha-resident-token belongs to writer A\n", "utf8");
    await writeFile(join(writerB, "b.md"), "bravo-resident-token belongs to writer B\n", "utf8");

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const timing = await calibratedResidentTiming(root);
    const server = runResidentServer({
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      idleMs: timing.waitTimeoutMs,
    });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
    const client = new ResidentRspElisionStore(paths, {
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    });

    try {
      await Promise.all([
        client.memory("ingest", { cwd: writerA }),
        client.memory("ingest", { cwd: writerB }),
      ]);
    } finally {
      await shutdownResident(paths.socketPath, timing.waitTimeoutMs);
    }
    await server;

    const store = await MemoryStore.open({ uri: storeUri });
    try {
      await expect(graphRecall(store, "alpha-resident-token", 5)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ excerpt: expect.stringContaining("alpha-resident-token") })]),
      );
      await expect(graphRecall(store, "bravo-resident-token", 5)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ excerpt: expect.stringContaining("bravo-resident-token") })]),
      );
    } finally {
      await store.close();
    }
  }, 60_000);

  it("shares one resident-owned RedDB store across rsp, memory, and brain clients", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red", "brain"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await writeFile(
      join(root, ".red", "brain", "config.yaml"),
      "connection_string: file://./.red/state/red-skills.rdb\n",
      "utf8",
    );
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "memory.md"), "memory-shared-resident-token\n", "utf8");

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const timing = await calibratedResidentTiming(root);
    const server = runResidentServer({
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      idleMs: timing.waitTimeoutMs,
    });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
    const client = new ResidentRspElisionStore(paths, {
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    });

    try {
      const handle = await client.mint(Buffer.from("rsp-shared-resident-token"), {
        command: "rsp test",
        loss: { level: "brief", bytes_elided: 25 },
      });
      await client.memory("ingest", { cwd: docs });

      const openSpy = vi.spyOn(BrainStore, "open");
      try {
        await withBrainRuntime(async ({ store }) => {
          await store.capture({
            title: "Brain shared resident note",
            content: "brain-shared-resident-token cites memory-shared-resident-token and rsp-shared-resident-token",
            kind: "note",
            tags: ["shared-resident"],
          });
          await expect(store.search("brain-shared-resident-token", 5)).resolves.toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                artifact: expect.objectContaining({
                  properties: expect.objectContaining({
                    content: expect.stringContaining("brain-shared-resident-token"),
                  }),
                }),
              }),
            ]),
          );
        }, root);
        expect(openSpy).not.toHaveBeenCalled();
      } finally {
        openSpy.mockRestore();
      }

      await expect(client.get(handle)).resolves.toEqual(
        expect.objectContaining({ original: Buffer.from("rsp-shared-resident-token") }),
      );
      await expect(client.memory("recall", { query: "memory-shared-resident-token", limit: 5 })).resolves.toEqual(
        expect.objectContaining({
          hits: expect.arrayContaining([
            expect.objectContaining({ excerpt: expect.stringContaining("memory-shared-resident-token") }),
          ]),
        }),
      );
    } finally {
      await shutdownResident(paths.socketPath, timing.waitTimeoutMs);
    }

    await server;
  }, 60_000);
});

interface ResidentTiming {
  waitTimeoutMs: number;
}

const BASELINE_STORE_OPEN_MS = 100;

async function calibratedResidentTiming(root: string): Promise<ResidentTiming> {
  await mkdir(join(root, ".red", "tmp"), { recursive: true });
  const baselineUri = `file://${join(root, ".red", "tmp", `resident-baseline-${process.pid}-${Date.now()}.rdb`)}`;
  const started = process.hrtime.bigint();
  const db = await connect(baselineUri);
  await db.close();
  const storeOpenMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const scale = Math.min(4, Math.max(1, Math.ceil(Math.max(1, storeOpenMs) / BASELINE_STORE_OPEN_MS)));
  return { waitTimeoutMs: 5_000 * scale };
}

async function waitForResident(socketPath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, { id: `wait-${attempt++}`, op: "ping" });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resident did not start");
}

async function waitForRegistry(path: string, timeoutMs = 5_000): Promise<{
  pid: number;
  socket_path: string;
  store_uri: string;
  resident_version: string;
  started_at: string;
}> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, "utf8");
      return parseRegistryDocument(raw) as {
        pid: number;
        socket_path: string;
        store_uri: string;
        resident_version: string;
        started_at: string;
      };
    } catch (err) {
      last = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last instanceof Error ? last : new Error("resident registry did not appear");
}

function parseRegistryDocument(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return decode(raw.trim());
  }
}

async function shutdownResident(socketPath: string, timeoutMs = 5_000): Promise<void> {
  await sendResidentRequest({ socketPath, timeoutMs: 500 }, {
    id: "shutdown",
    op: "handover",
    clientVersion: "test-shutdown",
  }).catch(() => null);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await sendResidentRequest({ socketPath, timeoutMs: 100 }, {
      id: "shutdown-poll",
      op: "ping",
    }).then((response) => response.ok, () => false);
    if (!alive) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resident did not shut down");
}
