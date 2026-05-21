import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
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
