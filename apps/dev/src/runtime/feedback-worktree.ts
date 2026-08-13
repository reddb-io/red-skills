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
// `.red/tmp/feedback/<branch-slug>`, caches it, and exposes the `pnpm` executor + `PackageLayout` probe the
// feedback gate consumes, both rebased onto the materialised checkout. Every
// worktree it created is torn down by `cleanup()` after the session.
//
// When the worktree cannot be materialised (worktreeAdd failure) or the
// declared setup (or the undeclared install fallback) fails, the gate fails
// closed: all validation calls return code 1.
// A failed setup never silently validates the primary checkout. It also NAMES
// its cause (#2964): the blocked message carries which of lock-wait timeout,
// `worktree add` failure or `pnpm install` failure fired, plus the underlying
// stderr, so the validation record it lands in is diagnosable on its own. An
// infra failure that cannot name its own cause turns every occurrence into a
// fresh investigation.
//
// AFK runner improvement — cross-session worktree cache: by default, a
// materialised worktree whose branch HEAD matches the live branch's HEAD
// is REUSED across sessions (no `worktree add` / setup command on re-claim).
// The worktree itself is the cache and is retained on a cache hit. SHA mismatch
// is the only invalidation signal; there is no mtime/TTL GC. This saves the
// install cost per re-claim (Pattern 7 of the claude-minimax spike). Opt out via
// `cacheEnabled: false` for callers that need a strict per-session manager.
//
// A worktree path is a SINGLETON across every process on the host — most
// sharply the `feedback/main` baseline every landing revalidation probes
// against. Materialising it (`worktree add` + `pnpm install`) therefore runs
// under a host-wide file lock (#2437): concurrent landings serialize instead of
// corrupting each other's setup, and the waiter re-checks the cache once it has
// the lock, so the usual outcome of losing the race is a free cache hit. When
// the wait itself times out, setup is reported as RETRYABLE. Failed setup is
// never cached: a gate round can consume several validation calls, so even a
// three-failure latch poisoned every later round after one transient fetch
// incident. The next call always gets a fresh chance to heal the environment.

import { accessSync, constants, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  buildFeedbackSubprocessEnv,
  type Exec as PnpmExec,
  type PackageLayout,
} from "../core/feedback.js";
import type { BackpressureExec } from "../core/backpressure.js";
import type { PostWorkerFormatExec } from "../core/post-worker-format.js";
import {
  readRedskilledHostConfig,
  resolveRedskilledHostSettings,
} from "@reddb-io/redskilled/host-config";
import {
  DEFAULT_VALIDATION_STALL_DETECTION,
  execTool,
  pnpm as runPnpm,
  type ExecOptions,
  type ExecOutput,
  type ValidationStallDetection,
} from "./exec.js";
import * as gitx from "./git.js";
import { createPathLock, createPathSemaphore } from "./land-lock.js";
import type { LandLockWaitInfo } from "../core/land-lock.js";
import type { BranchReversionGeometry } from "../core/branch-reversion.js";
import { withValidationResourceEvidence } from "./validation-resources.js";

/**
 * Is `token` an ALREADY-MATERIALISED checkout rather than a branch name (#2339)?
 *
 * The feedback gate's `-C` token is normally a branch, but the post-merge
 * integration gate (#1335) passes the isolated rebase/landing worktree DIR it
 * just provisioned. Treating that dir as a branch made `git fetch origin
 * <dir>` fail and blocked ALL validation.
 *
 * The discriminator is git's own: a checkout root carries a `.git` entry (a
 * DIR in a primary clone, a FILE in a linked worktree). Branch names never
 * do — `afk/<worker>/<n>-<slug>` is not a directory on disk — so the check
 * cannot mistake a branch for a path. Returns the resolved checkout path
 * (relative tokens are tried against `root` first, then the cwd), or `null`
 * when the token is a plain branch name.
 */
export function resolveCheckoutDir(token: string, root: string): string | null {
  const candidates = isAbsolute(token) ? [token] : [join(root, token), token];
  for (const candidate of candidates) {
    try {
      accessSync(join(candidate, ".git"), constants.F_OK);
      return candidate;
    } catch {
      // Not a checkout at this candidate — try the next.
    }
  }
  return null;
}

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
 * worktree is actually at. A match → cache hit (no install).
 * Mismatch (force-push, new commit) → cache miss (full re-materialise). Both
 * helpers return `null` on failure; the manager treats `null` as a cache miss
 * (the safe default — re-materialise from scratch).
 */
export interface FeedbackWorktreeIO {
  /**
   * Materialise `branch` at `dest`. Returns the real git stderr alongside the
   * verdict (#2339) — a bare boolean forced every field report to guess why the
   * gate never got a checkout.
   */
  worktreeAdd(
    ctx: gitx.GitContext,
    dest: string,
    branch: string,
  ): Promise<{ ok: boolean; stderr?: string }>;
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
  reversionBaseline?(
    ctx: gitx.GitContext,
    dest: string,
    base: string,
  ): Promise<Omit<BranchReversionGeometry, "diff">>;
  reversionDiff?(ctx: gitx.GitContext, dest: string, base: string): Promise<string>;
  /** Run `pnpm <args>` with the given cwd. */
  pnpm(args: readonly string[], opts: ExecOptions): Promise<ExecOutput>;
  /** Run an arbitrary tool (used by the backpressure `sh -c` executor). */
  exec(cmd: string, args: readonly string[], opts: ExecOptions): Promise<ExecOutput>;
  /**
   * Host-wide mutual exclusion over ONE worktree path (#2437). The feedback
   * baseline worktree (`feedback/main`) is a singleton shared by every landing
   * revalidation on this host; without a lock two concurrent revalidations
   * `worktree add` + `pnpm install` the same directory and the loser's setup
   * fails ("already exists" / a half-installed `node_modules`), failing EVERY
   * check of a ~25-minute cycle as `inconclusive`. Resolves to a release
   * closure once the caller owns `dest`, or `null` when the wait timed out
   * (the caller then treats setup as retryable, never as a hard failure).
   *
   * Optional: an injected IO without it (every test fake) serializes only
   * in-process, which is all a single-process fixture needs.
   */
  lock?(dest: string, onWait?: LockWaitSink): Promise<(() => Promise<void>) | null>;
  /**
   * Host-wide sized semaphore for validation commands. Every live worker and
   * no-agent reconcile manager binds the same `.red/state` slot set.
   */
  gateLock?(root: string, onWait?: LockWaitSink): Promise<(() => Promise<void>) | null>;
}

/**
 * What the orchestrator is BLOCKED ON, named. The two host-wide locks here are
 * the gate's only unbounded-looking waits, and both used to poll in complete
 * silence — no child, no socket, no write — which read on every surface as a
 * healthy `live=true` worker doing nothing for half an hour (#2985).
 */
export interface LockWaitNotice {
  /** `validation-gate` (host-wide sized semaphore) or `feedback-worktree`. */
  lock: "validation-gate" | "feedback-worktree";
  /**
   * Where the wait stands. A `waiting` notice is only ever followed by exactly
   * one terminal notice, so a reader that latches "blocked" on the first always
   * gets the un-latch — a stall banner that outlives its stall is its own lie.
   */
  state: "waiting" | "acquired" | "timed-out";
  /** The contended path. */
  path: string;
  /** Who holds it right now, when the lock record could be read. */
  heldBy?: string;
  heldByPid?: number;
  heldForMs?: number;
  /** How long this waiter has waited, and how much budget is left. */
  waitedMs: number;
  remainingMs: number;
  /** One line naming the wait, ready for the iteration log. */
  message: string;
}

export type LockWaitSink = (notice: LockWaitNotice) => void;

/** One child process the gate is currently awaiting. Subject, deadline and
 * escalation deliberately match the declared-wait vocabulary; pid + start are
 * the process facts only the spawning Worker can publish. */
export interface GateWaitNotice {
  state: "waiting" | "completed" | "stalled";
  kind: "gate";
  subject: string;
  pid: number;
  startedAt: string;
  deadline: string;
  escalation: string;
  infraEvidence?: ExecOutput["infraEvidence"];
}

export type GateWaitSink = (notice: GateWaitNotice) => void;

/**
 * How long a landing revalidation waits for the baseline worktree before giving
 * up. The holder keeps the lock only for `worktree add` + `pnpm install` +
 * rebase (never for the test run itself), so the real contention window is a
 * couple of minutes; 10 is generous headroom on a loaded fleet host and still
 * far under the revalidation cycle it protects.
 */
const WORKTREE_LOCK_WAIT_MS = 10 * 60_000;
/** A holder that has not finished a materialise in this long has crashed. */
const WORKTREE_LOCK_STALE_MS = 20 * 60_000;
const GATE_LOCK_WAIT_MS = 60 * 60_000;
const GATE_LOCK_STALE_MS = 24 * 60 * 60_000;
/**
 * How often a still-blocked waiter re-announces itself. The first poll speaks
 * IMMEDIATELY — a wait nobody hears about for 30s is still a wait nobody can
 * see at second 1 — and every later notice is spaced so a 60-minute gate-lock
 * wait costs ~120 log lines rather than ~7200.
 */
export const LOCK_WAIT_NOTICE_INTERVAL_MS = 30_000;

/** `754321` → `12m34s`. Coarse on purpose: the reader wants an order of
 * magnitude, not a stopwatch. */
export function formatWaitDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Render ONE wait observation as the notice the iteration log carries. It names
 * the lock, the holder, how long the holder has had it, how long we have
 * waited, and when we give up — everything a reader needs to tell "contended,
 * making progress" from "wedged behind a corpse" without attaching a debugger.
 */
export function renderLockWaitNotice(
  lock: LockWaitNotice["lock"],
  info: LandLockWaitInfo,
): LockWaitNotice {
  const held =
    info.heldBy === undefined
      ? "held by an unreadable lock record"
      : `held by \`${info.heldBy}\`` +
        (info.heldByPid === undefined ? "" : ` (pid ${info.heldByPid})`) +
        (info.heldForMs === undefined ? "" : ` for ${formatWaitDuration(info.heldForMs)}`);
  return {
    lock,
    state: "waiting",
    path: info.path,
    ...(info.heldBy === undefined ? {} : { heldBy: info.heldBy }),
    ...(info.heldByPid === undefined ? {} : { heldByPid: info.heldByPid }),
    ...(info.heldForMs === undefined ? {} : { heldForMs: info.heldForMs }),
    waitedMs: info.waitedMs,
    remainingMs: info.remainingMs,
    message:
      `⏳ /afk gate: blocked on the host-wide \`${lock}\` lock (\`${info.path}\`), ${held} — ` +
      `waited ${formatWaitDuration(info.waitedMs)}, giving up in ${formatWaitDuration(info.remainingMs)}.`,
  };
}

/** The reporter behind one `acquire()`: a throttled per-poll sink plus the ONE
 * terminal notice that retires whatever the waiting notices latched. */
export interface LockWaitReporter {
  onWait: (info: LandLockWaitInfo) => void;
  /** Emit the terminal notice — only when a wait was actually announced. */
  finish(acquired: boolean): void;
}

/**
 * Adapt the lock's per-poll `onWait` to the caller's sink, throttled to
 * {@link LOCK_WAIT_NOTICE_INTERVAL_MS}. Returns `undefined` when there is no
 * sink, so the lock skips the work entirely.
 */
export function lockWaitReporter(
  lock: LockWaitNotice["lock"],
  sink: LockWaitSink | undefined,
): LockWaitReporter | undefined {
  if (!sink) return undefined;
  let lastAnnouncedMs = -Infinity;
  let announced = false;
  let lastWaitedMs = 0;
  let path = "";
  return {
    onWait(info) {
      lastWaitedMs = info.waitedMs;
      path = info.path;
      if (info.attempt !== 1 && info.waitedMs - lastAnnouncedMs < LOCK_WAIT_NOTICE_INTERVAL_MS) return;
      lastAnnouncedMs = info.waitedMs;
      announced = true;
      sink(renderLockWaitNotice(lock, info));
    },
    finish(acquired) {
      // An UNCONTENDED acquire said nothing and so has nothing to retire.
      if (!announced) return;
      const waited = formatWaitDuration(lastWaitedMs);
      sink({
        lock,
        state: acquired ? "acquired" : "timed-out",
        path,
        waitedMs: lastWaitedMs,
        remainingMs: 0,
        message: acquired
          ? `✅ /afk gate: took the host-wide \`${lock}\` lock after waiting ${waited}.`
          : `⛔ /afk gate: gave up on the host-wide \`${lock}\` lock after ${waited}; validation blocked.`,
      });
    },
  };
}

/** Acquire through a reporter so both the wait and its end are announced. */
async function acquireAnnounced(
  lock: LockWaitNotice["lock"],
  sink: LockWaitSink | undefined,
  build: (onWait?: (info: LandLockWaitInfo) => void) => Promise<(() => Promise<void>) | null>,
): Promise<(() => Promise<void>) | null> {
  const reporter = lockWaitReporter(lock, sink);
  const release = await build(reporter ? (info) => reporter.onWait(info) : undefined);
  reporter?.finish(release !== null);
  return release;
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
  reversionBaseline: async (_ctx, dest, base) =>
    gitx.branchReversionBaseline({ cwd: dest }, "HEAD", base),
  reversionDiff: async (_ctx, dest, base) => gitx.branchReversionDiffAt(dest, base),
  pnpm: runPnpm,
  exec: execTool,
  lock: async (dest, onWait) => {
    // The lock file sits BESIDE the worktree, not inside it — `git worktree
    // add` refuses a non-empty destination, so a lock file within `dest` would
    // block the very operation it guards.
    await mkdir(dirname(dest), { recursive: true });
    return acquireAnnounced("feedback-worktree", onWait, (report) =>
      createPathLock(`${dest}.lock`, `feedback-worktree:${dest}`, {
        waitTimeoutMs: WORKTREE_LOCK_WAIT_MS,
        staleAfterMs: WORKTREE_LOCK_STALE_MS,
        pollMs: 500,
        ...(report ? { onWait: report } : {}),
      }).acquire(),
    );
  },
  gateLock: async (root, onWait) => {
    const stateDir = join(root, ".red", "state");
    await mkdir(stateDir, { recursive: true });
    const hostConfig = await readRedskilledHostConfig();
    const capacity = resolveRedskilledHostSettings({ config: hostConfig }).ceiling.validation_count ?? 1;
    return acquireAnnounced("validation-gate", onWait, (report) =>
      createPathSemaphore(join(stateDir, "validation-gate.lock"), `validation-gate:${process.pid}`, capacity, {
        waitTimeoutMs: GATE_LOCK_WAIT_MS,
        staleAfterMs: GATE_LOCK_STALE_MS,
        pollMs: 500,
        ...(report ? { onWait: report } : {}),
      }).acquire(),
    );
  },
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
  postWorkerFormat: PostWorkerFormatExec;
  /** Geometry captured around feedback's completed stale-base correction. */
  baseMergeReversionGeometry(branch: string): BranchReversionGeometry | undefined;
  /** Remove every worktree this manager created in THIS session (best-effort). */
  cleanup(): Promise<void>;
}

/** Optional configuration for {@link makeFeedbackWorktree}. */
export interface FeedbackWorktreeOptions {
  /**
   * Operator-declared dependency setup authority (`plugins.dev.afk.setup`).
   * Commands run in order, byte-for-byte through `sh -c`, in the freshly
   * materialised checkout. When at least one command is declared the engine
   * never guesses or substitutes a package-manager command.
   *
   * Absent/empty keeps the compatibility fallback: pnpm's frozen install with
   * hook-manager opt-outs, plus one `--ignore-scripts` retry only when stderr
   * names the custom-core.hooksPath refusal caused by AFK's hook redirect.
   */
  setupCommands?: readonly string[];
  /**
   * AFK runner improvement: when true (the default), a materialised worktree
   * whose branch HEAD matches the live branch's HEAD is REUSED across sessions
   * (no `worktree add` / `pnpm install` on re-claim).
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
  /** Resource budget applied to validation subprocesses (#1758). */
  resourceBudget?: { nodeMaxOldSpaceMb?: number; vitestMaxWorkers?: number; turboConcurrency?: number };
  /**
   * Where a BLOCKED wait announces itself (#2985). Both host-wide locks here
   * can hold a worker for tens of minutes with no child process and no write,
   * which every liveness surface reads as a healthy worker; the sink is how the
   * wait reaches the iteration log, the worker event lane, and the vitals.
   * Absent → the locks skip the reporting entirely (unchanged behaviour).
   */
  onLockWait?: LockWaitSink;
  /** Where a spawned validation child declares itself and its retirement. */
  onGateWait?: GateWaitSink;
  /** Clock for the child wait's own age anchor. */
  nowIso?: () => string;
  /** CPU-idle detection envelope for real validation process groups. */
  stallDetection?: ValidationStallDetection;
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
  const setupCommands = (options.setupCommands ?? []).filter((command) => command.trim() !== "");
  const resourceBudget = options.resourceBudget ?? {};
  const onLockWait = options.onLockWait;
  const onGateWait = options.onGateWait;
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  const stallDetection = options.stallDetection ?? DEFAULT_VALIDATION_STALL_DETECTION;
  const gitCtx: gitx.GitContext = { cwd: root };
  // Successful branch -> resolved checkout path. Failures are deliberately not
  // cached: every later validation call may heal a transient environment fault.
  const resolved = new Map<string, string>();
  // Worktrees created in THIS session — these are the only ones `cleanup()`
  // removes. A cache hit (worktree reused from a prior session) is NOT in
  // this set, so cleanup leaves it alone.
  const created = new Set<string>();
  // In-flight materialise per branch: two validation calls for the same branch
  // in ONE process must share a single setup, not race each other into a
  // duplicate `worktree add`.
  const inflight = new Map<string, Promise<string | null>>();
  // WHY the last materialise failed, per branch (#2964). `materialise()` returns
  // a bare `null` on three distinct paths — lock-wait timeout, `worktree add`
  // failure, `pnpm install` failure — and until this map existed the underlying
  // stderr went only to this process's stderr. The validation record then read
  // `setup failed … validation blocked` with no cause, so every occurrence in
  // the field became a fresh investigation that could not even confirm which
  // path fired. The reason survives between retries so every failed call names
  // the environment defect while the next call remains free to heal it.
  const setupFailureReason = new Map<string, string>();
  // A successful fallback may still have skipped lifecycle scripts after the
  // repo's hook installer refused AFK's custom core.hooksPath. Carry that fact
  // into every validation record produced from this checkout; success must not
  // erase what setup actually ran.
  const setupRecord = new Map<string, string>();
  const reversionGeometry = new Map<string, BranchReversionGeometry>();

  async function runGateChild(
    subject: string,
    run: (onSpawn: (pid: number) => void) => Promise<ExecOutput>,
  ): Promise<ExecOutput> {
    let active: Omit<GateWaitNotice, "state"> | null = null;
    const publish = (notice: GateWaitNotice): void => {
      try {
        onGateWait?.(notice);
      } catch {
        // Observability cannot change the gate verdict.
      }
    };
    try {
      const result = await withValidationResourceEvidence(() => run((pid) => {
        active = {
          kind: "gate",
          subject,
          pid,
          startedAt: nowIso(),
          deadline: "process exit",
          escalation: "fail the validation stage",
        };
        publish({ state: "waiting", ...active });
      }));
      const completed = active as Omit<GateWaitNotice, "state"> | null;
      if (completed !== null) {
        publish(
          result.infraEvidence?.kind === "stall"
            ? { state: "stalled", ...completed, infraEvidence: result.infraEvidence }
            : { state: "completed", ...completed },
        );
        active = null;
      }
      return result;
    } finally {
      const completed = active as Omit<GateWaitNotice, "state"> | null;
      if (completed !== null) publish({ state: "completed", ...completed });
    }
  }

  /** Cap a captured stderr so one cause line stays a summary, not a log dump. */
  function briefly(detail: string): string {
    const flat = detail.replace(/\s+/g, " ").trim();
    return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat;
  }

  /** The mainstream husky/lefthook refusal emitted for a redirected hook path. */
  function refusedCustomHooksPath(stderr: string): boolean {
    return /core\.hooksPath|custom hooks? paths?/i.test(stderr);
  }

  /**
   * The blocked-validation message for a branch whose worktree never
   * materialised. The literal prefix is frozen wire vocabulary — the Verdict
   * recognises it as an environment cause — so the cause is appended after it
   * rather than woven into it.
   */
  function setupFailureMessage(branch: string, suffix = "validation blocked"): string {
    const reason = setupFailureReason.get(branch);
    const because = reason ? ` (${reason})` : "";
    return `feedback worktree setup failed for ${branch}; ${suffix}${because}`;
  }

  async function runValidationCommand(
    run: () => Promise<ExecOutput>,
  ): Promise<ExecOutput> {
    if (!io.gateLock) return run();
    const release = await io.gateLock(root, onLockWait);
    if (release === null) {
      return {
        code: 1,
        stdout: "",
        stderr: "host-wide validation gate lock timed out; validation blocked",
      };
    }
    try {
      return await run();
    } finally {
      await release();
    }
  }

  /** Record a failed materialise without caching the failure. */
  function noteSetupFailure(branch: string, reason: string): null {
    setupFailureReason.set(branch, reason);
    return null;
  }

  async function pathFor(branch: string): Promise<string | null> {
    if (!branch) return root;
    const cached = resolved.get(branch);
    if (cached !== undefined) return cached;
    const pending = inflight.get(branch);
    if (pending !== undefined) return pending;
    const run = materialise(branch).finally(() => inflight.delete(branch));
    inflight.set(branch, run);
    return run;
  }

  /** True when the worktree already at `dest` is at the live branch HEAD. */
  async function cacheHit(branch: string, dest: string): Promise<boolean> {
    if (!cacheEnabled) return false;
    const expectedSha = await io.branchHead(gitCtx, branch);
    const actualSha = await io.worktreeHead(gitCtx, dest);
    return Boolean(expectedSha && actualSha && expectedSha === actualSha);
  }

  async function materialise(branch: string): Promise<string | null> {
    // The token is ALREADY a materialised checkout (#2339). The post-merge
    // integration gate (#1335) hands the gate the isolated rebase/landing
    // worktree DIR, not a branch name — the caller provisioned it, so there is
    // nothing to fetch or add. Without this seam the dir was treated as a
    // branch: `git fetch origin .red/tmp/worktrees/rebase/<slug>-0` failed,
    // every validation call short-circuited to code 1 with `durationMs: 0`, and
    // the landing parked as a phantom merge-conflict.
    const materialised = resolveCheckoutDir(branch, root);
    if (materialised) {
      resolved.set(branch, materialised);
      return materialised;
    }

    const dest = join(feedbackRoot, slugForBranch(branch));

    // AFK runner improvement — cross-session cache: a worktree already at
    // `dest` whose HEAD matches the live branch's HEAD is a cache hit. The
    // cost saved is `pnpm install --frozen-lockfile` (60-180s) per re-claim —
    // the dominant cost when 5+ workers race-claim the same branch (Pattern 7
    // of the claude-minimax spike investigation). SHA mismatch is the only
    // invalidation signal; no mtime/TTL GC. Cached worktrees are not torn down
    // by `cleanup()` so the next session reuses them.
    if (await cacheHit(branch, dest)) {
      resolved.set(branch, dest);
      return dest; // cache hit — don't add to `created`, don't re-install
    }
    // Mismatch (or dest is not a worktree, or lookup failed): fall through
    // to a clean re-materialise — under the host-wide lock (#2437), because a
    // worktree path is a singleton and two processes materialising it at once
    // corrupt each other's setup.
    const release = io.lock ? await io.lock(dest, onLockWait) : null;
    if (io.lock && release === null) {
      // Timed out waiting for the holder. This is CONTENTION, not corruption:
      // report it as a retryable setup failure so the next validation call
      // tries again (the holder will normally have finished by then).
      process.stderr.write(
        `warn: feedback worktree ${dest} is busy (lock wait timed out); ` +
          `baseline setup for ${branch} will be retried\n`,
      );
      return noteSetupFailure(
        branch,
        `lock wait timed out after ${WORKTREE_LOCK_WAIT_MS}ms for ${dest}`,
      );
    }
    try {
      return await materialiseLocked(branch, dest, release !== null);
    } finally {
      await release?.();
    }
  }

  /**
   * The materialise steps that require exclusive ownership of `dest`.
   * `locked` says the caller actually took a lock and so may have WAITED — only
   * then is a second cache probe worth its two git calls.
   */
  async function materialiseLocked(
    branch: string,
    dest: string,
    locked: boolean,
  ): Promise<string | null> {
    // Re-check the cache now that we hold the lock: while we waited, the prior
    // holder very likely materialised the exact worktree we want. Turning the
    // lost race into a cache hit is what makes contention free rather than
    // merely survivable — the loser does no add and no install.
    if (locked && (await cacheHit(branch, dest))) {
      resolved.set(branch, dest);
      return dest;
    }

    let added = await io.worktreeAdd(gitCtx, dest, branch);
    if (!added.ok) {
      // Self-heal: a stale registered-but-removed (or registered-but-dirty)
      // worktree at `dest` causes git to refuse the add with "already exists" /
      // "not empty". Remove-force the path and retry once so a single orphaned
      // feedback/main worktree never permanently blocks the baseline probe.
      const isAlreadyExists =
        /already exists|is not empty/i.test(added.stderr ?? "");
      if (isAlreadyExists) {
        await io.worktreeRemove(gitCtx, dest);
        added = await io.worktreeAdd(gitCtx, dest, branch);
      }
    }
    if (!added.ok) {
      // Carry the underlying git stderr (#2339): the field report that opened
      // this only had "add failed", so the real cause (`fatal: couldn't find
      // remote ref <x>`) had to be guessed.
      process.stderr.write(
        `error: feedback worktree add failed for ${branch}; blocking validation: ` +
          `${added.stderr?.trim() || "no git detail"}\n`,
      );
      return noteSetupFailure(
        branch,
        `worktree add failed: ${briefly(added.stderr ?? "") || "no git detail"}`,
      );
    }
    // A freshly added worktree has NO dependencies. Without setup here,
    // the feedback gate's `pnpm -C <dest> test/build` calls fail with
    // `tsc/vite/svelte-kit: not found` — a FALSE validation failure that parks
    // otherwise-green work as blocked:validation (#458). Install before any
    // check can run.
    let setupFailure: { command: string; result: ExecOutput } | undefined;
    if (setupCommands.length > 0) {
      for (const command of setupCommands) {
        const result = await runGateChild(`setup: ${command}`, (onSpawn) =>
          io.exec("sh", ["-c", command], { cwd: dest, onSpawn, stallDetection })
        );
        if (result.code !== 0) {
          setupFailure = { command, result };
          break;
        }
      }
    } else {
      // Compatibility for repos that pre-date the declaration. Hook managers
      // are disabled up front because AFK deliberately redirected hooksPath.
      // An implementation that ignores those envs gets one targeted retry;
      // every other install failure remains fatal on the first reading.
      const env = { ...process.env, LEFTHOOK: "0", HUSKY: "0" };
      const command = "pnpm install --frozen-lockfile";
      let result = await runGateChild("pnpm install", (onSpawn) =>
        io.pnpm(["install", "--frozen-lockfile"], { cwd: dest, env, onSpawn, stallDetection })
      );
      if (result.code !== 0 && refusedCustomHooksPath(result.stderr)) {
        const retryCommand = `${command} --ignore-scripts`;
        result = await runGateChild(retryCommand, (onSpawn) =>
          io.pnpm(["install", "--frozen-lockfile", "--ignore-scripts"], {
            cwd: dest,
            env,
            onSpawn,
            stallDetection,
          })
        );
        if (result.code === 0) {
          setupRecord.set(
            branch,
            `${retryCommand} (fallback after custom core.hooksPath refusal; lifecycle scripts skipped)`,
          );
          process.stderr.write(
            `warn: feedback worktree setup for ${branch} retried with --ignore-scripts; ` +
              `lifecycle scripts were skipped\n`,
          );
        } else {
          setupFailure = { command: retryCommand, result };
        }
      } else if (result.code !== 0) {
        setupFailure = { command, result };
      }
    }
    if (setupFailure) {
      // Lockfile drift on the branch, or a transient registry error. Remove the
      // partial checkout eagerly and block — continuing would silently validate
      // the wrong environment (binaries absent, wrong lockfile).
      await io.worktreeRemove(gitCtx, dest);
      process.stderr.write(
        `error: feedback worktree setup command failed for ${branch} ` +
          `(exit ${setupFailure.result.code}); blocking validation\n` +
          `${setupFailure.result.stderr.trim()}\n`,
      );
      return noteSetupFailure(
        branch,
        `${setupFailure.command} failed (exit ${setupFailure.result.code}): ` +
          `${briefly(setupFailure.result.stderr) || "no setup detail"}`,
      );
    }
    // AFK runner improvement (Pattern 2): best-effort rebase onto the session
    // base so a worker test written against a now-moved main validates against
    // the latest source. A conflict aborts (worktree left in its original
    // state) and the gate runs as-is — the baseline probe catches the drift.
    // NEVER blocks: rebase failure is a warning, not a gate failure. Only runs
    // after a FRESH materialise (not a cache hit), so the cached worktree's
    // HEAD stays aligned with the branch ref for the next session's cache check.
    if (rebaseOnto) {
      const baseline = io.reversionBaseline
        ? await io.reversionBaseline(gitCtx, dest, rebaseOnto)
        : undefined;
      const rb = await io.rebase(gitCtx, dest, rebaseOnto);
      if (!rb.ok) {
        process.stderr.write(
          `warn: feedback worktree rebase of ${branch} onto ${rebaseOnto} failed ` +
          `(${rb.stderr || "no detail"}); running the gate on the un-rebased branch\n`,
        );
      } else if (baseline && io.reversionDiff) {
        const diff = await io.reversionDiff(gitCtx, dest, baseline.baseRef);
        reversionGeometry.set(branch, { ...baseline, diff });
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
  const pnpm: PnpmExec = async (args, opts) => {
    const env = opts?.env ?? buildFeedbackSubprocessEnv(process.env, resourceBudget);
    // args === ["pnpm", "-C", dir, script]
    const cIdx = args.indexOf("-C");
    if (cIdx >= 0 && args[cIdx + 1] !== undefined) {
      const { branch, scope } = splitBranchDir(args[cIdx + 1]!, layout.hasPackage);
      const base = await pathFor(branch);
      if (base === null) {
        return { code: 1, stdout: "", stderr: setupFailureMessage(branch) };
      }
      const rewritten = resolve(scope === "." ? base : join(base, scope));
      const rest = args.filter((_, i) => i !== 0 && i !== cIdx && i !== cIdx + 1);
      const r = await runValidationCommand(() =>
        runGateChild(`pnpm ${rest[0] ?? "validation"}`, (onSpawn) =>
          io.pnpm(["-C", rewritten, ...rest], { cwd: root, env, onSpawn, stallDetection })
        )
      );
      // Report the ABSOLUTE directory the command really ran in (#3041). The
      // gate composed its record against the BRANCH token it posed; without
      // this the record reads `pnpm -C afk/<n>-<slug>/apps/dev …`, which looks
      // like a relative path that resolves nowhere and is indistinguishable
      // from a command that never ran.
      return {
        code: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.infraEvidence === undefined ? {} : { infraEvidence: r.infraEvidence }),
        ...(r.resources === undefined ? {} : { resources: r.resources }),
        commandDir: rewritten,
        ...(setupRecord.has(branch) ? { setup: setupRecord.get(branch)! } : {}),
      };
    }
    const head = args[0] === "pnpm" ? args.slice(1) : args;
    const r = await runValidationCommand(() =>
      runGateChild(`pnpm ${head[0] ?? "validation"}`, (onSpawn) =>
        io.pnpm(head, { cwd: root, env, onSpawn, stallDetection })
      )
    );
    return {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(r.infraEvidence === undefined ? {} : { infraEvidence: r.infraEvidence }),
      ...(r.resources === undefined ? {} : { resources: r.resources }),
    };
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
      return { code: 1, stdout: "", stderr: setupFailureMessage(cwd) };
    }
    const env = buildFeedbackSubprocessEnv(process.env, resourceBudget);
    const r = await runValidationCommand(() =>
      runGateChild("sh backpressure", (onSpawn) =>
        io.exec("sh", ["-c", command], { cwd: dir, timeoutMs, env, onSpawn, stallDetection })
      )
    );
    return {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(r.infraEvidence === undefined ? {} : { infraEvidence: r.infraEvidence }),
      ...(r.resources === undefined ? {} : { resources: r.resources }),
    };
  };

  // Post-attempt-format commands run in the worker-branch checkout (same
  // materialise step as backpressure) but add auto-commit semantics: after a
  // successful (exit-0) command, inspect git status; if the checkout is dirty,
  // stage all changes, commit with `style: <cmd>`, and push `HEAD:<branch>` to
  // origin so the feedback gate runs against the formatted branch. The branch
  // name doubles as the `cwd` token (the same convention as backpressure). A
  // worktree setup failure, a dirty-check failure, or a push failure all resolve
  // non-zero (committed:false) — the caller aborts when code !== 0.
  const postWorkerFormat: PostWorkerFormatExec = async ({ command, cwd, timeoutMs }) => {
    const dir = await pathFor(cwd);
    if (dir === null) {
      return { code: 1, stdout: "", stderr: setupFailureMessage(cwd, "format aborted"), committed: false };
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
    postWorkerFormat,
    baseMergeReversionGeometry: (branch) => reversionGeometry.get(branch),
    async cleanup() {
      for (const dest of created) {
        await io.worktreeRemove(gitCtx, dest);
      }
      created.clear();
      resolved.clear();
      setupFailureReason.clear();
      setupRecord.clear();
      reversionGeometry.clear();
    },
  };
}
