import { describe, expect, it } from "vitest";
import { renderMainRedRepairBody } from "../src/core/main-red-repair.js";
import { findMainRedRepairIssue, listMainRedRepairIssues, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn } from "../src/runtime/exec.js";

describe("findMainRedRepairIssue", () => {
  it("lists live open issues and selects the marked issue with the same failing set", async () => {
    const calls: string[][] = [];
    const matchingBody = renderMainRedRepairBody({
      sha: "aaaa",
      failures: [{ check: "test:apps/dev", summary: "tests failed", outputTail: "tail" }],
    });
    const otherBody = renderMainRedRepairBody({
      sha: "bbbb",
      failures: [{ check: "lint:apps/dev", summary: "lint failed", outputTail: "tail" }],
    });
    const exec: ExecFn = async (_cmd, args) => {
      calls.push([...args]);
      return {
        code: 0,
        stdout: JSON.stringify([
          { number: 20, title: "other", body: otherBody, labels: [] },
          { number: 21, title: "matching", body: matchingBody, labels: [{ name: "priority:urgent" }] },
        ]),
        stderr: "",
      };
    };
    const ctx: GhContext = { cwd: "/repo", repo: "acme/widgets", exec };

    const issue = await findMainRedRepairIssue(ctx, ["test:apps/dev"]);

    expect(issue?.number).toBe(21);
    // Explicit page params, never `--paginate --slurp`: `--slurp` needs gh >= 2.47
    // and an older host gh crashed every landing on the unknown flag.
    expect(calls[0]).not.toContain("--paginate");
    expect(calls[0]).not.toContain("--slurp");
    expect(calls[0]).toContain("repos/acme/widgets/issues?state=open&per_page=100&page=1");
  });

  it("examines every paginated open issue before selecting a match", async () => {
    const matchingBody = renderMainRedRepairBody({
      sha: "aaaa",
      failures: [{ check: "test:apps/dev", summary: "tests failed", outputTail: "tail" }],
    });
    const fullFirstPage = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      body: "unrelated",
      labels: [],
    }));
    const exec: ExecFn = async (_cmd, args) => {
      const path = args[args.length - 1] ?? "";
      const page = /[?&]page=([0-9]+)$/.exec(path)?.[1];
      return {
        code: 0,
        stdout: JSON.stringify(
          page === "1" ? fullFirstPage : [{ number: 321, body: matchingBody, labels: [] }],
        ),
        stderr: "",
      };
    };

    const issue = await findMainRedRepairIssue(
      { cwd: "/repo", repo: "acme/widgets", exec },
      ["test:apps/dev"],
    );

    expect(issue?.number).toBe(321);
  });

  it("propagates lookup failures instead of treating them as no match", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: "temporary GitHub failure" });

    await expect(listMainRedRepairIssues({ cwd: "/repo", repo: "acme/widgets", exec })).rejects.toThrow(
      "temporary GitHub failure",
    );
  });
});
