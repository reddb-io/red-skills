// landing-quota.test.ts — verifies that the admin-PR landing path survives a
// GitHub quota window. The REST pull-request merge fails once with a rate-limit,
// the quota backoff waits (fake clock), and the retry succeeds so the landing
// completes without the attempt being discarded or the issue misrouted.

import { describe, expect, it, vi } from "vitest";
import { landPr } from "../src/core/merge.js";
import { mergeExec, type GitContext } from "../src/runtime/git.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import type { GhQuotaBackoffOpts } from "../src/runtime/gh/quota.js";
import { readsPull, restPullBody } from "./support/gh-rest-fixtures.js";

const REPO = "owner/repo";
const BRANCH = "afk/w1/42-fix";
const BASE = "main";
const ISSUE = 42;

const isRestMergeCall = (args: readonly string[]): boolean =>
  args.includes("PUT") && args.some((arg) => /\/pulls\/\d+\/merge$/.test(arg));

/**
 * Build a fake ExecFn that handles the minimal gh / git calls landPr issues.
 * `prMergeResponses` is drained in order so we can inject a rate-limit first.
 */
function buildFakeExec(prMergeResponses: ExecOutput[]): {
  exec: ExecFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  let mergeIdx = 0;
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const j = [cmd, ...args].join(" ");

    // gh pr list → return existing PR 77 so create is skipped
    if (cmd === "gh" && args.includes("list")) {
      return { code: 0, stdout: "77\n", stderr: "" };
    }
    // REST pull-request merge — drain the provided response queue
    if (cmd === "gh" && isRestMergeCall(args)) {
      const resp = prMergeResponses[mergeIdx++] ?? { code: 0, stdout: "", stderr: "" };
      return resp;
    }
    // gh pr view — the #2986 merge confirmation, answered by a forge that
    // merged the PR on the spot once the quota window closed.
    if (cmd === "gh" && readsPull(args)) {
      return {
        code: 0,
        stdout: JSON.stringify(
          restPullBody({
            state: "MERGED",
            mergedAt: "2026-08-01T00:00:00Z",
            mergeCommitOid: "deadbeef",
            autoMerge: false,
          }),
        ),
        stderr: "",
      };
    }
    // git update-ref (fleet trunk mirror promotion)
    if (cmd === "git" && args.includes("update-ref")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    // git rev-parse (resolve remote trunk sha for update-ref)
    if (cmd === "git" && args.includes("rev-parse")) {
      return { code: 0, stdout: "deadbeef\n", stderr: "" };
    }
    // Any other git command — succeed silently
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

describe("landing survives a github quota window", () => {
  it("retries the REST merge after a rate-limit and lands successfully (fake clock)", async () => {
    const { exec, calls } = buildFakeExec([
      // First attempt: REST 403 rate-limited
      { code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" },
      // Second attempt: success
      { code: 0, stdout: "", stderr: "" },
    ]);

    const sleptMs: number[] = [];
    const onWaitMs: number[] = [];
    const quotaBackoff: GhQuotaBackoffOpts = {
      nowMs: (() => {
        let now = 0;
        return () => {
          const t = now;
          now += 61_000; // each call advances the fake clock past the wait
          return t;
        };
      })(),
      sleepMs: async (ms) => { sleptMs.push(ms); },
      onWait: (r) => { onWaitMs.push(r); },
      defaultWaitMs: 60_000,
      capMs: 30 * 60 * 1000,
    };

    const ctx: GitContext = { cwd: "/repo", exec, quotaBackoff };
    const landExec = mergeExec(ctx);

    const result = await landPr(landExec, {
      repo: REPO,
      gitRepo: "/repo",
      remote: "origin",
      branch: BRANCH,
      target: BASE,
      n: ISSUE,
      title: "Fix something",
    });

    expect(result.ok).toBe(true);
    expect(result.prNumber).toBe(77);

    // Exactly one sleep fired (the quota wait between the two REST merge calls).
    expect(sleptMs.length).toBe(1);
    // onWait was called to signal 'quota-wait' activity.
    expect(onWaitMs.length).toBe(1);

    // The merged commit sha was resolved and returned.
    expect("mergeSha" in result && result.mergeSha).toBe("deadbeef");

    // Exactly two REST merge calls: the rate-limited one and the retry.
    const mergeCalls = calls.filter((c) => c[0] === "gh" && isRestMergeCall(c));
    expect(mergeCalls.length).toBe(2);
  });

  it("returns merge-failed after the quota cap is exceeded (never lands)", async () => {
    const { exec } = buildFakeExec([
      // All attempts rate-limited
      { code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" },
      { code: 1, stdout: "", stderr: "HTTP 403: API rate limit exceeded" },
    ]);

    const quotaBackoff: GhQuotaBackoffOpts = {
      nowMs: () => 0, // clock never advances → cap is immediately exceeded
      sleepMs: vi.fn(async () => {}),
      defaultWaitMs: 60_000,
      capMs: 0, // zero cap → first retry is refused
    };

    const ctx: GitContext = { cwd: "/repo", exec, quotaBackoff };
    const landExec = mergeExec(ctx);

    const result = await landPr(landExec, {
      repo: REPO,
      gitRepo: "/repo",
      remote: "origin",
      branch: BRANCH,
      target: BASE,
      n: ISSUE,
      title: "Fix something",
    });

    // Landing fails gracefully — it does NOT throw, and the reason is merge-failed
    // (the caller can park with an explicit quota reason rather than crashing).
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("merge-failed");
      expect(result.prNumber).toBe(77);
    }
    // sleep was NOT called (cap=0 means the wait is refused immediately)
    expect(quotaBackoff.sleepMs).not.toHaveBeenCalled();
  });
});
