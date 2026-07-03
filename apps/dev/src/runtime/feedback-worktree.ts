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
//
// AFK runner improvement — cross-session worktree cache: by default, a
// materialised worktree whose branch HEAD matches the live branch's HEAD
// is REUSED across sessions (no `worktree add` / `submodule update` /
// `pnpm install` on re-claim). The worktree itself is the cache — it just
// isn't torn down if it was a cache hit. SHA mismatch (force-push, new
// commit) is the only invalidation signal; there is no mtime/TTL GC. The
// cost saved is `git submodule update --init --recursive` (5-30s) +
// `pnpm install --frozen-lockfile` (60-180s) per re-claim — the dominant
// cost when 5+ workers race-claim the same branch (Pattern 7 of the
// claude-minimax spike investigation). The flag is opt-out via
// `cacheEnabled: false` for callers that need a strict per-session manager.

import { accessSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec as PnpmExec, PackageLayout } from "../core/feedback.js";
import type { BackpressureExec } from "../core/backpressure.js";
import type { PostAttemptFormatExec } from "../core/post-attempt-format.js";
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
 * `apps/dev`), so only the genuine suffix matches — a branch slug segment
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
 *
 * AFK runner improvement: `branchHead` + `worktreeHead` enable the cross-session
 * cache. The manager calls `branchHead(gitCtx, branch)` to get the live branch's
 * HEAD SHA, then `worktreeHead(gitCtx, dest)` to read the SHA the cached
 * worktree is actually at. A match → cache hit (no install, no submodule init).
 * Mismatch (force-push, new commit) → cache miss (full re-materialise). Both
 * helpers return `null` on failure; the manager treats `null` as a cache miss
 * (the safe default — re-materialise from scratch).
 */
export interface FeedbackWorktreeIO {
  worktreeAdd(ctx: gitx.GitContext, dest: string, branch: string): Promise<boolean>;
  worktreeRemove(ctx: gitx.GitContext, dest: string): Promise<void>;
  /**
   * Resolve `branch` (local or remote) to its HEAD SHA. Returns `null` when
   * the ref is absent or git fails — the manager treats `null` as a cache
   * miss so a transient lookup failure never reuses a stale worktree.
   */
  branchHead(ctx: gitx.GitContext, branch: string): Promise<string | null>;
  /**
   * Read the HEAD SHA of a worktree rooted at `dest`. Returns `null` when
   * `dest` is not a git worktree (the cache miss signal) or git fails.
   */
  worktreeHead(ctx: gitx.GitContext, dest: string): Promise<string | null>;
  /**
   * Best-effort `git -C dest rebase <base>` (Pattern 2 of the claude-minimax
   * spike investigation). A worker's branch is forked from main at T0; by the
   * time the feedback gate runs at T1, main has moved and the worker's tests
   * can be stale (a test that expected 2 env vars but the function now
   * returns 3, the wPB6F/wQYIB CLAUDE_CODE_SIMPLE incident). Rebasing the
   * worker's branch onto current main BEFORE the gate re-syncs the source so
   * the test runs against the latest. On conflict → returns `ok: false` with
   * the stderr so the manager can abort and fall through to the baseline
   * probe. On rebase error → returns `ok: false` with the reason. Never
   * throws — the gate still has to run.
   */
  rebase(ctx: gitx.GitContext, dest: string, base: string): Promise<{ ok: true } | { ok: false; stderr: string }>;
  /** Run `pnpm <args>` with the given cwd. */
  pnpm(args: readonly string[], opts: ExecOptions): Promise<ExecOutput>;
  /** Run an arbitrary tool (used by the backpressure `sh -c` executor). */
  exec(cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecOutput>;
}

const defaultIO: FeedbackWorktreeIO = {
  worktreeAdd: gitx.worktreeAdd,
  worktreeRemove: gitx.worktreeRemove,
  branchHead: async (ctx, branch) => (await gitx.branchHead(ctx, branch)) ?? null,
  worktreeHead: async (_ctx, dest) => {
    // `git -C dest rev-parse --short HEAD`. Returns null on any failure so the
    // manager can treat it as a cache miss and re-materialise from scratch.
    try {
      const sha = await gitx.headShortSha({ cwd: dest });
      return sha === "" ? null : sha;
    } catch {
      return null;
    }
  },
  rebase: async (_ctx, dest, base) => {
    // `git -C dest rebase <base>`. On conflict (exit non-zero) or any other
    // failure: abort the rebase so the worktree is left in its ORIGINAL state
    // (never mid-rebase, which would make the next git op refuse to start),
    // then return `ok: false` with the stderr. The caller (the manager) lets
    // the gate run as-is + the baseline probe catches the resulting test drift.
    const r = await execTool("git", ["-C", dest, "rebase", base], { cwd: dest });
    if (r.code === 0) return { ok: true };
    // Swallow abort failures — worst case is a "rebase in progress" warning on
    // the next invocation; the manager surfaces the original stderr regardless.
    await execTool("git", ["-C", dest, "rebase", "--abort"], { cwd: dest });
    return { ok: false, stderr: r.stderr.trim() };
  },
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
  /**
   * Shell executor for the post-attempt-format step (#1015): runs an
   * operator-declared command via `sh -c` at the materialised worker-branch
   * checkout root, then — if exit 0 left the checkout dirty — stages, commits
   * (`style: <cmd>`), and pushes `HEAD:<branch>` to origin. `cwd` is the
   * branch token (materialised the same way as the pnpm/backpressure executors).
   */
  postAttemptFormat: PostAttemptFormatExec;
  /** Remove every worktree this manager created in THIS session (best-effort). */
  cleanup(): Promise<void>;
}

/** Optional configuration for {@link makeFeedbackWorktree}. */
export interface FeedbackWorktreeOptions {
  /**
   * AFK runner improvement: when true (the default), a materialised worktree
   * whose branch HEAD matches the live branch's HEAD is REUSED across sessions
   * (no `worktree add` / `submodule update` / `pnpm install` on re-claim).
   * Set to false for callers that need a strict per-session manager — the
   * worktree is torn down on `cleanup()` and the next session materialises
   * fresh. Tests typically want the per-session behaviour to keep fixtures
   * independent.
   */
  cacheEnabled?: boolean;
  /**
   * AFK runner improvement (Pattern 2): when set to a base branch, a freshly
   * materialised worker worktree is rebased onto that base BEFORE the gate
   * runs, so a worker test written against a now-moved main (the
   * wPB6F/wQYIB CLAUDE_CODE_SIMPLE drift) validates against the latest source
   * rather than failing on stale expectations. Best-effort: a rebase conflict
   * is aborted (the worktree is left in its original state) and the gate runs
   * as-is — the already-shipped baseline probe then downgrades any resulting
   * pre-existing failure. OFF by default (undefined) — the caller opts in
   * only when the session base is unambiguous (no per-issue pin), since
   * rebasing a pinned-base issue onto main would be wrong. The rebase is
   * skipped on a cache hit (the cached worktree is already at the branch HEAD;
   * re-rebasing would invalidate the cache for no benefit).
   */
  rebaseOnto?: string;
}

/**
 * Build a feedback worktree manager for one session. `root` is the primary
 * checkout; `feedbackRoot` is the dir temp checkouts live under (gitignored
 * `.red/tmp/feedback`). Worktrees are created on demand keyed by branch and
 * reused; `cleanup()` removes only what THIS session created (cached
 * worktrees from prior sessions are left in place for the next session).
 */
export function makeFeedbackWorktree(
  root: string,
  feedbackRoot: string,
  io: FeedbackWorktreeIO = defaultIO,
  options: FeedbackWorktreeOptions = {},
): FeedbackWorktree {
  const cacheEnabled = options.cacheEnabled !== false; // default: ON
  const rebaseOnto = options.rebaseOnto; // default: undefined (OFF)
  const gitCtx: gitx.GitContext = { cwd: root };
  // branch -> resolved checkout path, or null when setup failed (block all runs).
  const resolved = new Map<string, string | null>();
  // Worktrees created in THIS session — these are the only ones `cleanup()`
  // removes. A cache hit (worktree reused from a prior session) is NOT in
  // this set, so cleanup leaves it alone.
  const created = new Set<string>();

  async function pathFor(branch: string): Promise<string | null> {
    if (!branch) return root;
    const cached = resolved.get(branch);
    if (cached !== undefined) return cached;
    const dest = join(feedbackRoot, slugForBranch(branch));

    // AFK runner improvement — cross-session cache: a worktree already at
    // `dest` whose HEAD matches the live branch's HEAD is a cache hit. The
    // cost saved is `git submodule update --init --recursive` (5-30s) +
    // `pnpm install --frozen-lockfile` (60-180s) per re-claim — the dominant
    // cost when 5+ workers race-claim the same branch (Pattern 7 of the
    // claude-minimax spike investigation). SHA mismatch is the only
    // invalidation signal; no mtime/TTL GC. Cached worktrees are not torn
    // down by `cleanup()` so the next session reuses them.
    if (cacheEnabled) {
      const expectedSha = await io.branchHead(gitCtx, branch);
      const actualSha = await io.worktreeHead(gitCtx, dest);
      if (expectedSha && actualSha && expectedSha === actualSha) {
        resolved.set(branch, dest);
        return dest; // cache hit — don't add to `created`, don't re-install
      }
      // Mismatch (or dest is not a worktree, or lookup failed): fall through
      // to a clean re-materialise.
    }

    const ok = await io.worktreeAdd(gitCtx, dest, branch);
    if (!ok) {
      process.stderr.write(
        `error: feedback worktree add failed for ${branch}; blocking validation\n`,
      );
      resolved.set(branch, null);
      return null;
    }
    // A freshly added git worktree does NOT populate submodules: packages/red-castle
    // (the `@reddb-io/red-castle` workspace:* SOURCE, ADR 0061) is an empty dir. The
    // pnpm install below then cannot resolve that workspace dep, so every gate check
    // (tsc / build / vitest) fails with `Cannot find module '@reddb-io/red-castle'`
    // — a FALSE blocked:validation on otherwise-green apps/dev work. CI sidesteps
    // this with `actions/checkout submodules:recursive`; a local `git worktree add`
    // has no such convenience, so initialise the submodule into the worktree before
    // installing. Fails closed, like the install below.
    const sub = await io.exec("git", ["submodule", "update", "--init", "--recursive"], { cwd: dest });
    if (sub.code !== 0) {
      await io.worktreeRemove(gitCtx, dest);
      process.stderr.write(
        `error: feedback worktree submodule init failed for ${branch} (exit ${sub.code}); ` +
          `blocking validation\n${sub.stderr.trim()}\n`,
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
    // AFK runner improvement (Pattern 2): best-effort rebase onto the session
    // base so a worker test written against a now-moved main validates against
    // the latest source. A conflict aborts (worktree left in its original
    // state) and the gate runs as-is — the baseline probe catches the drift.
    // NEVER blocks: rebase failure is a warning, not a gate failure. Only runs
    // after a FRESH materialise (not a cache hit), so the cached worktree's
    // HEAD stays aligned with the branch ref for the next session's cache check.
    if (rebaseOnto) {
      const rb = await io.rebase(gitCtx, dest, rebaseOnto);
      if (!rb.ok) {
        process.stderr.write(
          `warn: feedback worktree rebase of ${branch} onto ${rebaseOnto} failed ` +
            `(${rb.stderr || "no detail"}); running the gate on the un-rebased branch\n`,
        );
      }
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

  // Post-attempt-format commands run in the worker-branch checkout (same
  // materialise step as backpressure) but add auto-commit semantics: after a
  // successful (exit-0) command, inspect git status; if the checkout is dirty,
  // stage all changes, commit with `style: <cmd>`, and push `HEAD:<branch>` to
  // origin so the feedback gate runs against the formatted branch. The branch
  // name doubles as the `cwd` token (the same convention as backpressure). A
  // worktree setup failure, a dirty-check failure, or a push failure all resolve
  // non-zero (committed:false) — the caller aborts when code !== 0.
  const postAttemptFormat: PostAttemptFormatExec = async ({ command, cwd, timeoutMs }) => {
    const dir = await pathFor(cwd);
    if (dir === null) {
      return { code: 1, stdout: "", stderr: `feedback worktree setup failed for ${cwd}; format aborted`, committed: false };
    }

    const r = await io.exec("sh", ["-c", command], { cwd: dir, timeoutMs });
    if (r.code !== 0) {
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, committed: false };
    }

    // Check if the checkout is dirty after the format command.
    const statusR = await io.exec("git", ["status", "--porcelain"], { cwd: dir });
    if (statusR.stdout.trim() === "") {
      return { code: 0, stdout: r.stdout, stderr: r.stderr, committed: false };
    }

    // Dirty checkout: stage + commit + push so the feedback gate sees the delta.
    const addR = await io.exec("git", ["add", "-A"], { cwd: dir });
    if (addR.code !== 0) {
      return { code: addR.code, stdout: addR.stdout, stderr: addR.stderr, committed: false };
    }
    const commitR = await io.exec(
      "git",
      ["commit", "-m", `style: ${command}`],
      { cwd: dir },
    );
    if (commitR.code !== 0) {
      return { code: commitR.code, stdout: commitR.stdout, stderr: commitR.stderr, committed: false };
    }
    // Push: the checkout is detached HEAD (`git worktree add --detach`), so the
    // refspec must be explicit: HEAD:<branch-name>.
    const pushR = await io.exec("git", ["push", "origin", `HEAD:${cwd}`], { cwd: dir });
    if (pushR.code !== 0) {
      return { code: pushR.code, stdout: pushR.stdout, stderr: pushR.stderr, committed: false };
    }

    return { code: 0, stdout: r.stdout, stderr: r.stderr, committed: true };
  };

  return {
    pnpm,
    layout,
    backpressure,
    postAttemptFormat,
    async cleanup() {
      for (const dest of created) {
        await io.worktreeRemove(gitCtx, dest);
      }
      created.clear();
      resolved.clear();
    },
  };
}
