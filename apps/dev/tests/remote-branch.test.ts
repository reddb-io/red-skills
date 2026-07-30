import { describe, expect, it } from "vitest";
import {
  POST_COMMIT_HOOK_BODY,
  buildRef,
  buildRefFromSlug,
  deleteRemote,
  isValidRef,
  postCommitPushArgs,
  pushAttempt,
  pushInitial,
  slugifyRef,
  type GitExec,
  type GitExecResult,
} from "../src/core/remote-branch.js";

/** Fake GitExec that records every argv and replays a queued/constant result,
 * so the suite asserts the exact command without ever invoking git. */
function fakeGit(result: Partial<GitExecResult> = {}): { git: GitExec; calls: string[][] } {
  const calls: string[][] = [];
  const git: GitExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "", ...result };
  };
  return { git, calls };
}

describe("remote-branch ref construction", () => {
  it("builds and validates only the live namespace from a slug", () => {
    expect(buildRefFromSlug("afk", "wABC", 42, "fix-thing")).toBe("afk/42-fix-thing");
    // @ts-expect-error namespace narrowed to the one valid value
    expect(buildRefFromSlug("afk-attempts", "wABC", "42", "fix-thing")).toBeNull();
    expect(isValidRef("afk/42-fix-thing")).toBe(true);
    expect(isValidRef("afk/wABC/42-fix-thing")).toBe(true); // migration compatibility
    expect(isValidRef("afk-attempts/wABC/42-fix-thing")).toBe(false);
    expect(isValidRef("afk/wABC/42-fix/thing")).toBe(false);
  });

  it("rejects malformed inputs instead of building a bad ref", () => {
    expect(buildRefFromSlug("afk", "../bad", 1, "slug")).toBe("afk/1-slug"); // worker provenance is not in the ref
    expect(buildRefFromSlug("afk", "wOK", "1x", "slug")).toBeNull(); // non-numeric issue
    expect(buildRefFromSlug("afk", "wOK", 1, "Bad Slug")).toBeNull(); // un-slugified
    expect(buildRefFromSlug("afk", "wOK", 1, "nested/slug")).toBeNull(); // slug with slash
    // @ts-expect-error namespace narrowed to the valid value
    expect(buildRefFromSlug("personal", "wOK", 1, "slug")).toBeNull();
  });

  it("slugifies titles the same way as branch-ref.sh", () => {
    expect(slugifyRef("Fix the Thing!!")).toBe("fix-the-thing");
    expect(buildRef("afk", "wABC", 7, "Fix the Thing!!")).toBe("afk/7-fix-the-thing");
  });

  it("never ends in a trailing dash even when the 40-char slice lands mid-word (#442)", () => {
    // This exact title sliced to "…hide-a-duplicate-" → the malformed worktree
    // name behind `fatal: … is not a working tree`.
    const slug = slugifyRef("Memory soft-merge edge: hide a duplicate node from recall without deleting it");
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toBe("memory-soft-merge-edge-hide-a-duplicate");
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe("pushInitial (live namespace)", () => {
  it("pushes HEAD with upstream tracking and --force-with-lease", async () => {
    const { git, calls } = fakeGit();
    const out = await pushInitial(git, "/wt", "afk/wABC/42-slug");
    expect(out).toEqual({ ok: true, ran: true, status: "pushed" });
    expect(calls).toEqual([
      ["-C", "/wt", "push", "origin", "-u", "HEAD:refs/heads/afk/wABC/42-slug", "--force-with-lease"],
    ]);
  });

  it("is best-effort: a non-zero exec warns and does not throw", async () => {
    const { git, calls } = fakeGit({ code: 1 });
    const out = await pushInitial(git, "/wt", "afk/wABC/42-slug");
    expect(out.ok).toBe(true);
    expect(out.ran).toBe(true);
    expect(out.warn).toMatch(/initial push for afk\/wABC\/42-slug failed/);
    expect(calls).toHaveLength(1);
  });

  it("skips git entirely on an empty branch", async () => {
    const { git, calls } = fakeGit();
    const out = await pushInitial(git, "/wt", "");
    expect(out).toEqual({ ok: true, ran: false, status: "skipped", warn: expect.stringContaining("skipping") });
    expect(calls).toEqual([]);
  });
});

describe("post-commit hook push", () => {
  it("fires `git push origin HEAD --force-with-lease`", () => {
    expect(postCommitPushArgs()).toEqual(["push", "origin", "HEAD", "--force-with-lease"]);
  });

  it("ships a hook body with the push line and the load-bearing `|| true` guard", () => {
    expect(POST_COMMIT_HOOK_BODY).toContain("git push origin HEAD --force-with-lease");
    expect(POST_COMMIT_HOOK_BODY).toContain("|| true");
    expect(POST_COMMIT_HOOK_BODY.startsWith("#!/usr/bin/env bash")).toBe(true);
  });
});

describe("deleteRemote (live namespace only)", () => {
  it("deletes the live branch from the primary checkout", async () => {
    const { git, calls } = fakeGit();
    const out = await deleteRemote(git, "/repo", "afk/wABC/42-slug");
    expect(out).toEqual({ ok: true, ran: true, status: "pushed" });
    expect(calls).toEqual([["-C", "/repo", "push", "origin", "--delete", "afk/wABC/42-slug"]]);
  });

  it("never targets the afk-attempts forensic namespace", async () => {
    const { git, calls } = fakeGit();
    const out = await deleteRemote(git, "/repo", "afk-attempts/wABC/42-slug");
    expect(out).toMatchObject({ ok: true, ran: false });
    expect(calls).toEqual([]);
  });

  it("is best-effort: a non-zero exec warns and does not throw", async () => {
    const { git } = fakeGit({ code: 1 });
    const out = await deleteRemote(git, "/repo", "afk/wABC/42-slug");
    expect(out.ok).toBe(true);
    expect(out.ran).toBe(true);
    expect(out.warn).toMatch(/survives on origin/);
  });

  it("skips git entirely on an empty branch", async () => {
    const { git, calls } = fakeGit();
    const out = await deleteRemote(git, "/repo", "");
    expect(out).toEqual({ ok: true, ran: false, status: "skipped", warn: expect.stringContaining("skipping") });
    expect(calls).toEqual([]);
  });
});

describe("pushAttempt (live branch safety push)", () => {
  it("pushes a plain refspec into the live namespace (no --force-with-lease, no -u)", async () => {
    const { git, calls } = fakeGit();
    const out = await pushAttempt(git, "/repo", "afk/wABC/9-slug", "afk/wABC/9-slug");
    expect(out).toEqual({ ok: true, ran: true, status: "pushed" });
    expect(calls).toEqual([
      ["-C", "/repo", "push", "origin", "afk/wABC/9-slug:refs/heads/afk/wABC/9-slug"],
    ]);
    expect(calls[0]).not.toContain("--force-with-lease");
    expect(calls[0]).not.toContain("-u");
  });

  it("is best-effort: a non-zero exec returns ok:false (caller warns) without throwing", async () => {
    const { git } = fakeGit({ code: 1 });
    const out = await pushAttempt(git, "/repo", "afk/wABC/9-slug", "afk/wABC/9-slug");
    expect(out.ok).toBe(false);
    expect(out.ran).toBe(true);
    expect(out.warn).toMatch(/failed to push attempt branch to origin\/afk\/wABC\/9-slug/);
  });

  it("skips git entirely for afk-attempts refs", async () => {
    const { git, calls } = fakeGit();
    const out = await pushAttempt(git, "/repo", "afk/wABC/9-slug", "afk-attempts/wABC/9-slug");
    expect(out).toMatchObject({ ok: false, ran: false });
    expect(calls).toEqual([]);
  });

  it("skips git entirely on an empty branch or remote", async () => {
    const { git, calls } = fakeGit();
    expect((await pushAttempt(git, "/repo", "", "afk/wABC/9-slug")).ran).toBe(false);
    expect((await pushAttempt(git, "/repo", "afk/wABC/9-slug", "")).ran).toBe(false);
    expect(calls).toEqual([]);
  });
});
