import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { runOrphanBranchesReport } from "../src/commands/orphan-branches.js";
import { parseCli } from "../src/cli.js";

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let text = "";
  const stream = { write: (chunk: string) => { text += chunk; return true; } } as unknown as NodeJS.WritableStream;
  return { stream, text: () => text };
}

const BRANCHES = [
  { branch: "afk/2888-go-in-apps-redskilled-src-memory-sampler" },
  { branch: "afk/2891-empty-placeholder" },
  { branch: "afk/2892-already-in-review" },
];

const COMMITS: Record<string, number | undefined> = {
  "afk/2888-go-in-apps-redskilled-src-memory-sampler": 7,
  "afk/2891-empty-placeholder": 0,
  "afk/2892-already-in-review": 4,
};

function deps(overrides: Partial<Parameters<typeof runOrphanBranchesReport>[0]> = {}) {
  return {
    trunk: "main",
    // The census counts against the fresh REMOTE trunk, never the local branch:
    // a stale local `main` reads every landed branch as still ahead.
    baseRef: "origin/main",
    listBranches: () => Promise.resolve(BRANCHES),
    commitsAhead: (branch: string, base: string) =>
      Promise.resolve(base === "origin/main" ? COMMITS[branch] : 999),
    openPullRequests: () => Promise.resolve([{ number: 90, headRefName: "afk/2892-already-in-review" }]),
    ...overrides,
  };
}

describe("orphan-branches surface (#2893)", () => {
  it("lists branch, issue and commit count for work no PR carries", async () => {
    const out = sink();
    const code = await runOrphanBranchesReport(deps(), out.stream);

    expect(code).toBe(1);
    const report = decode(out.text()) as {
      report: string;
      trunk: string;
      scanned: number;
      orphaned: number;
      branches: Array<{ branch: string; issue: number; commits_ahead: number }>;
    };
    expect(report.report).toBe("orphan-branches");
    expect(report.trunk).toBe("main");
    expect(report.scanned).toBe(3);
    expect(report.orphaned).toBe(1);
    expect(report.branches).toEqual([
      { branch: "afk/2888-go-in-apps-redskilled-src-memory-sampler", issue: 2888, commits_ahead: 7 },
    ]);
  });

  it("exits 0 with an empty listing when every branch has a route to the trunk", async () => {
    const out = sink();
    const code = await runOrphanBranchesReport(
      deps({
        openPullRequests: () => Promise.resolve([
          { number: 90, headRefName: "afk/2892-already-in-review" },
          { number: 91, headRefName: "afk/2888-go-in-apps-redskilled-src-memory-sampler" },
        ]),
      }),
      out.stream,
    );

    expect(code).toBe(0);
    const report = decode(out.text()) as { orphaned: number; branches: unknown[] };
    expect(report.orphaned).toBe(0);
    expect(report.branches).toEqual([]);
  });

  it("marks an unread branch rather than collapsing it to empty", async () => {
    const out = sink();
    const code = await runOrphanBranchesReport(
      deps({
        listBranches: () => Promise.resolve([{ branch: "afk/2888-unreadable" }]),
        commitsAhead: () => Promise.resolve(undefined),
        openPullRequests: () => Promise.resolve([]),
      }),
      out.stream,
    );

    expect(code).toBe(1);
    const report = decode(out.text()) as { branches: Array<{ commits_ahead: number }> };
    expect(report.branches[0]?.commits_ahead).toBe(-1);
  });

  it("routes as a dev CLI command", () => {
    expect(parseCli(["orphan-branches"])).toEqual({ command: "orphan-branches", args: [] });
  });
});
