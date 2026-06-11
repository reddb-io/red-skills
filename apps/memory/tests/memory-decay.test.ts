import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildMemoryDecayReport,
  type MemoryDecayStore,
} from "../src/memory-decay.js";
import { buildMemoryDecayViewerArtifact } from "../src/memory-decay-viewer.js";
import type { StoredNode } from "../src/graph-store.js";

const NOW = Date.parse("2026-05-25T12:00:00.000Z");
const DAY = 86_400_000;
const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeDecayStore implements MemoryDecayStore {
  constructor(
    private readonly nodes: StoredNode[],
    private readonly edges: Record<string, unknown>[] = [],
    private readonly superseded = new Map<number, number>(),
    private readonly access = new Map<number, { count: number; accessed_at: number }>(),
  ) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }

  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.edges;
  }

  async supersededByMany(): Promise<Map<number, number>> {
    return this.superseded;
  }

  async accessRecords(): Promise<Map<number, { count: number; accessed_at: number }>> {
    return this.access;
  }
}

function node(input: {
  rid: number;
  title: string;
  label?: string;
  node_type?: StoredNode["node_type"];
  properties?: Record<string, unknown>;
}): StoredNode {
  return {
    rid: input.rid,
    label: input.label ?? `node-${input.rid}`,
    node_type: input.node_type ?? "decision",
    properties: {
      title: input.title,
      tier: "durable",
      importance: 0.2,
      accessed_at: NOW,
      created_at: NOW,
      ...(input.properties ?? {}),
    },
  };
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-decay-"));
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
}

describe("Memory decay plan", () => {
  test("classifies keep, review, deprecate, and expire candidates without mutating", async () => {
    const report = await buildMemoryDecayReport(
      new FakeDecayStore(
        [
          node({
            rid: 1,
            title: "Pinned architecture decision",
            properties: { importance: 0.9, accessed_at: NOW - 200 * DAY },
          }),
          node({
            rid: 2,
            title: "Old unaccessed workflow",
            node_type: "workflow",
            properties: { accessed_at: NOW - 120 * DAY, importance: 0.4 },
          }),
          node({
            rid: 3,
            title: "Superseded cache guidance",
            properties: { accessed_at: NOW - 20 * DAY },
          }),
          node({
            rid: 4,
            title: "Expired session note",
            node_type: "session",
            properties: {
              tier: "ephemeral",
              accessed_at: NOW - 3 * DAY,
              expires_at: NOW - DAY,
            },
          }),
          node({
            rid: 5,
            title: "Contradicted implementation rule",
            node_type: "decision",
            properties: { accessed_at: NOW - 5 * DAY, importance: 0.6 },
          }),
          node({
            rid: 6,
            title: "Contradicting evidence",
            node_type: "decision",
            properties: { accessed_at: NOW - 5 * DAY, importance: 0.6 },
          }),
        ],
        [{ label: "CONTRADICTS", from: 5, to: 6 }],
        new Map([[3, 7]]),
      ),
      { now: NOW, stale_days: 90, deprecate_days: 180 },
    );

    expect(report.schema_version).toBe("memory.decay_plan.v1");
    expect(report.read_only).toBe(true);
    expect(report.status).toBe("attention");
    expect(report.summary).toMatchObject({
      considered_nodes: 6,
      keep: 1,
      review: 3,
      deprecate: 1,
      expire: 1,
      protected: 1,
      superseded: 1,
    });
    expect(report.keep[0]?.title).toBe("Pinned architecture decision");
    expect(report.review.map((item) => item.title)).toEqual(
      expect.arrayContaining([
        "Old unaccessed workflow",
        "Contradicted implementation rule",
        "Contradicting evidence",
      ]),
    );
    expect(report.deprecate[0]).toMatchObject({
      title: "Superseded cache guidance",
      superseded_by: 7,
    });
    expect(report.expire[0]?.title).toBe("Expired session note");
    expect(report.markdown).toContain("# Memory decay plan");

    const artifact = buildMemoryDecayViewerArtifact(report);
    expect(artifact).toMatchObject({
      name: "memory.decay.viewer",
      contract: {
        version: "memory.decay.viewer.v1",
        consumes: "memory.decay_plan.v1",
      },
    });
    expect(artifact.html).toContain("Memory Decay Plan");
    expect(artifact.html).toContain('id="memory-decay-data"');
  });

  test("CLI reports superseded deprecate candidates and writes viewer HTML", async () => {
    const root = await tempRoot();
    const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
    expect(init.status, init.stderr).toBe(0);

    const oldResult = runMemory(["store", "Decision: cache TTL is 60 seconds.", "--root", root]);
    const newResult = runMemory(["store", "Decision: cache TTL is 300 seconds.", "--root", root]);
    expect(oldResult.status, oldResult.stderr).toBe(0);
    expect(newResult.status, newResult.stderr).toBe(0);
    const oldRid = storedRid(oldResult.stdout);
    const newRid = storedRid(newResult.stdout);
    const supersede = runMemory([
      "supersede",
      String(oldRid),
      String(newRid),
      "--root",
      root,
      "--reason",
      "newer decision",
    ]);
    expect(supersede.status, supersede.stderr).toBe(0);

    const json = runMemory(["decay", "--root", root, "--json"]);
    expect(json.status, json.stderr).toBe(0);
    const body = JSON.parse(json.stdout) as {
      schema_version: string;
      read_only: boolean;
      summary: { deprecate: number };
      deprecate: Array<{ rid: number; superseded_by: number }>;
    };
    expect(body).toMatchObject({
      schema_version: "memory.decay_plan.v1",
      read_only: true,
      summary: { deprecate: 1 },
    });
    expect(body.deprecate[0]).toMatchObject({ rid: oldRid, superseded_by: newRid });

    const out = join(root, "decay.html");
    const viewer = runMemory(["decay-viewer", "--root", root, "--out", out]);
    expect(viewer.status, viewer.stderr).toBe(0);
    expect(viewer.stdout).toContain("memory: decay viewer written");
    const html = await readFile(out, "utf8");
    expect(html).toContain("Memory Decay Plan");
    expect(html).toContain("memory-decay-data");
    expect(html).toContain("cache TTL");
  }, TIMEOUT);
});

function storedRid(stdout: string): number {
  const match = stdout.match(/stored node (\d+)/);
  if (!match) throw new Error(`could not parse stored rid from ${stdout}`);
  return Number(match[1]);
}
