import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graphRecall } from "../../memory/src/graph-recall.js";
import { MemoryStore } from "../../memory/src/graph-store.js";
import { withBrainRuntime } from "../../brain/src/runtime.js";
import { BrainStore } from "../../brain/src/store.js";
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
  it("keeps concurrent memory writers in one resident-owned RedDB store", async () => {
    const root = await tempRoot();
    const writerA = join(root, "writer-a");
    const writerB = join(root, "writer-b");
    await mkdir(writerA, { recursive: true });
    await mkdir(writerB, { recursive: true });
    await writeFile(join(writerA, "a.md"), "alpha-resident-token belongs to writer A\n", "utf8");
    await writeFile(join(writerB, "b.md"), "bravo-resident-token belongs to writer B\n", "utf8");

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath);
    const client = new ResidentRspElisionStore(paths, {
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    });

    await Promise.all([
      client.memory("ingest", { cwd: writerA }),
      client.memory("ingest", { cwd: writerB }),
    ]);
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
  }, 20_000);

  it("shares one resident-owned RedDB store across rsp, memory, and brain clients", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red", "brain"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
    await writeFile(
      join(root, ".red", "brain", "config.yaml"),
      "connection_string: file://./.red/tmp/red-skills.rdb\n",
      "utf8",
    );
    const docs = join(root, "docs");
    await mkdir(docs, { recursive: true });
    await writeFile(join(docs, "memory.md"), "memory-shared-resident-token\n", "utf8");

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      idleMs: 5_000,
    });
    await waitForResident(paths.socketPath);
    const client = new ResidentRspElisionStore(paths, {
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    });

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

    await server;
  }, 20_000);
});

async function waitForResident(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
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
