import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { encodingForModel } from "js-tiktoken";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAdmission, runAdmittedFixture } from "../src/admission.js";
import { runFidelityFixture, discoverFidelityFixtures } from "../src/fidelity.js";
import { RspElisionStore } from "../src/elision-store.js";
import { DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD, GIT_LOG_MACHINE_FIELDS, renderGitContract } from "../src/git-wrapper.js";

const roots: string[] = [];
const fixtureRoot = join(import.meta.dirname, "fixtures", "git");
const redFixtureRoot = join(import.meta.dirname, "fixtures", "fidelity-red");
const tokenizer = encodingForModel("gpt-4o");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-git-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp git fidelity fixtures", () => {
  it("auto-discovers git wrapper fixtures by directory convention", async () => {
    const fixtureNames = (await discoverFidelityFixtures(fixtureRoot)).map((fixture) => fixture.name).sort();

    expect(fixtureNames).toEqual([
      "blame-basic",
      "branch-av",
      "commit-created",
      "diff-large-numstat",
      "diff-numstat",
      "log-contract",
      "log-large-history",
      "push-porcelain",
      "push-rejected",
      "show-basic",
      "status-clean",
      "status-working-tree",
    ]);
  });

  it("renders git subcommands from recorded machine contracts as decodable TOON", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      for (const fixture of await discoverFidelityFixtures(fixtureRoot)) {
        if (fixture.name === "status-clean" || fixture.name === "push-rejected") continue;
        const result = await runFidelityFixture(fixture, { level: "full", store });
        expect(result.status).toBe(fixture.recorded.status);
        expect(result.stderr).toEqual(Buffer.from(fixture.recorded.stderr, "utf8"));
        expect(result.assertionFailures).toEqual([]);
        if (typeof fixture.expected === "string") {
          expect(result.stdout.toString("utf8")).toBe(fixture.expected);
        } else {
          expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
        }
      }
    } finally {
      await store.close();
    }
  });

  it("returns the definitive clean-tree empty state without minting a handle", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "status-clean")!;
      const result = await runFidelityFixture(fixture, { level: "brief", store });
      const decoded = decode(result.stdout.toString("utf8")) as { category: string; empty: boolean; scope: string; rows: unknown[] };

      expect(result.status).toBe(0);
      expect(decoded).toMatchObject({ category: "no-op", empty: true, scope: "git status" });
      expect(decoded.rows).toEqual([]);
      expect(result.mintedHandle).toBeUndefined();
      await expect(store.stats()).resolves.toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("mints a terse elision handle with the exact marker line and show can retrieve the original", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "status-working-tree")!;
      const result = await runFidelityFixture(fixture, { level: "terse", store });
      const stdout = result.stdout.toString("utf8");
      const marker = stdout.split("\n").at(-2)!;

      expect(marker).toMatch(/^… elided 2 rows \(\+\d+\) — rsp show el:[a-f0-9]{12}$/);
      expect(marker).toBe(`… elided 2 rows (+${result.bytesElided}) — rsp show ${result.mintedHandle}`);
      expect(result.mintedHandle).toBeDefined();

      const record = await store.get(result.mintedHandle!);
      if (!record || !("original" in record) || !record.original) throw new Error("expected live elision record");
      expect(decode(record.original.toString("utf8"))).toEqual(fixture.expected);
    } finally {
      await store.close();
    }
  });

  it("keeps small heavy git outputs full by default", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixtures = await discoverFidelityFixtures(fixtureRoot);
      for (const name of ["diff-numstat", "log-contract"]) {
        const fixture = fixtures.find((candidate) => candidate.name === name)!;
        const result = await runFidelityFixture(fixture, { level: "lossless", store });

        expect(result.mintedHandle).toBeUndefined();
        expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
      }
      await expect(store.stats()).resolves.toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("truncates large heavy git outputs by default while show recovers the full TOON", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixtures = await discoverFidelityFixtures(fixtureRoot);
      for (const name of ["diff-large-numstat", "log-large-history"]) {
        const fixture = fixtures.find((candidate) => candidate.name === name)!;
        const result = await runFidelityFixture(fixture, { level: "lossless", store });
        const stdout = result.stdout.toString("utf8");
        const marker = stdout.split("\n").at(-2)!;

        expect(marker).toMatch(/^… elided \d+ rows \(\+\d+\) — rsp show el:[a-f0-9]{12}$/);
        expect(result.mintedHandle).toBeDefined();
        expect(result.bytesElided).toBeGreaterThan(DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD);

        const record = await store.get(result.mintedHandle!);
        if (!record || !("original" in record) || !record.original) throw new Error("expected live elision record");
        expect(decode(record.original.toString("utf8"))).toEqual(fixture.expected);
      }
    } finally {
      await store.close();
    }
  });

  it("--full keeps large heavy git outputs lossless and skips handle minting", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = {
        ...(await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "diff-large-numstat")!,
        command: ["git", "diff", "--full"],
      };
      const result = await runFidelityFixture(fixture, { level: "lossless", store });

      expect(result.mintedHandle).toBeUndefined();
      expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
      await expect(store.stats()).resolves.toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("keeps --terse as an always-elide mode even below the default size threshold", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "diff-numstat")!;
      const result = await runFidelityFixture(fixture, { level: "terse", store });

      expect(result.mintedHandle).toBeDefined();
      const record = await store.get(result.mintedHandle!);
      if (!record || !("original" in record) || !record.original) throw new Error("expected live elision record");
      expect(decode(record.original.toString("utf8"))).toEqual(fixture.expected);
    } finally {
      await store.close();
    }
  });

  it("renders non-zero git status as a structured error with diagnostic stderr", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "push-rejected")!;
      const result = await runFidelityFixture(fixture, { level: "lossless", store });
      const decoded = decode(result.stdout.toString("utf8")) as { category: string; error: string; help: string[] };

      expect(result.status).toBe(1);
      expect(result.stderr).toEqual(Buffer.from("fatal: unable to access 'https://example.invalid/repo.git/': denied\n"));
      expect(decoded.category).toBe("real-error");
      expect(decoded.error).toContain("fatal: unable to access");
      expect(decoded.help).toEqual(["git push --help"]);
    } finally {
      await store.close();
    }
  });

  it.each(["--short", "-s"])("parses git status %s rows instead of reporting clean", async (flag) => {
    const result = await renderGitContract(["git", "status", flag], {
      stdout: [
        "## feature/rsp",
        " M apps/rsp/src/git-wrapper.ts",
        "?? apps/rsp/src/new-file.ts",
        "R  old-name.ts -> new-name.ts",
        "",
      ].join("\n"),
      stderr: "",
      status: 0,
      signal: null,
    }, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as {
      branch: string;
      rows: Array<{ path: string; index: string; worktree: string; state: string }>;
      summary: string;
    };

    expect(result.status).toBe(0);
    expect(decoded.branch).toBe("feature/rsp");
    expect(decoded.rows).toEqual([
      { path: "apps/rsp/src/git-wrapper.ts", index: ".", worktree: "M", state: "modified" },
      { path: "apps/rsp/src/new-file.ts", index: "?", worktree: "?", state: "untracked" },
      { path: "new-name.ts", index: "R", worktree: ".", state: "renamed" },
    ]);
    expect(decoded.summary).toContain("3 changes");
    expect(decoded.summary).not.toContain("clean");
  });

  it("fails open to raw stdout when git status output is non-empty but unparseable", async () => {
    const result = await renderGitContract(["git", "status", "--porcelain"], {
      stdout: "not a git status format\n",
      stderr: "",
      status: 0,
      signal: null,
    }, { level: "lossless" });

    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).toBe("not a git status format\n");
    expect(result.payload).toBeUndefined();
    expect(result.degradation).toMatchObject({ reason: "git-status-unparseable", family: "git status" });
  });

  it("reports git status clean only when status stdout is genuinely empty", async () => {
    const result = await renderGitContract(["git", "status", "--short"], {
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    }, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { category: string; empty: boolean; summary: string };

    expect(result.status).toBe(0);
    expect(decoded).toMatchObject({ category: "no-op", empty: true, summary: "git status clean: 0 changes" });
  });

  it("reports already-satisfied git push as an explicit no-op", async () => {
    const result = await renderGitContract(["git", "push"], {
      stdout: [
        "To github.com:reddb-io/red-skills.git",
        "=\trefs/heads/main:refs/heads/main\t[up to date]",
        "Done",
        "",
      ].join("\n"),
      stderr: "",
      status: 0,
      signal: null,
    }, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { category: string; noop: boolean; summary: string };

    expect(result.status).toBe(0);
    expect(decoded).toMatchObject({ category: "no-op", noop: true });
    expect(decoded.summary).toContain("already satisfied");
  });

  it("keeps commit-created and push-ref-update fixtures as compact TOON instead of scalar verdicts", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixtures = await discoverFidelityFixtures(fixtureRoot);
      for (const name of ["commit-created", "push-porcelain"]) {
        const fixture = fixtures.find((candidate) => candidate.name === name)!;
        const result = await runFidelityFixture(fixture, { level: "lossless", store });

        expect(result.oneLine).toBeUndefined();
        expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
        expect(result.assertionFailures).toEqual([]);
      }
    } finally {
      await store.close();
    }
  });

  it("keeps rejected push fixtures structured while bypassing the scalar fast-path", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "push-rejected")!;
      const result = await runFidelityFixture(fixture, { level: "lossless", store });
      const decoded = decode(result.stdout.toString("utf8")) as { category: string; error: string };

      expect(result.oneLine).toBeUndefined();
      expect(decoded.category).toBe("real-error");
      expect(decoded.error).toContain("fatal: unable to access");
      expect(result.assertionFailures).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("fails the suite when a fixture assertion is false even with positive token delta", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const [fixture] = await discoverFidelityFixtures(redFixtureRoot);
      const result = await runFidelityFixture(fixture!, { level: "lossless", store });

      expect(result.tokenDelta).toBeGreaterThan(0);
      expect(result.assertionFailures).toEqual([
        {
          question: "which branch was pushed?",
          expected: "main",
          actual: "refs/heads/feature/rsp",
        },
      ]);
    } finally {
      await store.close();
    }
  });
});

describe("rsp git admission harness", () => {
  it("reports per-filter median token delta with a real tokenizer and enforces passthrough below threshold", async () => {
    const fixtures = await discoverFidelityFixtures(fixtureRoot);
    const report = evaluateAdmission(fixtures, { thresholdPct: 60 });
    const commitRow = report.filters.find((row) => row.filter === "git:commit")!;
    const pushRow = report.filters.find((row) => row.filter === "git:push")!;

    expect(report.summary).toBe("0/8 filters active at threshold 60%");
    // git:commit's compact TOON rendering stays below the admission threshold.
    expect(commitRow).toMatchObject({ median_delta_pct: expect.any(Number), active: false, mode: "passthrough" });
    // git:push also stays passthrough when preserving pushed-ref rows would be a token regression.
    expect(pushRow).toMatchObject({ median_delta_pct: expect.any(Number), active: false, mode: "passthrough" });

    const tmp = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(tmp, "red.rdb")}` });
    try {
      const fixture = fixtures.find((candidate) => candidate.name === "commit-created")!;
      const result = await runAdmittedFixture(fixture, { thresholdPct: 60, level: "lossless", store });

      expect(result.mode).toBe("passthrough");
      expect(result.stdout).toEqual(Buffer.from(fixture.recorded.stdout, "utf8"));
    } finally {
      await store.close();
    }
  });
});

describe("rsp git token levers", () => {
  it("keeps git log on the lean four-field machine contract", () => {
    expect(GIT_LOG_MACHINE_FIELDS).toEqual(["%h", "%an", "%as", "%s"]);
    expect(GIT_LOG_MACHINE_FIELDS).not.toContain("%H");
    expect(GIT_LOG_MACHINE_FIELDS).not.toContain("%aI");
    expect(GIT_LOG_MACHINE_FIELDS).toHaveLength(4);
  });

  it("keeps the large log fixture at full fidelity with fewer recorded tokens than the redundant contract", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "log-large-history")!;
      const result = await runFidelityFixture(fixture, { level: "full", store });
      const previousRedundantStdout = toPreviousRedundantLogStdout(fixture.recorded.stdout);

      expect(result.assertionFailures).toEqual([]);
      expect(tokenizer.encode(fixture.recorded.stdout).length).toBeLessThan(tokenizer.encode(previousRedundantStdout).length);
    } finally {
      await store.close();
    }
  });

  it("filters row payloads with --query and appends contextual help", async () => {
    const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "status-working-tree")!;
    const result = await renderGitContract(["git", "status", "--query", "modified"], fixture.recorded, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { rows: Array<{ path: string; state: string }>; summary: string; help: string[] };

    expect(decoded.rows).toEqual([expect.objectContaining({ state: "modified" })]);
    expect(decoded.summary).toMatch(/^1\/3 changes:/);
    expect(decoded.help).toContain("rsp git diff --query <path>");
  });
});

function toPreviousRedundantLogStdout(stdout: string): string {
  return stdout.split("\0").filter(Boolean).map((record) => {
    const [short, author, date, subject] = record.replace(/^\x1e/, "").split("\x1f");
    const full = `${short}${"0".repeat(40)}`.slice(0, 40);
    return `\x1e${full}\x1f${short ?? ""}\x1f${author ?? ""}\x1f${date ?? ""}T12:34:56+00:00\x1f${subject ?? ""}`;
  }).join("\0") + "\0";
}

describe("fixture convention guard", () => {
  it("does not need a central registry file", async () => {
    const entries = await readdir(fixtureRoot);
    expect(entries).not.toContain("registry.json");
  });

  it("discovers nested fixture files", async () => {
    const root = await tempRoot();
    await mkdir(join(root, "git", "status"), { recursive: true });
    await writeFile(join(root, "git", "status", "clean.json"), JSON.stringify({
      name: "nested-clean",
      command: ["git", "status"],
      recorded: { stdout: "# branch.oid abc\0# branch.head main\0", stderr: "", status: 0, signal: null },
      expected: {
        command: "git status",
        category: "no-op",
        exit_code: 0,
        noop: true,
        scope: "git status",
        empty: true,
        branch: "main",
        rows: [],
        summary: "git status clean: 0 changes",
      },
      assertions: [],
    }));

    await expect(discoverFidelityFixtures(join(root, "git"))).resolves.toHaveLength(1);
  });
});
