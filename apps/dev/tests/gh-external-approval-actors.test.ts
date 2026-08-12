import { describe, expect, it } from "vitest";
import { externalApprovalActors, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

/**
 * External-origin approval marker read (issue #2603): `gh issue view --json comments`
 * → the logins of comment authors who posted an `/approve-external` marker. A
 * best-effort read — any gh failure degrades to `[]` so the claim-path gate treats
 * the issue as UNAPPROVED (held) rather than waving it through. Trust of each
 * returned login is resolved separately by the caller through `resolveActorTrust`;
 * this read never touches live GitHub in tests (the exec fn is stubbed).
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

// The routed read (#3730) hands consumers the raw REST comment rows —
// `user.login`, not the hand-projected `{author:{login}}` shape.
function comments(...cs: Array<{ login: string; body: string }>): string {
  return JSON.stringify(cs.map((c) => ({ user: { login: c.login }, body: c.body })));
}

describe("externalApprovalActors (#2603)", () => {
  it("returns the login of an author whose comment leads with /approve-external", async () => {
    const { ctx, calls } = ghReturning(comments({ login: "maint", body: "/approve-external looks good" }));
    expect(await externalApprovalActors(ctx, 42)).toEqual(["maint"]);
    expect(calls[0]).toEqual(["api", "--paginate", "repos/acme/widgets/issues/42/comments"]);
  });

  it("ignores the marker when it is merely quoted inside prose, not a leading command", async () => {
    const { ctx } = ghReturning(
      comments({ login: "chatty", body: "should I run `/approve-external` here? not sure" }),
    );
    expect(await externalApprovalActors(ctx, 42)).toEqual([]);
  });

  it("de-dupes a repeat approver and keeps distinct approvers", async () => {
    const { ctx } = ghReturning(
      comments(
        { login: "maint", body: "/approve-external" },
        { login: "maint", body: "/approve-external again" },
        { login: "other", body: "/approve-external" },
        { login: "noise", body: "no marker here" },
      ),
    );
    expect(await externalApprovalActors(ctx, 42)).toEqual(["maint", "other"]);
  });

  it("degrades to [] on a failed gh read (fail-safe: held, not released)", async () => {
    const { ctx } = ghReturning("", 1);
    expect(await externalApprovalActors(ctx, 42)).toEqual([]);
  });

  it("degrades to [] on malformed JSON", async () => {
    const { ctx } = ghReturning("not json");
    expect(await externalApprovalActors(ctx, 42)).toEqual([]);
  });

  it("returns [] when there are no comments", async () => {
    const { ctx } = ghReturning(JSON.stringify({ comments: [] }));
    expect(await externalApprovalActors(ctx, 42)).toEqual([]);
  });
});
