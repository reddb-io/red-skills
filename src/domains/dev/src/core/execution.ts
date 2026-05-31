// AFK execution backend on @ai-hero/sandcastle (ADR 0033).
//
// sandcastle owns the execution substrate — spawn the agent, manage the git
// worktree, run a sandbox, and land commits on a branch via `run()`. AFK keeps
// the issue-policy layer: it calls `runAgent` for the "run the agent and produce
// commits on a branch" step, then drives its own feedback gate, lock-toggled
// landing, envelope, and close around the returned `RunAgentResult`.
//
// The pure mapping (buildRunOptions / interpretOutcome) is unit-tested with the
// sandcastle `run` injected; `defaultSandcastleDeps` wires the real providers for
// the CLI. AFK's own sentinels (`<promise>DONE|BLOCKED</promise>`) are registered
// as sandcastle completion signals, so the existing AGENT-PROMPT contract is
// unchanged.

import type { RunOptions, RunResult } from "@ai-hero/sandcastle";
import { isRunnerExhausted } from "./runner-spawn.js";

export type AgentRunner = "claude" | "codex";
export type SandboxMode = "none" | "docker" | "podman";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
// `exhausted` is surfaced when sandcastle's run() signals quota / rate-limit
// (RUNNER_EXHAUSTED in the shell port) — see the runner-exhaustion detection in
// `runAgent`. It rides the same outcome union so process-issue can branch on it.
export type AgentOutcome = "done" | "blocked" | "no-sentinel" | "exhausted";

/** AFK's canonical sentinels, registered as sandcastle completion signals. */
export const DONE_SIGNAL = "<promise>DONE</promise>";
export const BLOCKED_SIGNAL = "<promise>BLOCKED</promise>";
export const COMPLETION_SIGNALS: readonly string[] = [DONE_SIGNAL, BLOCKED_SIGNAL];

export const DEFAULT_IDLE_TIMEOUT_S = 600;

export interface RunAgentInput {
  /** Which agent provider to drive. */
  runner: AgentRunner;
  /** Model id passed to the provider (e.g. "claude-opus-4-8", "gpt-5.4"). */
  model: string;
  effort?: AgentEffort;
  /** Path to the materialised handoff file used as the agent prompt. */
  handoffPath: string;
  /** The worker branch sandcastle commits land on (afk/{id}/{N}-{slug}). */
  branch: string;
  /**
   * The resolved base branch (lock > pin > main, ADR 0031) the worker branch is
   * forked from. Passed to sandcastle's NamedBranchStrategy `baseBranch` start
   * point so the branch's parent is the pinned/locked base, not HEAD. Sandcastle
   * only honours it when the branch is created new and the caller has made the
   * ref current (process-issue does a `git fetch origin <base>` first). Defaults
   * to HEAD when omitted.
   */
  base?: string;
  /** Isolation: "none" (default, node-only) | "docker" | "podman". */
  sandboxMode?: SandboxMode;
  /**
   * Absolute host anchor for sandcastle's `.sandcastle/` dir + git operations.
   * AFK sets this to the attempt dir so nothing lands at the repo root
   * (everything under .red/). Defaults to process.cwd() in sandcastle when
   * omitted. NOTE: sandcastle resolves `promptFile` against process.cwd(), NOT
   * against `cwd` — so `handoffPath` must stay absolute whenever this is set
   * (AFK's attempt dir is always absolute, so the handoff path already is).
   */
  cwd?: string;
  idleTimeoutSeconds?: number;
  /**
   * The git remote the worker branch is continuously pushed to (issue #191).
   * Only consulted when `continuousPush` is true. Defaults to "origin" — the
   * shell port hard-coded `origin`, so the remote name is the push target, not
   * a `git -C` repo.
   */
  remote?: string;
  /**
   * Restore the AFK continuous-push guarantee (issue #191): when true,
   * `buildRunOptions` injects a sandcastle `host.onWorktreeReady` hook that, in
   * the freshly-created worktree ON THE HOST, (a) force-with-lease pushes the
   * worker branch to the remote up-front and (b) installs a `post-commit` git
   * hook that fire-and-forgets a push after every inner-agent commit — exactly
   * the shell `push_initial` + `install_post_commit_hook` behaviour. So a
   * SIGKILL anywhere mid-iteration preserves the diff on the remote.
   *
   * Off by default: the legacy path (push once after a DONE run) is preserved
   * unless the caller opts in.
   */
  continuousPush?: boolean;
}

/** The git remote the continuous-push hook targets when none is supplied. */
export const DEFAULT_REMOTE = "origin";

export interface RunAgentResult {
  outcome: AgentOutcome;
  branch: string;
  commits: readonly { sha: string }[];
  completionSignal?: string;
  stdout: string;
}

/** Provider factories + the sandcastle `run` entrypoint, injected for testing. */
export interface SandcastleDeps {
  run: (options: RunOptions) => Promise<RunResult>;
  agentFor: (runner: AgentRunner, model: string, opts?: { effort?: AgentEffort }) => RunOptions["agent"];
  sandboxFor: (mode: SandboxMode) => RunOptions["sandbox"];
}

/** Map an AFK completion signal back to an iteration outcome. */
export function interpretOutcome(signal: string | undefined): AgentOutcome {
  if (signal === DONE_SIGNAL) return "done";
  if (signal === BLOCKED_SIGNAL) return "blocked";
  return "no-sentinel";
}

/** The sandcastle `host.onWorktreeReady` hook command shape. */
type HostHookCommand = NonNullable<NonNullable<NonNullable<RunOptions["hooks"]>["host"]>["onWorktreeReady"]>[number];

/**
 * Build the single `host.onWorktreeReady` hook command that restores the AFK
 * continuous-push guarantee (issue #191) for a host-visible worktree.
 *
 * sandcastle runs `host.onWorktreeReady` ON THE HOST with cwd = the worktree it
 * just created (noSandbox worktree mode and bind-mount worktree mode), so this
 * command, in that worktree:
 *   (a) force-with-lease pushes the worker branch to the remote up-front
 *       (`push_initial`), and
 *   (b) installs a `post-commit` git hook that fire-and-forgets a push after
 *       every inner-agent commit (`install_post_commit_hook`).
 *
 * Every step is best-effort: a network / auth failure logs to stderr (via the
 * shell `||` fallbacks) but never returns non-zero, so the hook can NOT abort
 * the run. The post-commit hook itself ends in `|| true` for the same reason
 * (git ignores a post-commit exit status, but we belt-and-braces it).
 *
 * The hook is written with `git rev-parse --git-dir` so it lands in the linked
 * worktree's own gitdir (`.git/hooks/`), never leaking into the primary
 * checkout or a sibling worktree — exactly the shell behaviour.
 */
export function buildContinuousPushHook(branch: string, remote: string): HostHookCommand {
  // Single-quoted heredoc body so the inner `$()` / `HEAD` are evaluated when
  // the post-commit hook RUNS, not when it is written. The outer `sh -c` script
  // is itself single-quoted at the call site, so embedded single quotes in the
  // heredoc are avoided; we use printf with the literal hook text instead.
  const initialPush = `git push ${remote} -u "HEAD:refs/heads/${branch}" --force-with-lease >/dev/null 2>&1 || echo "[afk] warn: initial push for ${branch} failed, continuing without remote backup" >&2`;
  // The post-commit hook content (issue #191). Written via printf so we never
  // depend on a heredoc surviving the sh -c quoting. The trailing `|| true`
  // keeps the hook a pure side-effect.
  const hookBody = [
    "#!/usr/bin/env sh",
    "# AFK continuous-push hook (issue #191)",
    "# Fire-and-forget: push the worker branch to the remote after every commit so",
    "# a SIGKILL of the orchestrator at any point preserves the diff on the remote.",
    `git push ${remote} HEAD --force-with-lease 2>/dev/null || true`,
    "",
  ].join("\n");
  // printf %s with the body passed as a single argument; escape only what `sh -c`
  // and printf need. We pass the body through a shell variable assignment to keep
  // the command portable and free of nested single quotes.
  const installHook = [
    'gd=$(git rev-parse --git-dir 2>/dev/null) || gd=""',
    'if [ -n "$gd" ]; then',
    '  mkdir -p "$gd/hooks" 2>/dev/null || true',
    `  printf '%s' "$HOOK_BODY" > "$gd/hooks/post-commit" 2>/dev/null && chmod 0755 "$gd/hooks/post-commit" 2>/dev/null || echo "[afk] warn: could not install post-commit hook" >&2`,
    "else",
    '  echo "[afk] warn: could not resolve .git dir — post-commit hook not installed" >&2',
    "fi",
  ].join("\n");
  // HOOK_BODY is exported inline so the heredoc-free printf above reads it. The
  // whole script is wrapped in `sh -c` and always exits 0 (best-effort).
  const script = [`HOOK_BODY=${shSingleQuote(hookBody)}`, "export HOOK_BODY", initialPush, installHook, "exit 0"].join(
    "\n",
  );
  return { command: `sh -c ${shSingleQuote(script)}` };
}

/** POSIX single-quote escaping: wrap in single quotes, replacing each embedded
 * single quote with the `'\''` idiom. Keeps the embedded git push / hook body
 * intact through the `sh -c '<script>'` layer. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build the sandcastle `run` options for one issue iteration (pure). */
export function buildRunOptions(deps: SandcastleDeps, input: RunAgentInput): RunOptions {
  // Fork the worker branch off the resolved base (ADR 0031) via sandcastle's
  // NamedBranchStrategy start point, so a pinned/locked base is the branch's
  // parent rather than HEAD. `baseBranch` is only consulted when the branch is
  // created new; the caller (process-issue) fetches the ref first so it is
  // current. Omitting `base` reverts to sandcastle's HEAD default.
  const branchStrategy: NonNullable<RunOptions["branchStrategy"]> = {
    type: "branch",
    branch: input.branch,
    ...(input.base ? { baseBranch: input.base } : {}),
  };
  // Continuous-push guarantee (issue #191): when enabled, inject a single
  // host.onWorktreeReady hook that runs ON THE HOST in the new worktree to push
  // the branch up-front and install the post-commit push hook. sandcastle only
  // runs this for host-visible worktrees (noSandbox / bind-mount worktree mode);
  // for fully-isolated providers the agent works in a synced copy the hook can't
  // see, so continuous push simply does not fire there (final sync only).
  const hooks: RunOptions["hooks"] | undefined = input.continuousPush
    ? { host: { onWorktreeReady: [buildContinuousPushHook(input.branch, input.remote ?? DEFAULT_REMOTE)] } }
    : undefined;
  return {
    agent: deps.agentFor(input.runner, input.model, { effort: input.effort }),
    sandbox: deps.sandboxFor(input.sandboxMode ?? "none"),
    // Re-anchor sandcastle's `.sandcastle/` dir + git ops at the caller's cwd
    // (AFK's per-attempt dir under .red/) so nothing is generated at the repo
    // root. Omitted → sandcastle defaults to process.cwd().
    ...(input.cwd ? { cwd: input.cwd } : {}),
    promptFile: input.handoffPath,
    branchStrategy,
    completionSignal: [...COMPLETION_SIGNALS],
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_S,
    ...(hooks ? { hooks } : {}),
  };
}

/**
 * True when a sandcastle failure carries one of the exhaustion strings (usage
 * limit / quota / rate_limit_error / …). sandcastle signals quota / rate-limit
 * by throwing — its error message (or any `.stdout`/`.stderr` it carries) is
 * matched against the per-runner exhaustion regex reused from runner-spawn. This
 * is the single seam where a thrown sandcastle error is reclassified as the
 * non-fatal `exhausted` outcome instead of propagating.
 */
export function isExhaustionError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const parts: string[] = [];
  if (typeof error === "string") parts.push(error);
  else if (typeof error === "object") {
    const e = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.stdout === "string") parts.push(e.stdout);
    if (typeof e.stderr === "string") parts.push(e.stderr);
  }
  return parts.some((p) => isRunnerExhausted(p));
}

/**
 * Run the inner agent on the issue via sandcastle and normalise the result.
 *
 * sandcastle's `run()` can signal exhaustion two ways: by throwing an error
 * whose message matches the exhaustion patterns (the common case — the provider
 * raises on a 429 / usage-limit), or by completing with exhaustion text on
 * stdout. Both map to the `exhausted` outcome (no commits, no sentinel). Any
 * other thrown error propagates unchanged.
 */
export async function runAgent(deps: SandcastleDeps, input: RunAgentInput): Promise<RunAgentResult> {
  let result: RunResult;
  try {
    result = await deps.run(buildRunOptions(deps, input));
  } catch (error) {
    if (isExhaustionError(error)) {
      return { outcome: "exhausted", branch: input.branch, commits: [], stdout: "" };
    }
    throw error;
  }
  // A run that completed but surfaced exhaustion text on stdout (rather than
  // throwing) is also exhaustion — match the stdout the same way run_inner does.
  if (result.completionSignal === undefined && isRunnerExhausted(result.stdout ?? "")) {
    return { outcome: "exhausted", branch: result.branch, commits: result.commits, stdout: result.stdout };
  }
  return {
    outcome: interpretOutcome(result.completionSignal),
    branch: result.branch,
    commits: result.commits,
    completionSignal: result.completionSignal,
    stdout: result.stdout,
  };
}

/**
 * Wire the real sandcastle providers. Imported lazily so a test that only
 * exercises the pure mapping never pulls the provider subpaths, and so the
 * provider import paths are the single place coupled to the package layout.
 */
export async function defaultSandcastleDeps(): Promise<SandcastleDeps> {
  const [core, noSandboxMod, dockerMod, podmanMod] = await Promise.all([
    import("@ai-hero/sandcastle"),
    import("@ai-hero/sandcastle/sandboxes/no-sandbox"),
    import("@ai-hero/sandcastle/sandboxes/docker"),
    import("@ai-hero/sandcastle/sandboxes/podman"),
  ]);
  // The effort unions differ per provider (codex has no "max"); the operator's
  // configured effort is cast to each provider's accepted option shape, so an
  // out-of-range value is the provider's concern rather than a compile error.
  const agentFor: SandcastleDeps["agentFor"] = (runner, model, opts) =>
    runner === "codex"
      ? core.codex(model, opts?.effort ? ({ effort: opts.effort } as Parameters<typeof core.codex>[1]) : undefined)
      : core.claudeCode(model, opts?.effort ? ({ effort: opts.effort } as Parameters<typeof core.claudeCode>[1]) : undefined);
  const sandboxFor: SandcastleDeps["sandboxFor"] = (mode) => {
    if (mode === "docker") return dockerMod.docker();
    if (mode === "podman") return podmanMod.podman();
    return noSandboxMod.noSandbox();
  };
  return { run: core.run as SandcastleDeps["run"], agentFor, sandboxFor };
}
