import { describe, expect, it } from "vitest";
import { repoVisibility, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

/**
 * Repository visibility read (issue #1101): `gh repo view --json visibility`,
 * lower-cased into the {@link RepoVisibility} union the trust-gate folds into its
 * fail-closed default. A best-effort read — any failure or unrecognised value
 * degrades to `undefined` (treated as NON-public → permissive preserved).
 */

function ghReturning(stdout: string, code = 0): { ctx: GhContext; calls: string[][] } {
  const calls: string[][] = [];
  const out: ExecOutput = { code, stdout, stderr: "" };
  const exec: ExecFn = (_bin, args) => {
    calls.push([...args]);
    return Promise.resolve(out);
  };
  return { ctx: { cwd: "/r", repo: "acme/widgets", exec }, calls };
}

describe("repoVisibility (#1101)", () => {
  it("reads and lower-cases a PUBLIC repo", async () => {
    const { ctx, calls } = ghReturning(JSON.stringify({ visibility: "PUBLIC" }));
    expect(await repoVisibility(ctx)).toBe("public");
    // The routed REST read (#3730): a bare `gh api repos/{o}/{r}` — the repo
    // object already carries `visibility` at the top level.
    expect(calls[0]).toEqual(["api", "repos/acme/widgets"]);
  });

  it("reads a PRIVATE repo", async () => {
    const { ctx } = ghReturning(JSON.stringify({ visibility: "private" }));
    expect(await repoVisibility(ctx)).toBe("private");
  });

  it("reads an INTERNAL repo", async () => {
    const { ctx } = ghReturning(JSON.stringify({ visibility: "internal" }));
    expect(await repoVisibility(ctx)).toBe("internal");
  });

  it("degrades to undefined on a failed gh read", async () => {
    const { ctx } = ghReturning("", 1);
    expect(await repoVisibility(ctx)).toBeUndefined();
  });

  it("degrades to undefined on an unrecognised value", async () => {
    const { ctx } = ghReturning(JSON.stringify({ visibility: "mystery" }));
    expect(await repoVisibility(ctx)).toBeUndefined();
  });

  it("degrades to undefined on malformed JSON", async () => {
    const { ctx } = ghReturning("not json");
    expect(await repoVisibility(ctx)).toBeUndefined();
  });

  it("degrades to undefined with no call when ctx.repo is empty (worker's own checkout)", async () => {
    // The routed REST path needs an owner/repo pair to build `repos/{o}/{r}`
    // (#3730) — unlike the legacy `gh repo view` CLI, REST has no cwd-resolved
    // placeholder for the whole-repo endpoint, so an empty slug short-circuits
    // before any call is issued.
    const calls: string[][] = [];
    const exec: ExecFn = (_bin, args) => {
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ visibility: "public" }), stderr: "" });
    };
    expect(await repoVisibility({ cwd: "/r", repo: "", exec })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
