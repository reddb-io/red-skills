import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAdmission, runAdmittedFixture } from "../src/admission.js";
import { discoverFidelityFixtures, runFidelityFixture } from "../src/fidelity.js";
import { RspElisionStore } from "../src/elision-store.js";
import { renderTestContract } from "../src/test-wrapper.js";

const roots: string[] = [];
const fixtureRoot = join(import.meta.dirname, "fixtures", "test-runners");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp test runner fidelity fixtures", () => {
  it("auto-discovers vitest and cargo fixtures by directory convention", async () => {
    const fixtureNames = (await discoverFidelityFixtures(fixtureRoot)).map((fixture) => fixture.name).sort();

    expect(fixtureNames).toEqual([
      "cargo-compile-error",
      "cargo-green",
      "cargo-red",
      "vitest-fault-green-nonzero",
      "vitest-green",
      "vitest-large-green",
      "vitest-long-failure",
      "vitest-many-failures",
      "vitest-mixed",
    ]);
  });

  it("emits summary-only TOON for green vitest and cargo suites", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      for (const fixture of (await discoverFidelityFixtures(fixtureRoot)).filter((candidate) => candidate.name.endsWith("-green"))) {
        const result = await runFidelityFixture(fixture, { level: "lossless", store });

        expect(result.status).toBe(0);
        expect(result.assertionFailures).toEqual([]);
        expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
        expect(result.stdout.toString("utf8")).not.toContain("failures:");
      }
    } finally {
      await store.close();
    }
  });

  it("emits failures-only rows plus summary for red and compile-error suites", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      for (const fixture of (await discoverFidelityFixtures(fixtureRoot)).filter((candidate) => ["vitest-mixed", "cargo-red", "cargo-compile-error"].includes(candidate.name))) {
        const result = await runFidelityFixture(fixture, { level: "lossless", store });
        const decoded = decode(result.stdout.toString("utf8"));

        expect(result.status).toBe(fixture.recorded.status);
        expect(result.assertionFailures).toEqual([]);
        expect(decoded).toEqual(fixture.expected);
      }
    } finally {
      await store.close();
    }
  });

  it("does not render a green summary when the recorded exit code is non-zero", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "vitest-fault-green-nonzero")!;
      const result = await runFidelityFixture(fixture, { level: "lossless", store });

      expect(result.status).toBe(1);
      expect(result.stdout).toEqual(Buffer.from(fixture.recorded.stdout, "utf8"));
      expect(result.stdout.toString("utf8")).not.toContain("0/2 failed");
    } finally {
      await store.close();
    }
  });

  it("mints an elision handle for over-limit failure excerpts and show can retrieve the full excerpt", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "vitest-long-failure")!;
      const result = await runFidelityFixture(fixture, { level: "lossless", store });
      const stdout = result.stdout.toString("utf8");

      expect(result.assertionFailures).toEqual([]);
      expect(stdout).toMatch(/… elided \d+ bytes \(\+\d+\) — rsp show el:[a-f0-9]{12}/);
      expect(result.mintedHandle).toBeDefined();

      const record = await store.get(result.mintedHandle!);
      if (!record || !("original" in record) || !record.original) throw new Error("expected live elision record");
      expect(record.original.toString("utf8")).toContain("received: \"line-001\"");
      expect(record.original.toString("utf8")).toContain("received: \"line-040\"");
    } finally {
      await store.close();
    }
  });
});

function decodeTerse(stdout: string): unknown {
  return decode(stdout.split("\n").filter((line) => !line.startsWith("… elided ")).join("\n"));
}

describe("rsp vitest terse failure budget", () => {
  it("caps inline failures to top-K and elides the remainder behind a retrievable handle", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "vitest-many-failures")!;
      const result = await runFidelityFixture(fixture, { level: "terse", store });
      const stdout = result.stdout.toString("utf8");
      const decoded = decodeTerse(stdout) as { summary: string; failures: unknown[] };

      // Rollup preserved; only the top-3 failures stay inline.
      expect(decoded.summary).toBe("5/8 failed · 2 suites · 3.2s");
      expect(decoded.failures).toHaveLength(3);
      expect(result.rowsElided).toBe(2);

      // A single handle behind an elision marker collapses the remaining failures.
      expect(stdout).toMatch(/… elided 2 failures \(\+\d+\) — rsp show el:[a-f0-9]{12}/);
      expect(result.mintedHandle).toBeDefined();

      // Full detail — all five failures — remains retrievable via `rsp show`.
      const record = await store.get(result.mintedHandle!);
      if (!record || !("original" in record) || !record.original) throw new Error("expected live elision record");
      const full = decode(record.original.toString("utf8")) as { failures: unknown[] };
      expect(full.failures).toHaveLength(5);
      expect(record.original.toString("utf8")).toContain("beta case five");
    } finally {
      await store.close();
    }
  });

  it("shortens each inline excerpt to first + last line under terse", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "vitest-long-failure")!;
      const result = await runFidelityFixture(fixture, { level: "terse", store });
      const decoded = decodeTerse(result.stdout.toString("utf8")) as { failures: { excerpt: string }[] };
      const excerpt = decoded.failures[0].excerpt;

      // First and last line survive; the middle is dropped.
      expect(excerpt).toContain("Snapshot mismatch");
      expect(excerpt).toContain('received: "line-040"');
      expect(excerpt).not.toContain('received: "line-020"');
      expect(excerpt).toContain("…");

      // Full excerpt stays retrievable even when no failures were dropped.
      expect(result.rowsElided).toBe(0);
      expect(result.mintedHandle).toBeDefined();
      const record = await store.get(result.mintedHandle!);
      if (!record || !("original" in record) || !record.original) throw new Error("expected live elision record");
      const full = decode(record.original.toString("utf8")) as { failures: { excerpt: string }[] };
      expect(full.failures[0].excerpt).toContain('received: "line-020"');
    } finally {
      await store.close();
    }
  });

  it("keeps the green-suite summary line unchanged under terse", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "vitest-green")!;
      const result = await runFidelityFixture(fixture, { level: "terse", store });

      expect(result.status).toBe(0);
      expect(result.mintedHandle).toBeUndefined();
      expect(result.stdout.toString("utf8")).not.toContain("… elided");
      expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
    } finally {
      await store.close();
    }
  });
});

describe("rsp test runner token levers", () => {
  it("filters failure rows with --query and appends contextual help", async () => {
    const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "vitest-many-failures")!;
    const result = await renderTestContract(["vitest", "--query", "beta case five"], fixture.recorded, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { summary: string; failures: Array<{ name: string }>; help: string[] };

    expect(decoded.failures).toEqual([expect.objectContaining({ name: "beta case five" })]);
    expect(decoded.summary).toContain("1/5 failures matched");
    expect(decoded.help).toContain("rsp vitest --query <suite-or-test>");
  });
});

describe("rsp test runner admission fixtures", () => {
  it("measures vitest and cargo deltas with the existing admission harness", async () => {
    const fixtures = await discoverFidelityFixtures(fixtureRoot);
    const report = evaluateAdmission(fixtures, { thresholdPct: 60 });

    expect(report.filters.find((row) => row.filter === "vitest:run")).toMatchObject({ active: true, mode: "active" });
    expect(report.filters.find((row) => row.filter === "cargo:test")).toMatchObject({ active: true, mode: "active" });

    const root = await tempRoot();
    await mkdir(root, { recursive: true });
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = fixtures.find((candidate) => candidate.name === "vitest-green")!;
      const result = await runAdmittedFixture(fixture, { thresholdPct: 60, level: "lossless", store });

      expect(result.mode).toBe("active");
      expect(decode(result.stdout.toString("utf8"))).toEqual(fixture.expected);
    } finally {
      await store.close();
    }
  });
});
