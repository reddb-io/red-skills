import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { encodingForModel } from "js-tiktoken";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { decode } from "@reddb-io/toon";
import recallCorpus from "./fixtures/recall-toon-corpus.json" with { type: "json" };
import { resolveNotesDir } from "../src/config.js";
import { initMarkdownOnly } from "../src/init.js";
import { storeNote } from "../src/store.js";
import { renderToonOutput } from "../src/toon-output.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-recall-toon-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });
}

async function rootWithRecallFacts(): Promise<string> {
  const root = await tempRoot();
  const { config } = await initMarkdownOnly(root);
  await storeNote(
    resolveNotesDir(root, config),
    "redis cache redis eviction policy is allkeys-lru",
    new Date("2026-01-02T03:04:05.006Z"),
  );
  return root;
}

const LEGACY_RECALL_BYTES = [
  "memory: 1 match(es) for \"redis\"",
  "  [2] 2026-01-02T03-04-05-006Z-redis-cache-redis-eviction-policy-is-allkeys-lru",
  "        redis cache redis eviction policy is allkeys-lru",
  "",
].join("\n");

describe("memory recall TOON output", () => {
  test("defaults to spec-decodable TOON with minimal item rows and a summary field", async () => {
    const root = await rootWithRecallFacts();

    const result = runMemory(["recall", "--root", root, "redis"]);

    expect(result.status, result.stderr).toBe(0);
    const decoded = decode(result.stdout) as {
      items: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    expect(decoded.items).toEqual([
      {
        id: "2026-01-02T03-04-05-006Z-redis-cache-redis-eviction-policy-is-allkeys-lru",
        score: 2,
        kind: "note",
        content: "redis cache redis eviction policy is allkeys-lru",
      },
    ]);
    expect(decoded.summary).toMatchObject({
      results: 1,
      store: "markdown",
      ranking: "term-count",
    });
  });

  test("--json preserves the pre-slice recall bytes exactly", async () => {
    const root = await rootWithRecallFacts();

    const result = runMemory(["recall", "--root", root, "redis", "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(LEGACY_RECALL_BYTES);
  });

  test("empty recall output is explicit and tells the agent what to try next", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);

    const result = runMemory(["recall", "--root", root, "kafka"]);

    expect(result.status, result.stderr).toBe(0);
    const decoded = decode(result.stdout) as { summary: Record<string, unknown>; next: string };
    expect(decoded.summary).toMatchObject({ status: "0 results", results: 0 });
    expect(decoded.next).toBe('try `memory store "..."` to add governed context, then rerun recall');
  });

  test("reports a measured token delta for representative recall payloads", () => {
    const payload = recallCorpus;
    const json = JSON.stringify(payload, null, 2);
    const toon = renderToonOutput({
      rowsKey: "items",
      rows: payload.items,
      fields: ["id", "score", "kind", "content"],
      summary: payload.summary,
    });
    const tokenizer = encodingForModel("gpt-4o");
    const jsonTokens = tokenizer.encode(json).length;
    const toonTokens = tokenizer.encode(toon).length;
    const reduction = ((jsonTokens - toonTokens) / jsonTokens) * 100;
    console.info(
      `memory recall token delta: json=${jsonTokens} toon=${toonTokens} reduction=${reduction.toFixed(1)}%`,
    );

    expect(Number.isFinite(reduction)).toBe(true);
    expect(decode(toon)).toEqual(payload);
  });
});
