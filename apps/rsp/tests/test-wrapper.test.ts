import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAdmission, runAdmittedFixture } from "../src/admission.js";
import { discoverFidelityFixtures, runFidelityFixture } from "../src/fidelity.js";
import { RspElisionStore } from "../src/elision-store.js";

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
      "vitest-long-failure",
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
