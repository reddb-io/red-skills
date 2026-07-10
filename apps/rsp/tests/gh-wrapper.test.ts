import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAdmission, runAdmittedFixture } from "../src/admission.js";
import { discoverFidelityFixtures, runFidelityFixture } from "../src/fidelity.js";
import { RspElisionStore } from "../src/elision-store.js";

const roots: string[] = [];
const fixtureRoot = join(import.meta.dirname, "fixtures", "gh");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-gh-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp gh fidelity fixtures", () => {
  it("auto-discovers gh wrapper fixtures by directory convention", async () => {
    const fixtureNames = (await discoverFidelityFixtures(fixtureRoot)).map((fixture) => fixture.name).sort();

    expect(fixtureNames).toEqual([
      "issue-list-auth-failure",
      "issue-list-default",
      "issue-view-body",
      "pr-list-default",
      "pr-list-empty",
      "pr-view-body",
      "run-list-default",
      "run-list-rate-limit",
      "run-view-log",
    ]);
  });

  it("renders six gh subcommand surfaces from recorded --json contracts", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      for (const fixture of await discoverFidelityFixtures(fixtureRoot)) {
        if (fixture.expected === "" || fixture.expected === "0 open PRs — try: rsp gh issue list\n" || fixture.name.endsWith("-body") || fixture.name.endsWith("-log")) {
          continue;
        }
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

  it("returns a definitive empty PR state without minting a handle", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "pr-list-empty")!;
      const result = await runFidelityFixture(fixture, { level: "brief", store });

      expect(result.status).toBe(0);
      expect(result.stdout).toEqual(Buffer.from("0 open PRs — try: rsp gh issue list\n"));
      expect(result.mintedHandle).toBeUndefined();
      await expect(store.stats()).resolves.toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("truncates PR and issue bodies with size hints, --full escape, and an elision handle", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixtures = await discoverFidelityFixtures(fixtureRoot);
      for (const name of ["pr-view-body", "issue-view-body"]) {
        const fixture = fixtures.find((candidate) => candidate.name === name)!;
        const result = await runFidelityFixture(fixture, { level: "lossless", store });
        const decoded = decode(result.stdout.toString("utf8")) as { pr?: { body: TruncatedText }; issue?: { body: TruncatedText } };
        const body = decoded.pr?.body ?? decoded.issue?.body;

        expect(body?.truncated).toMatchObject({ hint: "--full", bytes: expect.any(Number), shown_bytes: expect.any(Number) });
        expect(body?.truncated.handle).toMatch(/^el:[a-f0-9]{12}$/);
        expect(result.assertionFailures).toEqual([]);

        const record = await store.get(body!.truncated.handle);
        if (!record || !("original" in record) || !record.original) throw new Error("expected live elision record");
        expect(record.original.toString("utf8")).toContain("force truncation");
      }
    } finally {
      await store.close();
    }
  });

  it("--full keeps large gh body/log fields lossless and skips handle minting", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = {
        ...(await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "run-view-log")!,
        command: ["gh", "run", "view", "9001", "--full"],
      };
      const result = await runFidelityFixture(fixture, { level: "lossless", store });
      const decoded = decode(result.stdout.toString("utf8")) as { run: { jobs: Array<{ log: string }> } };

      expect(decoded.run.jobs[0]!.log).toContain("final process summary");
      expect(result.mintedHandle).toBeUndefined();
      await expect(store.stats()).resolves.toMatchObject({ records: 0 });
    } finally {
      await store.close();
    }
  });

  it("forwards gh auth failures and rate limits byte-intact", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixtures = await discoverFidelityFixtures(fixtureRoot);
      const auth = fixtures.find((candidate) => candidate.name === "issue-list-auth-failure")!;
      const rate = fixtures.find((candidate) => candidate.name === "run-list-rate-limit")!;

      await expect(runFidelityFixture(auth, { level: "lossless", store })).resolves.toMatchObject({
        status: 4,
        stdout: Buffer.from(""),
        stderr: Buffer.from("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n"),
      });
      await expect(runFidelityFixture(rate, { level: "lossless", store })).resolves.toMatchObject({
        status: 1,
        stdout: Buffer.from(""),
        stderr: Buffer.from("API rate limit exceeded for installation ID 12345.\n"),
      });
    } finally {
      await store.close();
    }
  });
});

describe("rsp gh admission harness", () => {
  it("reports gh filters from fixture discovery and can pass through below threshold", async () => {
    const fixtures = await discoverFidelityFixtures(fixtureRoot);
    const report = evaluateAdmission(fixtures, { thresholdPct: 95 });
    const prRow = report.filters.find((row) => row.filter === "gh:pr")!;

    expect(report.filters.map((row) => row.filter)).toEqual(["gh:issue", "gh:pr", "gh:run"]);
    expect(prRow).toMatchObject({ median_delta_pct: expect.any(Number), active: false, mode: "passthrough" });

    const tmp = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(tmp, "red.rdb")}` });
    try {
      const fixture = fixtures.find((candidate) => candidate.name === "pr-list-default")!;
      const result = await runAdmittedFixture(fixture, { thresholdPct: 95, level: "lossless", store });

      expect(result.mode).toBe("passthrough");
      expect(result.stdout).toEqual(Buffer.from(fixture.recorded.stdout, "utf8"));
    } finally {
      await store.close();
    }
  });
});

interface TruncatedText {
  preview: string;
  truncated: {
    bytes: number;
    shown_bytes: number;
    hint: "--full";
    handle: `el:${string}`;
  };
}
