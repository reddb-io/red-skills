import { describe, expect, it } from "vitest";
import { renderMainRedRepairBody } from "../src/core/main-red-repair.js";
import { findMainRedRepairIssue, type GhContext } from "../src/runtime/gh.js";
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
    expect(calls[0]).toContain("--state");
    expect(calls[0]).toContain("open");
    expect(calls[0]).not.toContain("--search");
  });
});
