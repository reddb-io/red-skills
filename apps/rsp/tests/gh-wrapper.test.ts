import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAdmission, runAdmittedFixture } from "../src/admission.js";
import { discoverFidelityFixtures, runFidelityFixture } from "../src/fidelity.js";
import { RspElisionStore } from "../src/elision-store.js";
import { runGhApiRead } from "../src/gh-api-wrapper.js";
import { parseGhApiRead, renderGhContract } from "../src/gh-wrapper.js";

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
        if (fixture.expected === "" || fixture.name.endsWith("-body") || fixture.name.endsWith("-log")) {
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

  it("returns a definitive TOON empty PR state without minting a handle", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "pr-list-empty")!;
      const result = await runFidelityFixture(fixture, { level: "brief", store });
      const decoded = decode(result.stdout.toString("utf8")) as { empty: boolean; scope: string; prs: unknown[]; aggregate: { returned: number } };

      expect(result.status).toBe(0);
      expect(decoded).toMatchObject({
        empty: true,
        scope: "open PRs",
        prs: [],
        aggregate: { returned: 0 },
      });
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

  it("renders gh auth failures and rate limits as structured errors", async () => {
    const root = await tempRoot();
    const store = await RspElisionStore.open({ uri: `file://${join(root, "red.rdb")}` });
    try {
      const fixtures = await discoverFidelityFixtures(fixtureRoot);
      const auth = fixtures.find((candidate) => candidate.name === "issue-list-auth-failure")!;
      const rate = fixtures.find((candidate) => candidate.name === "run-list-rate-limit")!;

      const authResult = await runFidelityFixture(auth, { level: "lossless", store });
      const authError = decode(authResult.stdout.toString("utf8")) as { category: string; help: string[]; error: string };
      expect(authResult.status).toBe(1);
      expect(authResult.stderr).toEqual(Buffer.from("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.\n"));
      expect(authError).toMatchObject({ category: "real-error", help: ["gh auth login"] });
      expect(authError.error).toContain("GH_TOKEN");

      const rateResult = await runFidelityFixture(rate, { level: "lossless", store });
      const rateError = decode(rateResult.stdout.toString("utf8")) as { category: string; help: string[]; error: string };
      expect(rateResult).toMatchObject({
        status: 1,
        stderr: Buffer.from("API rate limit exceeded for installation ID 12345.\n"),
      });
      // A rate limit is transient and has nothing to do with the token (#2830).
      expect(rateError.category).toBe("transient");
      expect(rateError.help[0]).toMatch(/wait/i);
      expect(rateError.help[0]).not.toMatch(/auth/i);
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

describe("rsp gh token levers", () => {
  it("parses safe REST GETs for the resident and rejects writes or caller-owned projections", () => {
    expect(parseGhApiRead(["gh", "api", "repos/reddb-io/red-dev/actions/runs/31533509761", "-F", "per_page=20"])).toEqual({
      path: "repos/reddb-io/red-dev/actions/runs/31533509761",
      params: { per_page: 20 },
    });
    expect(parseGhApiRead(["gh", "api", "--method", "PUT", "repos/reddb-io/red-dev/pulls/108/merge"])).toBeNull();
    expect(parseGhApiRead(["gh", "api", "repos/reddb-io/red-dev/actions/runs", "--jq", ".workflow_runs"])).toBeNull();
  });

  it("renders a resident GitHub REST answer as canonical TOON", async () => {
    const result = await runGhApiRead(
      ["gh", "api", "repos/reddb-io/red-dev/actions/runs/31533509761"],
      async () => ({
        status: 0,
        stdout: JSON.stringify({ id: 31533509761, status: "in_progress", conclusion: null }),
        stderr: "",
        quotaFree: true,
      }),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.toString("utf8")).not.toContain("{");
    expect(decode(result.stdout.toString("utf8"))).toEqual({ id: 31533509761, status: "in_progress", conclusion: null });
  });

  it("filters list rows with --query and appends next-step help", async () => {
    const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "pr-list-default")!;
    const result = await renderGhContract(["gh", "pr", "list", "--query", "Draft"], fixture.recorded, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { prs: Array<{ title: string }>; summary: string; help: string[]; next_steps: string[] };

    expect(decoded.prs).toEqual([expect.objectContaining({ title: "Draft docs" })]);
    expect(decoded.summary).toBe("1/2 open PRs");
    expect(decoded.help).toContain("rsp gh pr <number>");
    expect(decoded.next_steps).toContain("rsp gh pr <number>");
  });

  it("keeps default list schemas minimal while exposing list aggregates", async () => {
    const fixtures = await discoverFidelityFixtures(fixtureRoot);
    const pr = await renderGhContract(["gh", "pr", "list"], fixtures.find((candidate) => candidate.name === "pr-list-default")!.recorded, { level: "lossless" });
    const issue = await renderGhContract(["gh", "issue", "list"], fixtures.find((candidate) => candidate.name === "issue-list-default")!.recorded, { level: "lossless" });
    const run = await renderGhContract(["gh", "run", "list"], fixtures.find((candidate) => candidate.name === "run-list-default")!.recorded, { level: "lossless" });

    const decodedPr = decode(pr.stdout.toString("utf8")) as { prs: Array<Record<string, unknown>>; aggregate: { returned: number } };
    const decodedIssue = decode(issue.stdout.toString("utf8")) as { issues: Array<Record<string, unknown>>; aggregate: { returned: number } };
    const decodedRun = decode(run.stdout.toString("utf8")) as { runs: Array<Record<string, unknown>>; aggregate: { returned: number; total: number } };

    expect(Object.keys(decodedPr.prs[0]!)).toEqual(["number", "title", "state", "draft"]);
    expect(Object.keys(decodedIssue.issues[0]!)).toEqual(["number", "title", "state", "labels"]);
    expect(Object.keys(decodedRun.runs[0]!)).toEqual(["id", "name", "status", "conclusion"]);
    expect(decodedPr.aggregate).toEqual({ returned: 2 });
    expect(decodedIssue.aggregate).toEqual({ returned: 2 });
    expect(decodedRun.aggregate).toEqual({ returned: 2, total: 7 });
  });

  it("returns a scoped TOON empty state for query-filtered zero-result lists", async () => {
    const fixture = (await discoverFidelityFixtures(fixtureRoot)).find((candidate) => candidate.name === "issue-list-default")!;
    const result = await renderGhContract(["gh", "issue", "list", "--label", "ready-for-agent", "--query", "no-match"], fixture.recorded, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { empty: boolean; scope: string; issues: unknown[]; aggregate: { returned: number; unfiltered: number }; help: string[] };

    expect(decoded).toMatchObject({
      empty: true,
      scope: "open issues label=ready-for-agent query=no-match",
      issues: [],
      aggregate: { returned: 0, unfiltered: 2 },
    });
    expect(decoded.help).toContain("rsp gh issue list --query <label-or-title>");
  });

  it("adds selected fields to list defaults and rejects unknown field names", async () => {
    const recorded = {
      stdout: JSON.stringify([
        {
          number: 42,
          title: "Add rsp gh wrapper",
          state: "OPEN",
          isDraft: false,
          author: { login: "octocat" },
          labels: [{ name: "ready-for-agent" }],
          url: "https://example.invalid/pr/42",
          updatedAt: "2026-07-17T00:00:00Z",
        },
      ]),
      stderr: "",
      status: 0,
      signal: null,
    };

    const result = await renderGhContract(["gh", "pr", "list", "--fields", "author,url"], recorded, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { prs: Array<Record<string, unknown>> };

    expect(decoded.prs[0]).toEqual({
      number: 42,
      title: "Add rsp gh wrapper",
      state: "open",
      draft: false,
      author: "octocat",
      url: "https://example.invalid/pr/42",
    });
    await expect(renderGhContract(["gh", "pr", "list", "--fields", "notAField"], recorded, { level: "lossless" })).rejects.toThrow(/unknown field: notAField/);
  });

  it("combines PR view, checks, and latest comments in one output", async () => {
    const recorded = {
      stdout: JSON.stringify({
        view: {
          number: 42,
          title: "Add rsp gh wrapper",
          state: "OPEN",
          isDraft: false,
          body: "Combined operation body",
          labels: [{ name: "ready-for-agent" }],
          author: { login: "octocat" },
          url: "https://example.invalid/pr/42",
          baseRefName: "main",
          headRefName: "feature",
        },
        checks: [
          { name: "test", state: "SUCCESS", bucket: "pass", conclusion: "SUCCESS", workflow: "ci", link: "https://example.invalid/check" },
          { name: "lint", state: "PENDING", bucket: "pending", conclusion: "", workflow: "ci", link: "https://example.invalid/lint" },
        ],
        comments: {
          comments: [
            { author: { login: "a" }, body: "first", createdAt: "2026-01-01T00:00:00Z" },
            { author: { login: "b" }, body: "second", createdAt: "2026-01-02T00:00:00Z" },
            { author: { login: "c" }, body: "third", createdAt: "2026-01-03T00:00:00Z" },
            { author: { login: "d" }, body: "fourth", createdAt: "2026-01-04T00:00:00Z" },
          ],
        },
      }),
      stderr: "",
      status: 0,
      signal: null,
    };

    const result = await renderGhContract(["gh", "pr", "42"], recorded, { level: "lossless" });
    const decoded = decode(result.stdout.toString("utf8")) as { pr: { number: number }; checks: unknown[]; comments: Array<{ body: string }>; help: string[] };

    expect(decoded.pr.number).toBe(42);
    expect(decoded.checks).toHaveLength(2);
    expect(decoded.comments.map((row) => row.body)).toEqual(["second", "third", "fourth"]);
    expect(decoded.help).toContain("rsp gh pr <number> --query <check-or-comment>");
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
