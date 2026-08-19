import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildPrePrReviewViewerArtifact } from "../src/pre-pr-review-viewer.js";
import type { PrePrMemoryReview } from "../src/pre-pr-review.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function git(root: string, args: string[]) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: TIMEOUT });
  expect(result.status, result.stderr).toBe(0);
  return result;
}

async function tempGitRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-pre-pr-review-cli-"));
  roots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  git(root, ["init"]);
  git(root, ["config", "user.email", "memory@example.invalid"]);
  git(root, ["config", "user.name", "Memory Test"]);
  await writeFile(join(root, "src/auth.ts"), "export function rotateToken() { return 'old'; }\n");
  git(root, ["add", "src/auth.ts"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

async function seedReviewGraph(root: string): Promise<void> {
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  const file = await store.upsertNode({
    label: "file:src/auth.ts",
    node_type: "file",
    properties: { title: "src/auth.ts", content: "auth token code", source: "fixture" },
  });
  const symbol = await store.upsertNode({
    label: "sym:src/auth.ts#rotateToken",
    node_type: "symbol",
    properties: { title: "rotateToken", content: "token rotation function", source: "fixture" },
  });
  const concept = await store.upsertNode({
    label: "concept:jwt-rotation",
    node_type: "concept",
    properties: { title: "JWT rotation", content: "token rotation behavior", source: "fixture" },
  });
  const decision = await store.upsertNode({
    label: "decision:jwt-ttl",
    node_type: "decision",
    properties: { title: "JWT TTL policy", content: "Keep JWT TTL short.", source: "fixture" },
  });
  await store.upsertEdge({ label: "DEFINED_IN", from_rid: symbol, to_rid: file });
  await store.upsertEdge({ label: "REFERENCES", from_rid: symbol, to_rid: concept });
  await store.upsertEdge({ label: "MENTIONS", from_rid: decision, to_rid: concept });
  await store.close();
  stores.pop();
}

describe("memory pre-pr-review CLI", () => {
  test("renders a self-contained pre-PR review viewer artifact", () => {
    const review: PrePrMemoryReview = {
      comparison: "main...HEAD",
      changedFiles: ["src/auth.ts"],
      impactedConcepts: {
        missing: false,
        items: [{ title: "JWT rotation", summary: "token rotation behavior", evidence: [] }],
      },
      relatedDecisions: {
        missing: false,
        items: [{ title: "JWT TTL policy", summary: "Keep JWT TTL short.", evidence: [] }],
      },
      knownFailures: { missing: true, items: [] },
      suggestedValidations: { missing: true, items: [] },
      risks: { missing: true, items: [] },
      evidence: [],
      missingEvidence: ["known failures", "suggested validations", "risks"],
      readOnly: true,
    };

    const artifact = buildPrePrReviewViewerArtifact(review);

    expect(artifact.contract).toEqual({
      name: "memory.pre_pr_review.viewer",
      version: "memory.pre_pr_review.viewer.v1",
      consumes: "memory.pre-pr-review",
    });
    expect(artifact.html).toContain("<!doctype html>");
    expect(artifact.html).toContain("Pre-PR Memory Review");
    expect(artifact.html).toContain("JWT rotation");
    expect(artifact.html).toContain("JWT TTL policy");
    expect(artifact.html).toContain('id="pre-pr-review-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "reviews the current diff and a specified comparison range",
    async () => {
      const root = await tempGitRoot();
      await seedReviewGraph(root);
      await writeFile(join(root, "src/auth.ts"), "export function rotateToken() { return 'new'; }\n");

      for (const extraArgs of [[], ["--range", "HEAD"]]) {
        const result = runMemory(["pre-pr-review", "--root", root, "--json", ...extraArgs]);
        expect(result.status, result.stderr).toBe(0);
        const body = JSON.parse(result.stdout) as {
          changedFiles: string[];
          comparison: string | null;
          impactedConcepts: { items: Array<{ title: string }> };
          relatedDecisions: { items: Array<{ title: string; evidence: Array<{ marker: string }> }> };
        };
        expect(body.changedFiles).toEqual(["src/auth.ts"]);
        expect(body.impactedConcepts.items).toEqual([
          expect.objectContaining({ title: "JWT rotation" }),
        ]);
        expect(body.relatedDecisions.items).toEqual([
          expect.objectContaining({
            title: "JWT TTL policy",
            evidence: [expect.objectContaining({ marker: expect.stringMatching(/^\[\d+\]$/) })],
          }),
        ]);
      }
    },
    TIMEOUT,
  );

  test(
    "writes a local pre-PR review viewer for the current diff",
    async () => {
      const root = await tempGitRoot();
      await seedReviewGraph(root);
      await writeFile(join(root, "src/auth.ts"), "export function rotateToken() { return 'new'; }\n");
      const out = join(root, "pre-pr-review.html");

      const result = runMemory([
        "pre-pr-review-viewer",
        "--root",
        root,
        "--out",
        out,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: pre-PR review viewer written");
      expect(result.stdout).toContain(out);

      const html = await readFile(out, "utf8");
      expect(html).toContain("Pre-PR Memory Review");
      expect(html).toContain("src/auth.ts");
      expect(html).toContain("JWT rotation");
      expect(html).toContain("JWT TTL policy");
      expect(html).toContain('id="pre-pr-review-data"');
    },
    TIMEOUT,
  );
});
