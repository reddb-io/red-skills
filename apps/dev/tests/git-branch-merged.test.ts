import { describe, expect, it } from "vitest";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import { branchMergedInto } from "../src/runtime/git.js";

/** A recording exec fake that matches on the FULL argv (joined), so the two
 * distinct `rev-parse` reads (local ref vs origin ref) can be scripted apart. */
function fakeExec(table: Array<{ match: string; out: ExecOutput }>, calls: string[][]): ExecFn {
  return (_cmd, args) => {
    calls.push([...args]);
    const joined = args.join(" ");
    const hit = table.find((t) => joined.includes(t.match));
    return Promise.resolve(hit?.out ?? { code: 1, stdout: "", stderr: "" });
  };
}

const ok = (stdout = ""): ExecOutput => ({ code: 0, stdout, stderr: "" });
const fail = (): ExecOutput => ({ code: 1, stdout: "", stderr: "" });

describe("branchMergedInto — the goal-predicate own-merge signal (ADR 0057)", () => {
  it("is true when the local branch tip is an ancestor of origin/<base> (it landed)", async () => {
    const calls: string[][] = [];
    const exec = fakeExec(
      [
        { match: "refs/heads/afk/w/1", out: ok("deadbee\n") }, // local branch head resolves
        { match: "merge-base --is-ancestor", out: ok() }, // exit 0 → ancestor → merged
      ],
      calls,
    );
    expect(await branchMergedInto({ cwd: "/wt", exec }, "afk/w/1", "main")).toBe(true);
    // It compared the resolved tip against origin/main.
    expect(calls.some((c) => c.join(" ") === "merge-base --is-ancestor deadbee origin/main")).toBe(true);
  });

  it("is false when the branch tip is NOT an ancestor of origin/<base> (a foreign close)", async () => {
    const exec = fakeExec(
      [
        { match: "refs/heads/afk/w/1", out: ok("deadbee\n") },
        { match: "merge-base --is-ancestor", out: fail() }, // exit 1 → not an ancestor
      ],
      [],
    );
    expect(await branchMergedInto({ cwd: "/wt", exec }, "afk/w/1", "main")).toBe(false);
  });

  it("falls back to the continuous-push origin/<branch> copy when no local ref exists", async () => {
    const calls: string[][] = [];
    const exec = fakeExec(
      [
        { match: "refs/heads/afk/w/1", out: fail() }, // no local ref
        { match: "refs/remotes/origin/afk/w/1", out: ok("cafef00d\n") }, // fetched origin copy
        { match: "merge-base --is-ancestor", out: ok() },
      ],
      calls,
    );
    expect(await branchMergedInto({ cwd: "/wt", exec }, "afk/w/1", "main")).toBe(true);
    expect(calls.some((c) => c.join(" ") === "merge-base --is-ancestor cafef00d origin/main")).toBe(true);
  });

  it("is false (never asks merge-base) when the branch tip resolves nowhere", async () => {
    const calls: string[][] = [];
    const exec = fakeExec([], calls); // every read fails
    expect(await branchMergedInto({ cwd: "/wt", exec }, "afk/w/1", "main")).toBe(false);
    expect(calls.some((c) => c[0] === "merge-base")).toBe(false);
  });

  it("is false for an empty branch or base without touching git", async () => {
    const calls: string[][] = [];
    const exec = fakeExec([], calls);
    expect(await branchMergedInto({ cwd: "/wt", exec }, "", "main")).toBe(false);
    expect(await branchMergedInto({ cwd: "/wt", exec }, "afk/w/1", "")).toBe(false);
    expect(calls).toEqual([]);
  });
});
