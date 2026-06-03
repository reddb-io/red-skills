// runtime/feedback-worktree.ts — resolve the feedback gate's worktree seam.
//
// process-issue runs the feedback gate against a checkout of the *worker
// branch* sandcastle committed on, but it only ever holds the branch NAME (it
// passes `worktree: workerBranch` into runFeedback, and runFeedback turns that
// into a `pnpm -C <worktree>/<scope>` token). The real worker branch lives only
// on origin until AFK lands it, so feedback needs a concrete checkout.
//
// This manager closes that seam: given a branch token it lazily `git worktree
// add`s a temp checkout of the branch (fetching origin first) under
// `.red/tmp/feedback/<branch-slug>`, caches it for the run, and hands back the
// real path. It exposes the `pnpm` executor + `PackageLayout` probe the
// feedback gate consumes, both rebased onto the materialised checkout. Every
// worktree it created is torn down by `cleanup()` after the session.
//
// When the worktree cannot be materialised (e.g. tests, or an origin ref that
// never got pushed) it degrades to the primary checkout so feedback still runs
// the package topology rather than silently passing.

import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec as PnpmExec, PackageLayout } from "../core/feedback.js";
import type { BackpressureExec } from "../core/backpressure.js";
import { execTool, pnpm as runPnpm } from "./exec.js";
import * as gitx from "./git.js";

function slugForBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
}

export interface FeedbackWorktree {
  /** pnpm executor rebased onto the materialised worker-branch checkout. */
  pnpm: PnpmExec;
  /** Package layout probe rebased onto the materialised checkout. */
  layout: PackageLayout;
  /**
   * Shell executor for the backpressure gate (#430): runs an operator-declared
   * command via `sh -c` at the materialised worker-branch checkout root. `cwd`
   * is the branch token, materialised the same way the pnpm executor does.
   */
  backpressure: BackpressureExec;
  /** Remove every worktree this manager created (best-effort). */
  cleanup(): Promise<void>;
}

/**
 * Build a feedback worktree manager for one session. `root` is the primary
 * checkout; `feedbackRoot` is the dir temp checkouts live under (gitignored
 * `.red/tmp/feedback`). Worktrees are created on demand keyed by branch and
 * reused; `cleanup()` removes them all.
 */
export function makeFeedbackWorktree(root: string, feedbackRoot: string): FeedbackWorktree {
  const gitCtx: gitx.GitContext = { cwd: root };
  // branch -> resolved checkout path (the worktree, or root on fallback).
  const resolved = new Map<string, string>();
  const created = new Set<string>();

  async function pathFor(branch: string): Promise<string> {
    if (!branch) return root;
    const cached = resolved.get(branch);
    if (cached !== undefined) return cached;
    const dest = join(feedbackRoot, slugForBranch(branch));
    const ok = await gitx.worktreeAdd(gitCtx, dest, branch);
    const path = ok ? dest : root;
    if (ok) created.add(dest);
    resolved.set(branch, path);
    return path;
  }

  // feedback hands pnpm a `-C <token>` arg where <token> is
  // `<branch>` or `<branch>/<scope>`. Split the leading branch off, materialise
  // it, and rewrite the dir onto the real checkout path.
  function splitBranchDir(dir: string): { branch: string; scope: string } {
    const slash = dir.indexOf("/");
    if (slash < 0) return { branch: dir, scope: "." };
    return { branch: dir.slice(0, slash), scope: dir.slice(slash + 1) };
  }

  const pnpm: PnpmExec = async (args) => {
    // args === ["pnpm", "-C", dir, script]
    const cIdx = args.indexOf("-C");
    if (cIdx >= 0 && args[cIdx + 1] !== undefined) {
      const { branch, scope } = splitBranchDir(args[cIdx + 1]!);
      const base = await pathFor(branch);
      const rewritten = scope === "." ? base : join(base, scope);
      const rest = args.filter((_, i) => i !== 0 && i !== cIdx && i !== cIdx + 1);
      const r = await runPnpm(["-C", rewritten, ...rest], { cwd: root });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    }
    const head = args[0] === "pnpm" ? args.slice(1) : args;
    const r = await runPnpm(head, { cwd: root });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };

  // The layout probe only needs the package topology, which is identical across
  // branches (a worker rarely adds/removes packages); resolving it against the
  // primary checkout keeps `relevantScopes` synchronous as the interface
  // requires while still reflecting the real monorepo layout.
  const layout: PackageLayout = {
    hasPackage: (scope) => {
      const dir = scope === "." ? root : join(root, scope);
      try {
        accessSync(join(dir, "package.json"), constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    hasScript: (scope, script) => {
      const dir = scope === "." ? root : join(root, scope);
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          scripts?: Record<string, unknown>;
        };
        return Boolean(pkg.scripts && script in pkg.scripts);
      } catch {
        return false;
      }
    },
  };

  // Backpressure commands are operator-declared shell strings (e.g. `npm run
  // test`) that run at the worker-branch checkout ROOT. `cwd` is the branch
  // token; materialise it the same way the pnpm executor does, then run the
  // command through `sh -c`, mirroring the lifecycle-hook executor.
  const backpressure: BackpressureExec = async ({ command, cwd }) => {
    const dir = await pathFor(cwd);
    const r = await execTool("sh", ["-c", command], { cwd: dir });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };

  return {
    pnpm,
    layout,
    backpressure,
    async cleanup() {
      for (const dest of created) {
        await gitx.worktreeRemove(gitCtx, dest);
      }
      created.clear();
      resolved.clear();
    },
  };
}
