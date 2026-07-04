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
    // Passes the repo slug + the visibility json field.
    expect(calls[0]).toEqual(["repo", "view", "acme/widgets", "--json", "visibility"]);
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

  it("omits the repo slug when ctx.repo is empty (worker's own checkout)", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_bin, args) => {
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ visibility: "public" }), stderr: "" });
    };
    await repoVisibility({ cwd: "/r", repo: "", exec });
    expect(calls[0]).toEqual(["repo", "view", "--json", "visibility"]);
  });
});
