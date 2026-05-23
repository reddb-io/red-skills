import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-classify-cli-"));
  roots.push(root);
  return root;
}

describe("memory classify CLI", () => {
  test("classifies stable project rules as durable project memory", () => {
    const result = runMemory([
      "classify",
      "Project rule: all auth token TTL changes must update docs/security.md.",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      kind: string;
      recommendedTier: string;
      recommendedScope: string;
      safetyWarnings: unknown[];
      explanation: string;
    };

    expect(body).toMatchObject({
      kind: "store",
      recommendedTier: "durable",
      recommendedScope: "project",
      safetyWarnings: [],
    });
    expect(body.explanation).toContain("stable project rule");
  });

  test("classifies temporary progress as ephemeral instead of durable memory", () => {
    const result = runMemory([
      "classify",
      "Current progress: tests are running and I am halfway through the refactor.",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      kind: string;
      recommendedTier: string;
      recommendedScope: string;
      explanation: string;
    };

    expect(body).toMatchObject({
      kind: "ephemeral",
      recommendedTier: "ephemeral",
      recommendedScope: "session",
    });
    expect(body.explanation).toContain("temporary progress");
  });

  test("flags likely secret-like content before persistence", () => {
    const result = runMemory([
      "classify",
      "AWS_SECRET_ACCESS_KEY=abcd1234abcd1234abcd1234abcd1234abcd1234",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      kind: string;
      recommendedTier: string;
      recommendedScope: string;
      safetyWarnings: string[];
      explanation: string;
    };

    expect(body).toMatchObject({
      kind: "redact",
      recommendedTier: "ephemeral",
      recommendedScope: "session",
    });
    expect(body.safetyWarnings).toContain("likely-secret");
    expect(body.explanation).toContain("secret-like");
  });

  test("rejects raw task logs as durable facts", () => {
    const result = runMemory([
      "classify",
      "[12:00] running pnpm test\n[12:01] typecheck passed\n[12:02] committing",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      kind: string;
      recommendedTier: string;
      recommendedScope: string;
      explanation: string;
    };

    expect(body).toMatchObject({
      kind: "reject",
      recommendedTier: "ephemeral",
      recommendedScope: "agent-run",
    });
    expect(body.explanation).toContain("raw task log");
  });

  test("routes decision rationale into reasoning memory", () => {
    const result = runMemory([
      "classify",
      "Decision rationale: we chose the embedded graph store because it keeps Memory zero-ops.",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      kind: string;
      recommendedTier: string;
      recommendedScope: string;
      explanation: string;
    };

    expect(body).toMatchObject({
      kind: "reasoning",
      recommendedTier: "reasoning",
      recommendedScope: "project",
    });
    expect(body.explanation).toContain("decision rationale");
  });

  test("classifies durable user preferences with user scope", () => {
    const result = runMemory([
      "classify",
      "User preference: keep final answers under 70 lines.",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      kind: string;
      recommendedTier: string;
      recommendedScope: string;
      explanation: string;
    };

    expect(body).toMatchObject({
      kind: "store",
      recommendedTier: "durable",
      recommendedScope: "user",
    });
    expect(body.explanation).toContain("durable user preference");
  });

  test("scopes branch-specific facts narrowly", () => {
    const result = runMemory([
      "classify",
      "On branch afk/w6AM2, the worktree uses a temporary fixture path for issue 114.",
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as {
      kind: string;
      recommendedTier: string;
      recommendedScope: string;
      explanation: string;
    };

    expect(body).toMatchObject({
      kind: "scope-narrowly",
      recommendedTier: "durable",
      recommendedScope: "branch",
    });
    expect(body.explanation).toContain("branch-specific");
  });

  test("classifies without initializing or persisting memory state", async () => {
    const root = await tempRoot();
    const result = runMemory([
      "classify",
      "Project rule: keep release notes deterministic.",
      "--root",
      root,
      "--json",
    ]);

    expect(result.status, result.stderr).toBe(0);
    await expect(access(join(root, ".red"))).rejects.toThrow();
  });
});
