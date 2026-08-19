import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { recall, stripFrontmatter, tokenize } from "../src/recall.js";
import { storeNote } from "../src/store.js";

const dirs: string[] = [];
async function tempNotes(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-recall-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("helpers", () => {
  test("tokenize lowercases and splits on non-word chars", () => {
    expect(tokenize("Postgres connection-pool, EXHAUSTED!")).toEqual([
      "postgres",
      "connection",
      "pool",
      "exhausted",
    ]);
  });

  test("stripFrontmatter removes a leading YAML block", () => {
    const raw = "---\nid: x\ncreated_at: y\n---\n\nthe body\n";
    expect(stripFrontmatter(raw).trim()).toBe("the body");
  });
});

describe("recall over notes", () => {
  test("empty notes dir yields no hits", async () => {
    const notes = await tempNotes();
    expect(await recall(notes, "anything")).toEqual([]);
  });

  test("blank query yields no hits", async () => {
    const notes = await tempNotes();
    await storeNote(notes, "the deploy script lives in scripts/deploy.sh");
    expect(await recall(notes, "   ")).toEqual([]);
  });

  test("ranks notes by term-match count", async () => {
    const notes = await tempNotes();
    await storeNote(notes, "redis cache redis eviction policy is allkeys-lru", new Date(1));
    await storeNote(notes, "the postgres primary handles writes", new Date(2));
    await storeNote(notes, "redis is used for sessions", new Date(3));

    const hits = await recall(notes, "redis");
    expect(hits).toHaveLength(2);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[1].score);
    expect(hits[0].excerpt).toContain("redis cache redis");
  });

  test("no match returns empty", async () => {
    const notes = await tempNotes();
    await storeNote(notes, "the postgres primary handles writes");
    expect(await recall(notes, "kafka")).toEqual([]);
  });
});
