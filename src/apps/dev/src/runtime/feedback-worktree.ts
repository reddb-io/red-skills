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
// When the worktree cannot be materialised (worktreeAdd failure) or the
// install fails, the gate fails closed: all validation calls return code 1.
// A failed setup never silently validates the primary checkout.

import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec as PnpmExec, PackageLayout } from "../core/feedback.js";
import type { BackpressureExec } from "../core/backpressure.js";
import { execTool, pnpm as runPnpm, type ExecOptions, type ExecOutput } from "./exec.js";
import * as gitx from "./git.js";

function slugForBranch(branch: string): string {
  return branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "wt";
}

/**
 * Split a feedback `-C` token into its worker branch and package scope.
 *
 * The feedback gate builds the token via `scopeDir(branch, scope)`: the branch
 * alone for the root scope, or `branch/<scope>` otherwise. AFK worker branches
 * are `afk/<id>/<N>-<slug>` — they contain slashes — so splitting at the FIRST
 * slash mis-parses them (#437: branch became `afk`, scope `<id>/<N>-<slug>`, and
 * `pnpm -C <root>/<id>/...` ENOENT'd, failing the gate on every afk/* branch).
 *
 * Instead peel the scope off the END: the scope is the shortest trailing path
 * suffix that is an existing package dir (`hasPackage`), and the branch is
 * everything before it. A token with no package suffix is a pure branch at the
 * root scope ("."). Package paths are full root-relative paths (e.g.
 * `src/apps/dev`), so only the genuine suffix matches — a branch slug segment
 * never collides.
 */
export function splitBranchDir(
  dir: string,
  hasPackage: (scope: string) => boolean,
): { branch: string; scope: string } {
  const parts = dir.split("/");
  for (let i = 1; i < parts.length; i++) {
    const scope = parts.slice(parts.length - i).join("/");
    if (hasPackage(scope)) {
      return { branch: parts.slice(0, parts.length - i).join("/"), scope };
    }
  }
  return { branch: dir, scope: "." };
}

/**
 * Injectable real-process surface for {@link makeFeedbackWorktree}. Production
 * wiring binds the real git worktree closures + the `pnpm`/`sh` executors from
 * exec.ts; tests substitute fakes so the whole manager — materialise, install,
 * script run, backpressure — exercises with zero subprocesses. (Spawning a real
 * `pnpm` from inside a vitest worker destabilised the tinypool worker pool.)
 */
export interface FeedbackWorktreeIO {
  worktreeAdd(ctx: gitx.GitContext, dest: string, branch: string): Promise<boolean>;
  worktreeRemove(ctx: gitx.GitContext, dest: string): Promise<void>;
  /** Run `pnpm <args>` with the given cwd. */
  pnpm(args: readonly string[], opts: ExecOptions): Promise<ExecOutput>;
  /** Run an arbitrary tool (used by the backpressure `sh -c` executor). */
  exec(cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecOutput>;
}

const defaultIO: FeedbackWorktreeIO = {
  worktreeAdd: gitx.worktreeAdd,
  worktreeRemove: gitx.worktreeRemove,
  pnpm: runPnpm,
  exec: execTool,
};

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
export function makeFeedbackWorktree(
  root: string,
  feedbackRoot: string,
  io: FeedbackWorktreeIO = defaultIO,
): FeedbackWorktree {
  const gitCtx: gitx.GitContext = { cwd: root };
  // branch -> resolved checkout path, or null when setup failed (block all runs).
  const resolved = new Map<string, string | null>();
  const created = new Set<string>();

  async function pathFor(branch: string): Promise<string | null> {
    if (!branch) return root;
    const cached = resolved.get(branch);
    if (cached !== undefined) return cached;
    const dest = join(feedbackRoot, slugForBranch(branch));
    const ok = await io.worktreeAdd(gitCtx, dest, branch);
    if (!ok) {
      process.stderr.write(
        `error: feedback worktree add failed for ${branch}; blocking validation\n`,
      );
      resolved.set(branch, null);
      return null;
    }
    // A freshly added worktree has NO node_modules. Without an install here,
    // the feedback gate's `pnpm -C <dest> test/build` calls fail with
    // `tsc/vite/svelte-kit: not found` — a FALSE validation failure that parks
    // otherwise-green work as blocked:validation (#458). Install before any
    // check can run.
    const ins = await io.pnpm(["install", "--frozen-lockfile"], { cwd: dest });
    if (ins.code !== 0) {
      // Lockfile drift on the branch, or a transient registry error. Remove the
      // partial checkout eagerly and block — continuing would silently validate
      // the wrong environment (binaries absent, wrong lockfile).
      await io.worktreeRemove(gitCtx, dest);
      process.stderr.write(
        `error: feedback worktree install failed for ${branch} (exit ${ins.code}); ` +
          `blocking validation\n${ins.stderr.trim()}\n`,
      );
      resolved.set(branch, null);
      return null;
    }
    created.add(dest);
    resolved.set(branch, dest);
    return dest;
  }

  // The layout probe only needs the package topology, which is identical across
  // branches (a worker rarely adds/removes packages); resolving it against the
  // primary checkout keeps `relevantScopes` synchronous as the interface
  // requires while still reflecting the real monorepo layout. It also drives
  // `splitBranchDir`'s scope-suffix detection below.
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

  // feedback hands pnpm a `-C <token>` arg where <token> is `<branch>` or
  // `<branch>/<scope>`. Peel the scope off the end (via the package layout),
  // materialise the branch, and rewrite the dir onto the real checkout path.
  const pnpm: PnpmExec = async (args) => {
    // args === ["pnpm", "-C", dir, script]
    const cIdx = args.indexOf("-C");
    if (cIdx >= 0 && args[cIdx + 1] !== undefined) {
      const { branch, scope } = splitBranchDir(args[cIdx + 1]!, layout.hasPackage);
      const base = await pathFor(branch);
      if (base === null) {
        return { code: 1, stdout: "", stderr: `feedback worktree setup failed for ${branch}; validation blocked` };
      }
      const rewritten = scope === "." ? base : join(base, scope);
      const rest = args.filter((_, i) => i !== 0 && i !== cIdx && i !== cIdx + 1);
      const r = await io.pnpm(["-C", rewritten, ...rest], { cwd: root });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    }
    const head = args[0] === "pnpm" ? args.slice(1) : args;
    const r = await io.pnpm(head, { cwd: root });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };

  // Backpressure commands are operator-declared shell strings (e.g. `npm run
  // test`) that run at the worker-branch checkout ROOT. `cwd` is the branch
  // token; materialise it the same way the pnpm executor does, then run the
  // command through `sh -c`, mirroring the lifecycle-hook executor. The gate
  // runs post-DONE, outside the progress guard and reaper, so it carries its own
  // bounded `timeoutMs` kill deadline: a hung command is killed and reads as a
  // non-zero failure (the exec edge reports KILLED_EXIT_CODE) instead of
  // deadlocking the worker (PRD #567).
  const backpressure: BackpressureExec = async ({ command, cwd, timeoutMs }) => {
    const dir = await pathFor(cwd);
    if (dir === null) {
      return { code: 1, stdout: "", stderr: `feedback worktree setup failed for ${cwd}; validation blocked` };
    }
    const r = await io.exec("sh", ["-c", command], { cwd: dir, timeoutMs });
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };

  return {
    pnpm,
    layout,
    backpressure,
    async cleanup() {
      for (const dest of created) {
        await io.worktreeRemove(gitCtx, dest);
      }
      created.clear();
      resolved.clear();
    },
  };
}
