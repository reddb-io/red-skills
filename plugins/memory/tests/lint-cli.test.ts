import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function tempRoot(prefix = "memory-lint-cli-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function initMarkdownRoot(): Promise<string> {
  const root = await tempRoot();
  const init = runMemory(["init", "--mode", "markdown-only", "--root", root, "--yes"]);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

async function writeNote(root: string, name: string, body: string): Promise<string> {
  const notesDir = join(root, ".red", "memory", "notes");
  await mkdir(notesDir, { recursive: true });
  const path = join(notesDir, `${name}.md`);
  await writeFile(path, body, "utf8");
  return path;
}

describe("memory lint CLI", () => {
  test("reports markdown-only memory hygiene findings as JSON without mutating notes", async () => {
    const root = await initMarkdownRoot();
    await writeNote(
      root,
      "good",
      [
        "---",
        "id: good",
        "scope: project",
        "tier: durable",
        "---",
        "",
        "Project rule: release notes must list user-visible changes first.",
        "",
      ].join("\n"),
    );
    await writeNote(
      root,
      "bad-progress",
      "Current progress: tests are running and I am halfway through the refactor.\n",
    );
    await writeNote(
      root,
      "bad-imperative",
      "Remember to always run pnpm test before committing this repo.\n",
    );
    await writeNote(
      root,
      "bad-secret",
      [
        "---",
        "id: bad-secret",
        "scope: project",
        "tier: durable",
        "---",
        "",
        "Credential placeholder found: AWS_SECRET_ACCESS_KEY = REDACTED.",
        "",
      ].join("\n"),
    );
    await writeNote(
      root,
      "dup-a",
      [
        "---",
        "id: dup-a",
        "scope: project",
        "tier: durable",
        "---",
        "",
        "Project rule: changelog entries use deterministic section order.",
        "",
      ].join("\n"),
    );
    await writeNote(
      root,
      "dup-b",
      [
        "---",
        "id: dup-b",
        "scope: project",
        "tier: durable",
        "---",
        "",
        "Project rule: changelog entry uses deterministic section ordering.",
        "",
      ].join("\n"),
    );

    const before = await Promise.all(
      (await readdir(join(root, ".red", "memory", "notes"))).map(async (file) => [
        file,
        await readFile(join(root, ".red", "memory", "notes", file), "utf8"),
      ]),
    );

    const result = runMemory(["lint", "--root", root, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      mode: string;
      readOnly: boolean;
      totalMemories: number;
      findings: Array<{ code: string; memoryId: string; relatedMemoryId?: string }>;
      ruleSuggestions: Array<{
        id: string;
        targetFiles: string[];
        evidence: string[];
        markdown: string;
      }>;
    };

    expect(body.mode).toBe("markdown-only");
    expect(body.readOnly).toBe(true);
    expect(body.totalMemories).toBe(6);
    expect(body.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "stale-progress-fact",
        "imperative-memory",
        "missing-scope",
        "missing-tier",
        "likely-secret",
        "duplicate-like",
      ]),
    );
    expect(body.findings.some((finding) => finding.memoryId === "good")).toBe(false);
    expect(body.ruleSuggestions.map((suggestion) => suggestion.id)).toEqual(
      expect.arrayContaining([
        "consolidate-duplicate-guidance",
        "keep-progress-ephemeral",
        "no-secrets-in-memory",
        "promote-imperatives-to-agent-rules",
        "require-memory-scope-and-tier",
      ]),
    );
    expect(
      body.ruleSuggestions.find((suggestion) => suggestion.id === "no-secrets-in-memory"),
    ).toMatchObject({
      targetFiles: ["AGENTS.md", "CLAUDE.md"],
      evidence: ["bad-secret"],
    });
    expect(
      body.ruleSuggestions.find(
        (suggestion) => suggestion.id === "consolidate-duplicate-guidance",
      )?.targetFiles,
    ).toContain(".red/CONTEXT.md");
    expect(body.ruleSuggestions.map((suggestion) => suggestion.markdown).join("\n")).toContain(
      "durable facts",
    );

    const after = await Promise.all(
      (await readdir(join(root, ".red", "memory", "notes"))).map(async (file) => [
        file,
        await readFile(join(root, ".red", "memory", "notes", file), "utf8"),
      ]),
    );
    expect(after).toEqual(before);
  }, TIMEOUT);

  test(
    "reports graph-mode hygiene findings and empty initialized state",
    async () => {
      const empty = await initMarkdownRoot();
      const emptyResult = runMemory(["lint", "--root", empty, "--json"]);
      expect(emptyResult.status, emptyResult.stderr).toBe(0);
      expect(JSON.parse(emptyResult.stdout)).toMatchObject({
        mode: "markdown-only",
        totalMemories: 0,
        findings: [],
      });

      const root = await tempRoot("memory-lint-graph-");
      const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
      expect(init.status, init.stderr).toBe(0);
      const first = runMemory([
        "store",
        "Current progress: tests are running for the graph lint implementation.",
        "--root",
        root,
      ]);
      expect(first.status, first.stderr).toBe(0);
      const second = runMemory([
        "store",
        "Remember to always inspect AWS_SECRET_ACCESS_KEY = REDACTED before storing memory.",
        "--root",
        root,
      ]);
      expect(second.status, second.stderr).toBe(0);

      const result = runMemory(["lint", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        mode: string;
        readOnly: boolean;
        totalMemories: number;
        findings: Array<{ code: string }>;
        ruleSuggestions: Array<{ id: string }>;
      };

      expect(body.mode).toBe("graph");
      expect(body.readOnly).toBe(true);
      expect(body.totalMemories).toBe(2);
      expect(body.findings.map((finding) => finding.code)).toEqual(
        expect.arrayContaining(["stale-progress-fact", "imperative-memory", "likely-secret"]),
      );
      expect(body.ruleSuggestions.map((suggestion) => suggestion.id)).toEqual(
        expect.arrayContaining([
          "keep-progress-ephemeral",
          "no-secrets-in-memory",
          "promote-imperatives-to-agent-rules",
        ]),
      );

      const text = runMemory(["lint", "--root", root]);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain("Rule suggestions:");
      expect(text.stdout).toContain("no-secrets-in-memory");
    },
    TIMEOUT,
  );

  test("degrades gracefully when memory is not initialized", async () => {
    const root = await tempRoot();
    const result = runMemory(["lint", "--root", root, "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: "uninitialized",
      status: "uninitialized",
      readOnly: true,
      totalMemories: 0,
      findings: [],
      ruleSuggestions: [],
    });
    await expect(access(join(root, ".red"))).rejects.toThrow();
  }, TIMEOUT);
});
