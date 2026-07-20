import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 60_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-cli-argument-binding-"));
  roots.push(root);
  const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

describe("memory CLI argument binding", () => {
  test("preserves repeated what-if flags before positional changes", async () => {
    const root = await initRoot();
    const result = runMemory([
      "whatif",
      "rename alpha to beta",
      "--change=edit src/a.ts#one",
      "--change",
      "delete src/b.ts",
      "--root",
      root,
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      changes: Array<{ description: string }>;
    };
    expect(body.changes.map((change) => change.description)).toEqual([
      "edit src/a.ts#one",
      "delete src/b.ts",
      "rename alpha to beta",
    ]);
  });

  test("binds repeated Evidence citations and privacy notes in order", async () => {
    const root = await initRoot();
    const result = runMemory([
      "evidence",
      "create",
      "--root",
      root,
      "--summary",
      "The CLI binds every repeated Evidence value.",
      "--source-ref",
      "issue 2251",
      "--citation=first|https://example.invalid/first|first quote",
      "--citation",
      "second|https://example.invalid/second|second quote",
      "--lesson",
      "Parse repeated values once at the CLI boundary.",
      "--privacy-note= review the first source ",
      "--privacy-note",
      "review the second source",
      "--privacy-note",
      " review the second source ",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      card: {
        citations: Array<{ label: string }>;
        privacy: { notes: string[] };
      };
    };
    expect(body.card.citations.map((citation) => citation.label)).toEqual(["first", "second"]);
    expect(body.card.privacy.notes).toEqual([
      "review the first source",
      "review the second source",
    ]);
  });
});
