// runtime/git-push.ts — the single code-writing surface of the cloud responder.
//
// The `/dev fix` mutation path (ADR 0064 §5, issue #752) is the ONLY place a
// cloud agent pushes a commit. It does so with `--force-with-lease` against the
// PR head: the agent rewrote the working tree off a known base, so the push must
// REFUSE to clobber if the remote branch advanced under it (a human pushed, or a
// concurrent agent did). `--force-with-lease` gives exactly that — a force that
// fails when the remote ref no longer matches the expected value — so a stale
// branch is surfaced as a failure rather than overwritten.
//
// Routed through the same injectable ExecFn seam as runtime/git.ts so tests
// drive the real argv assembly over a fake `git` without touching the OS.

import { execTool, type ExecFn } from "./exec.js";

/** Inputs for the force-with-lease push. */
export interface ForceWithLeasePush {
  /** The checkout the push runs from (where the agent committed). */
  cwd: string;
  /** The PR head branch name to push to. */
  branch: string;
  /** The remote to push to. Defaults to `origin`. */
  remote?: string;
  /** Optional injected exec boundary. Unset in production (real `git`). */
  exec?: ExecFn;
}

/** The outcome of a force-with-lease push. */
export interface PushResult {
  /** True only when the push landed (git exit 0). */
  pushed: boolean;
  /** True when the push was REFUSED because the remote branch advanced — the
   * stale-branch case `--force-with-lease` exists to catch. Never set when
   * `pushed` is true. */
  stale: boolean;
  /** git's stderr (the reason) on any non-zero exit; empty on success. */
  reason: string;
}

/** Substrings git emits when `--force-with-lease` declines a stale ref. Matched
 * case-insensitively against stderr to distinguish a safe stale refusal from any
 * other push failure (auth, no such remote, network). */
const STALE_MARKERS = ["stale info", "force-with-lease", "non-fast-forward", "fetch first", "rejected"];

/**
 * Push `HEAD` to `<remote>/<branch>` with `--force-with-lease`. Resolves with a
 * {@link PushResult}; NEVER throws on a non-zero git exit (the caller decides
 * what a failure means). A stale-branch refusal is reported with `stale:true` so
 * the responder can reply "the branch moved — rebase and re-ask" instead of
 * treating it as a generic error or, worse, retrying with a bare `--force`.
 */
export async function pushForceWithLease(push: ForceWithLeasePush): Promise<PushResult> {
  const remote = push.remote ?? "origin";
  const run = push.exec ?? execTool;
  const r = await run(
    "git",
    ["push", "--force-with-lease", remote, `HEAD:${push.branch}`],
    { cwd: push.cwd },
  );
  if (r.code === 0) return { pushed: true, stale: false, reason: "" };

  const stderr = r.stderr ?? "";
  const haystack = stderr.toLowerCase();
  const stale = STALE_MARKERS.some((m) => haystack.includes(m));
  return { pushed: false, stale, reason: stderr.trim() };
}
