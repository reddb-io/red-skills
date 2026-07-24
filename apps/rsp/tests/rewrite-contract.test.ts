/**
 * Rewrite contract suite for every family in RSP_WRAPPER_CAPABILITIES.
 *
 * Contract: for every supported family, the rsp wrapper must
 *   (1) exit 0 when the underlying command exits 0,
 *   (2) exit non-0 when the underlying command exits non-0,
 *   (3) pass stderr through verbatim in both cases,
 *   (4) include a recoverable el:<id> handle when stdout is elided.
 *
 * No family currently fails the contract, so the full rewrite set is active.
 * If a future family fails, delist it from RSP_WRAPPER_CAPABILITIES and add a
 * comment explaining why.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { renderGitContract, type RecordedGitContract } from "../src/git-wrapper.js";
import { renderGhContract } from "../src/gh-wrapper.js";
import { renderTestContract } from "../src/test-wrapper.js";
import { runGhBatchCommand } from "../src/gh-batch.js";
import { RSP_WRAPPER_CAPABILITIES } from "../src/intercept.js";
import { RspElisionStore } from "../src/elision-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-contract-"));
  roots.push(root);
  return root;
}

async function openStore(root: string): Promise<RspElisionStore> {
  return RspElisionStore.open({ uri: `file://${join(root, "contract.rdb")}` });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FAILURE_CONTRACT: RecordedGitContract = {
  stdout: "",
  stderr: "fatal: the operation failed",
  status: 1,
  signal: null,
};

const STDERR_TEXT = "warning: unrelated stderr output";

// Minimal valid stdout for each git subcommand (machine format used by collectGitContract).
const GIT_CONTRACTS: Record<string, { successStdout: string; argv: string[] }> = {
  "git:status": {
    argv: ["git", "status"],
    successStdout: "# branch.oid abc123\0# branch.head main\0",
  },
  "git:log": {
    argv: ["git", "log"],
    successStdout: "\x1e1111111\x1fAda\x1f2026-07-10\x1fAdd rsp wrapper\0",
  },
  "git:diff": {
    argv: ["git", "diff"],
    successStdout: "3\t1\tapps/rsp/src/cli.ts\0",
  },
  "git:commit": {
    argv: ["git", "commit"],
    successStdout: "[feature/rsp 1234567] Refs #1412 add wrapper\n 2 files changed, 40 insertions(+), 1 deletion(-)\n",
  },
  "git:push": {
    argv: ["git", "push"],
    successStdout: "To github.com:reddb-io/red-skills.git\n=\trefs/heads/main:refs/heads/main\t[up to date]\n \trefs/heads/feature/rsp:refs/heads/feature/rsp\t1111111..2222222\nDone\n",
  },
  "git:blame": {
    argv: ["git", "blame", "src/app.ts"],
    successStdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1\nauthor Ada Lovelace\nfilename src/app.ts\n\tconst x = 1;\n",
  },
  "git:branch:av": {
    argv: ["git", "branch", "-av"],
    successStdout: "*\0main\0abc1234\0origin/main\0\0Refs #1 baseline\n",
  },
  "git:show": {
    argv: ["git", "show"],
    successStdout: "\x1eabcdef1234567890abcdef1234567890abcdef12\x1fabcdef1\x1fAda Lovelace\x1f2026-07-13T07:30:00+00:00\x1fRefs #1616 add wrappers\x1fBody\x1e\n apps/rsp/src/git-wrapper.ts | 5 +++--\n 1 file changed, 3 insertions(+), 2 deletions(-)\n",
  },
};

// Minimal valid stdout for each gh subcommand (JSON body used by collectGhContract).
const GH_CONTRACTS: Record<string, { successStdout: string; argv: string[] }> = {
  "gh:pr:list": {
    argv: ["gh", "pr", "list"],
    successStdout: '[{"number":42,"title":"test","state":"OPEN","isDraft":false}]',
  },
  "gh:pr:view": {
    argv: ["gh", "pr", "view", "42"],
    successStdout: '{"number":42,"title":"test","state":"OPEN","isDraft":false,"body":""}',
  },
  "gh:issue:list": {
    argv: ["gh", "issue", "list"],
    successStdout: '[{"number":1,"title":"test","state":"OPEN","labels":[]}]',
  },
  "gh:issue:view": {
    argv: ["gh", "issue", "view", "1"],
    successStdout: '{"number":1,"title":"test","state":"OPEN","body":"","labels":[]}',
  },
  "gh:run:list": {
    argv: ["gh", "run", "list"],
    successStdout: '[{"databaseId":123,"name":"CI","status":"completed","conclusion":"success"}]',
  },
  "gh:run:view": {
    argv: ["gh", "run", "view", "123"],
    successStdout: '{"databaseId":123,"name":"CI","status":"completed","conclusion":"success","jobs":[]}',
  },
};

// Minimal valid stdout for each test runner.
const VITEST_SUCCESS_STDOUT = '{"numTotalTests":2,"numPassedTests":2,"numFailedTests":0,"startTime":1000000000000,"endTime":1000000001200,"testResults":[{"name":"math.test.ts","status":"passed","message":"","assertionResults":[{"fullName":"adds numbers","title":"adds numbers","status":"passed","duration":5}],"perfStats":{"runtime":1200}}]}';
const CARGO_SUCCESS_STDOUT = '{"type":"suite","event":"started","test_count":1}\n{"type":"test","event":"ok","name":"test_a","exec_time":0.01,"stdout":""}\n{"type":"suite","event":"ok","passed":1,"failed":0,"ignored":0,"measured":0,"filtered_out":0,"exec_time":0.1}\n';

const TEST_CONTRACTS: Record<string, { successStdout: string; argv: string[] }> = {
  vitest: { argv: ["vitest"], successStdout: VITEST_SUCCESS_STDOUT },
  "vitest:run": { argv: ["vitest", "run"], successStdout: VITEST_SUCCESS_STDOUT },
  "cargo:test": { argv: ["cargo", "test"], successStdout: CARGO_SUCCESS_STDOUT },
};

describe("rsp rewrite contract: all RSP_WRAPPER_CAPABILITIES families are covered", () => {
  const coveredIds = new Set([
    ...Object.keys(GIT_CONTRACTS),
    ...Object.keys(GH_CONTRACTS),
    ...Object.keys(TEST_CONTRACTS),
    "gh:issues:batch",
    "gh:prs:batch",
    "gh:edit-labels:batch",
    "gh:link-sub-issues:batch",
  ]);

  it("covers every capability in RSP_WRAPPER_CAPABILITIES", () => {
    const missing = RSP_WRAPPER_CAPABILITIES
      .map((c) => c.id)
      .filter((id) => !coveredIds.has(id));
    expect(missing, "these capability IDs lack contract tests").toEqual([]);
  });
});

describe("rsp rewrite contract: git family", () => {
  it.each(Object.entries(GIT_CONTRACTS))(
    "%s: exit 0 from underlying → wrapper exits 0",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: fixture.successStdout,
          stderr: "",
          status: 0,
          signal: null,
        };
        const result = await renderGitContract(fixture.argv, contract, { level: "full", store });
        expect(result.status).toBe(0);
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(GIT_CONTRACTS))(
    "%s: exit non-0 from underlying → wrapper exits non-0",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const result = await renderGitContract(fixture.argv, FAILURE_CONTRACT, { level: "full", store });
        expect(result.status).toBeTruthy();
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(GIT_CONTRACTS))(
    "%s: stderr from underlying is passed through on failure",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const result = await renderGitContract(fixture.argv, FAILURE_CONTRACT, { level: "full", store });
        expect(result.stderr.toString("utf8")).toBe(FAILURE_CONTRACT.stderr);
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(GIT_CONTRACTS))(
    "%s: stderr from underlying is passed through on success",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: fixture.successStdout,
          stderr: STDERR_TEXT,
          status: 0,
          signal: null,
        };
        const result = await renderGitContract(fixture.argv, contract, { level: "full", store });
        expect(result.stderr.toString("utf8")).toBe(STDERR_TEXT);
      } finally {
        await store.close();
      }
    },
  );
});

describe("rsp rewrite contract: gh list/view family", () => {
  it.each(Object.entries(GH_CONTRACTS))(
    "%s: exit 0 from underlying → wrapper exits 0",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: fixture.successStdout,
          stderr: "",
          status: 0,
          signal: null,
        };
        const result = await renderGhContract(fixture.argv, contract, { level: "full", store });
        expect(result.status).toBe(0);
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(GH_CONTRACTS))(
    "%s: exit non-0 from underlying → wrapper exits non-0",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const result = await renderGhContract(fixture.argv, FAILURE_CONTRACT, { level: "full", store });
        expect(result.status).toBeTruthy();
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(GH_CONTRACTS))(
    "%s: stderr from underlying is passed through on failure",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const result = await renderGhContract(fixture.argv, FAILURE_CONTRACT, { level: "full", store });
        expect(result.stderr.toString("utf8")).toBe(FAILURE_CONTRACT.stderr);
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(GH_CONTRACTS))(
    "%s: stderr from underlying is passed through on success",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: fixture.successStdout,
          stderr: STDERR_TEXT,
          status: 0,
          signal: null,
        };
        const result = await renderGhContract(fixture.argv, contract, { level: "full", store });
        expect(result.stderr.toString("utf8")).toBe(STDERR_TEXT);
      } finally {
        await store.close();
      }
    },
  );
});

describe("rsp rewrite contract: test runner family", () => {
  it.each(Object.entries(TEST_CONTRACTS))(
    "%s: exit 0 from underlying → wrapper exits 0",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: fixture.successStdout,
          stderr: "",
          status: 0,
          signal: null,
        };
        const result = await renderTestContract(fixture.argv, contract, { level: "full", store });
        expect(result.status).toBe(0);
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(TEST_CONTRACTS))(
    "%s: exit non-0 from underlying (parse failure path) → wrapper exits non-0",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: "",
          stderr: "fatal: build failed",
          status: 1,
          signal: null,
        };
        const result = await renderTestContract(fixture.argv, contract, { level: "full", store });
        expect(result.status).toBeTruthy();
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(TEST_CONTRACTS))(
    "%s: stderr from underlying is passed through on failure",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: "",
          stderr: "fatal: build failed",
          status: 1,
          signal: null,
        };
        const result = await renderTestContract(fixture.argv, contract, { level: "full", store });
        expect(result.stderr.toString("utf8")).toBe("fatal: build failed");
      } finally {
        await store.close();
      }
    },
  );

  it.each(Object.entries(TEST_CONTRACTS))(
    "%s: stderr from underlying is passed through on success",
    async (_, fixture) => {
      const root = await tempRoot();
      const store = await openStore(root);
      try {
        const contract: RecordedGitContract = {
          stdout: fixture.successStdout,
          stderr: STDERR_TEXT,
          status: 0,
          signal: null,
        };
        const result = await renderTestContract(fixture.argv, contract, { level: "full", store });
        expect(result.stderr.toString("utf8")).toBe(STDERR_TEXT);
      } finally {
        await store.close();
      }
    },
  );
});

describe("rsp rewrite contract: gh batch family", () => {
  const BATCH_CAPABILITIES = [
    "gh:issues:batch",
    "gh:prs:batch",
    "gh:edit-labels:batch",
    "gh:link-sub-issues:batch",
  ] as const;

  const BATCH_ARGV: Record<string, string[]> = {
    "gh:issues:batch": ["gh", "issues", "1", "--repo", "owner/repo"],
    "gh:prs:batch": ["gh", "prs", "1", "--repo", "owner/repo"],
    "gh:edit-labels:batch": ["gh", "edit-labels", "1", "--add", "bug", "--repo", "owner/repo"],
    // link-sub-issues takes positional numbers: parent then children (no --sub flag)
    "gh:link-sub-issues:batch": ["gh", "link-sub-issues", "1", "2", "--repo", "owner/repo"],
  };

  it.each(BATCH_CAPABILITIES)(
    "%s: exit 0 when gh returns valid data",
    async (capId) => {
      const argv = BATCH_ARGV[capId]!;
      const isRead = capId === "gh:issues:batch" || capId === "gh:prs:batch";
      const mockExec = async (_args: readonly string[]) => {
        if (isRead) {
          const mockItem = capId === "gh:prs:batch"
            ? '{"number":1,"title":"PR","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","statusCheckRollup":"SUCCESS","body":""}'
            : '{"number":1,"title":"Issue","state":"OPEN","labels":[],"body":""}';
          return { code: 0, stdout: `[${mockItem}]`, stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const result = await runGhBatchCommand(argv, { exec: mockExec });
      expect(result.status).toBe(0);
    },
  );

  // Read batch commands (issues, prs) return non-0 when the gh fetch fails.
  it.each(["gh:issues:batch", "gh:prs:batch"] as const)(
    "%s: exit non-0 when gh cannot fetch data",
    async (capId) => {
      const argv = BATCH_ARGV[capId]!;
      const mockExec = async (_args: readonly string[]) => ({
        code: 1,
        stdout: "",
        stderr: "GraphQL: unauthorized",
      });
      const result = await runGhBatchCommand(argv, { exec: mockExec });
      expect(result.status).not.toBe(0);
    },
  );

  // Mutation batch commands (edit-labels, link-sub-issues) always return 0 —
  // per-item failures are embedded in the payload, not in the exit code.
  it.each(["gh:edit-labels:batch", "gh:link-sub-issues:batch"] as const)(
    "%s: exits 0 even when operations fail; per-item errors embedded in payload",
    async (capId) => {
      const argv = BATCH_ARGV[capId]!;
      const mockExec = async (_args: readonly string[]) => ({
        code: 1,
        stdout: "",
        stderr: "API error",
      });
      const result = await runGhBatchCommand(argv, { exec: mockExec });
      expect(result.status).toBe(0);
      const payload = result.payload as Record<string, unknown>;
      // Per-item errors are nested under payload.issues (keyed by issue number).
      const issues = payload["issues"] as Record<string, unknown>;
      const hasError = Object.values(issues).some((v) => v !== null && typeof v === "object" && "error" in (v as object));
      expect(hasError, "payload.issues should contain at least one per-item error").toBe(true);
    },
  );
});

describe("rsp rewrite contract: elision handle on terse output", () => {
  it("git log: terse-elided output contains a recoverable el: handle", async () => {
    const root = await tempRoot();
    const store = await openStore(root);
    try {
      const manyCommits = Array.from(
        { length: 100 },
        (_, index) => `\x1e${String(index).padStart(7, "0")}\x1fAuthor\x1f2026-07-10\x1fcommit message ${index}\0`,
      ).join("");
      const contract: RecordedGitContract = {
        stdout: manyCommits,
        stderr: "",
        status: 0,
        signal: null,
      };
      const result = await renderGitContract(["git", "log"], contract, {
        level: "terse",
        store,
        heavyGitByteThreshold: 1,
      });
      expect(result.mintedHandle).toMatch(/^el:/);
      expect(result.stdout.toString("utf8")).toContain("rsp show el:");
    } finally {
      await store.close();
    }
  });

  it("gh pr list: terse-elided output contains a recoverable el: handle", async () => {
    const root = await tempRoot();
    const store = await openStore(root);
    try {
      // Build a valid JSON array of PR objects (not an array of strings).
      const manyPrsStdout = `[${Array.from(
        { length: 50 },
        (_, index) => `{"number":${index},"title":"PR ${index}","state":"OPEN","isDraft":false}`,
      ).join(",")}]`;
      const contract: RecordedGitContract = {
        stdout: manyPrsStdout,
        stderr: "",
        status: 0,
        signal: null,
      };
      const result = await renderGhContract(["gh", "pr", "list"], contract, {
        level: "terse",
        store,
      });
      expect(result.mintedHandle).toBeDefined();
      const stdout = result.stdout.toString("utf8");
      expect(stdout).toContain("el:");
    } finally {
      await store.close();
    }
  });
});

describe("rsp stats: per-family decision counts", () => {
  it("emptyTelemetryStats includes by_command_family as empty array", async () => {
    const { emptyTelemetryStats } = await import("../src/cli/stats.js");
    const stats = emptyTelemetryStats(30);
    expect(stats.decisions.by_command_family).toEqual([]);
  });

  it("statsPayload includes by_command_family in decisions", async () => {
    const { statsPayload, emptyTelemetryStats, emptyAccountingStats } = await import("../src/cli/stats.js");
    const telemetry = emptyTelemetryStats(30);
    const accountingStats = emptyAccountingStats(1_000_000);
    telemetry.decisions.by_command_family = [
      { command_family: "git status", contributed: 10, passed: 2, failed_open: 0, contribution_rate: 0.83 },
      { command_family: "gh pr list", contributed: 5, passed: 1, failed_open: 0, contribution_rate: 0.83 },
    ];
    const payload = statsPayload(accountingStats, telemetry, false);
    const decisionsPayload = payload.decisions as Record<string, unknown>;
    expect(decisionsPayload.by_command_family).toHaveLength(2);
    expect(decisionsPayload.by_command_family_elided).toBe(0);
  });

  it("statsPayload limits by_command_family to 5 entries in compact mode", async () => {
    const { statsPayload, emptyTelemetryStats, emptyAccountingStats } = await import("../src/cli/stats.js");
    const telemetry = emptyTelemetryStats(30);
    const accountingStats = emptyAccountingStats(1_000_000);
    telemetry.decisions.by_command_family = Array.from({ length: 10 }, (_, index) => ({
      command_family: `family:${index}`,
      contributed: 10 - index,
      passed: index,
      failed_open: 0,
      contribution_rate: (10 - index) / 10,
    }));
    const payload = statsPayload(accountingStats, telemetry, false);
    const decisionsPayload = payload.decisions as Record<string, unknown>;
    expect((decisionsPayload.by_command_family as unknown[]).length).toBe(5);
    expect(decisionsPayload.by_command_family_elided).toBe(5);
  });

  it("statsPayload includes all by_command_family entries in full mode", async () => {
    const { statsPayload, emptyTelemetryStats, emptyAccountingStats } = await import("../src/cli/stats.js");
    const telemetry = emptyTelemetryStats(30);
    const accountingStats = emptyAccountingStats(1_000_000);
    telemetry.decisions.by_command_family = Array.from({ length: 10 }, (_, index) => ({
      command_family: `family:${index}`,
      contributed: 10 - index,
      passed: index,
      failed_open: 0,
      contribution_rate: (10 - index) / 10,
    }));
    const payload = statsPayload(accountingStats, telemetry, true);
    const decisionsPayload = payload.decisions as Record<string, unknown>;
    expect((decisionsPayload.by_command_family as unknown[]).length).toBe(10);
    expect(decisionsPayload.by_command_family_elided).toBe(0);
  });
});
