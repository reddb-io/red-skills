import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAdmission, runAdmittedFixture } from "../src/admission.js";
import { runFidelityFixture, discoverFidelityFixtures } from "../src/fidelity.js";
import { RspElisionStore } from "../src/elision-store.js";

const roots: string[] = [];
const fixtureRoot = join(import.meta.dirname, "fixtures", "git");
const redFixtureRoot = join(import.meta.dirname, "fixtures", "fidelity-red");

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
      "commit-created",
      "diff-large-numstat",
      "diff-numstat",
      "log-contract",
      "log-large-history",
      "push-porcelain",
      "push-rejected",
      "status-clean",
      "status-working-tree",
    ]);
  });

  it("renders five git subcommands from recorded machine contracts as decodable TOON", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      for (const fixture of await discoverFidelityFixtures(fixtureRoot)) {
        if (fixture.name === "status-clean" || fixture.name === "push-rejected") continue;
        const result = await runFidelityFixture(fixture, { level: "lossless", store });
        expect(result.status).toBe(fixture.recorded.status);
        expect(result.stderr).toEqual(Buffer.from(fixture.recorded.stderr, "utf8"));
        expect(result.assertionFailures).toEqual([]);
        expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
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

      expect(result.status).toBe(0);
      expect(result.stdout).toEqual(Buffer.from("git empty\n"));
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

  it("forwards non-zero git status and stderr byte-intact from fault fixtures", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "push-rejected")!;
      const result = await runFidelityFixture(fixture, { level: "lossless", store });

      expect(result.status).toBe(1);
      expect(result.stderr).toEqual(Buffer.from("fatal: unable to access 'https://example.invalid/repo.git/': denied\n"));
      expect(result.stdout).toEqual(Buffer.from(""));
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
    const pushRow = report.filters.find((row) => row.filter === "git:push")!;

    expect(report.summary).toBe("1/5 filters active at threshold 60%");
    expect(pushRow).toMatchObject({ median_delta_pct: expect.any(Number), active: false, mode: "passthrough" });

    const tmp = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(tmp, "red.rdb")}` });
    try {
      const fixture = fixtures.find((candidate) => candidate.name === "push-porcelain")!;
      const result = await runAdmittedFixture(fixture, { thresholdPct: 60, level: "lossless", store });

      expect(result.mode).toBe("passthrough");
      expect(result.stdout).toEqual(Buffer.from(fixture.recorded.stdout, "utf8"));
    } finally {
      await store.close();
    }
  });
});

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
      expected: "git empty\n",
      assertions: [],
    }));

    await expect(discoverFidelityFixtures(join(root, "git"))).resolves.toHaveLength(1);
  });
});
