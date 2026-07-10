import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { decode } from "@reddb-io/toon";
import { initMarkdownOnly } from "../src/init.js";
import { resolveNotesDir } from "../src/config.js";
import { recall } from "../src/recall.js";
import { slugify, storeNote } from "../src/store.js";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-roundtrip-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("store", () => {
  test("slugify produces filename-safe slugs", () => {
    expect(slugify("Postgres pool EXHAUSTED!!!")).toBe("postgres-pool-exhausted");
    expect(slugify("")).toBe("note");
  });

  test("writes markdown with frontmatter and the fact as body", async () => {
    const notes = await (async () => {
      const r = await tempRoot();
      return resolveNotesDir(r, (await initMarkdownOnly(r)).config);
    })();
    const note = await storeNote(notes, "the cache TTL is 300 seconds");
    const raw = await readFile(note.path, "utf8");
    expect(raw).toMatch(/^---\nid: /);
    expect(raw).toContain("created_at:");
    expect(raw).toContain("the cache TTL is 300 seconds");
  });

  test("rejects an empty fact", async () => {
    const notes = await (async () => {
      const r = await tempRoot();
      return resolveNotesDir(r, (await initMarkdownOnly(r)).config);
    })();
    await expect(storeNote(notes, "   ")).rejects.toThrow(/empty/);
  });
});

describe("init → store → recall round-trip (markdown-only)", () => {
  test("a stored fact is recalled by a matching query", async () => {
    const root = await tempRoot();
    const { config } = await initMarkdownOnly(root);
    const notes = resolveNotesDir(root, config);

    await storeNote(notes, "the staging database password rotates every 90 days");

    const hits = await recall(notes, "database password rotation");
    expect(hits).toHaveLength(1);
    expect(hits[0].excerpt).toContain("password rotates every 90 days");
  });
});

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("memory recall --layer (issue #175)", () => {
  test("`--layer L3` returns the same hits as the default recall (no flag)", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    const store = runMemory([
      "store",
      "--root",
      root,
      "the staging database password rotates every 90 days",
    ]);
    expect(store.status).toBe(0);

    const defaultRun = runMemory(["recall", "--root", root, "database password rotation"]);
    const l3Run = runMemory(["recall", "--root", root, "--layer", "L3", "database password rotation"]);
    expect(defaultRun.status).toBe(0);
    expect(l3Run.status).toBe(0);
    expect(l3Run.stdout).toBe(defaultRun.stdout);
    expect(defaultRun.stdout).toMatch(/password rotates every 90 days/);
  });

  test("`--layer L1` and `--layer L2` return no hits while L1/L2 storage is not wired up", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    runMemory(["store", "--root", root, "the staging database password rotates every 90 days"]);

    for (const layer of ["L1", "L2"]) {
      const run = runMemory(["recall", "--root", root, "--layer", layer, "database password rotation"]);
      expect(run.status).toBe(0);
      expect(decode(run.stdout)).toMatchObject({
        items: [],
        summary: { status: "0 results", results: 0 },
      });
    }
  });

  test("an unknown layer value is rejected at the CLI", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    const run = runMemory(["recall", "--root", root, "--layer", "L4", "anything"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/invalid memory layer/);
  });
});
