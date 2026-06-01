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

import type { AgentStreamEvent, RunOptions, RunResult } from "@ai-hero/sandcastle";
import { isRunnerExhausted } from "./runner-spawn.js";

// Re-exported so process-issue / run can type their agent-event sink without
// importing the sandcastle package directly (execution.ts is the single seam
// coupled to sandcastle, ADR 0033).
export type { AgentStreamEvent } from "@ai-hero/sandcastle";

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

/**
 * The re-invocation ceiling handed to sandcastle's Orchestrator (issue #322).
 *
 * sandcastle's own DEFAULT_MAX_ITERATIONS is 1 (run.js), which cuts the inner
 * agent off after a SINGLE agentic invocation — it explores / writes files but
 * exhausts that one iteration's budget BEFORE it can emit `<promise>DONE</promise>`,
 * so AFK sees no completionSignal → no-sentinel → blocked:crashed and never
 * merges. The completionSignal (DONE/BLOCKED) is the REAL terminator; this is
 * only the safety ceiling for "the agent never signals". 25 is generous vs the
 * broken 1 yet bounded vs runaway: each iteration is itself bounded by
 * `idleTimeoutSeconds`, and DONE/BLOCKED stops the loop early, so a normal issue
 * finishes in 1-3 iterations and 25 is purely the cap. Env-tunable via
 * RED_AFK_MAX_ITERATIONS (parsed by `parseMaxIterations`).
 */
export const DEFAULT_MAX_ITERATIONS = 25;

/**
 * Parse a RED_AFK_MAX_ITERATIONS override into a positive integer, or
 * `undefined` when the value is missing / non-numeric / zero / negative — so an
 * operator typo cannot disable the cap or pin it to a value below the default.
 * `undefined` lets `buildRunOptions` fall back to {@link DEFAULT_MAX_ITERATIONS}.
 */
export function parseMaxIterations(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return undefined;
}

/**
 * Parse a RED_AFK_IDLE_TIMEOUT_S override (FIX G) into a positive integer, or
 * `undefined` when missing / non-numeric / zero / negative — typo-safe, mirroring
 * {@link parseMaxIterations}. `undefined` lets `buildRunOptions` fall back to
 * {@link DEFAULT_IDLE_TIMEOUT_S}, so an operator typo cannot disable the idle
 * watchdog or pin it to a nonsensical value.
 */
export function parseIdleTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return undefined;
}

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
  /**
   * The sandcastle Orchestrator re-invocation ceiling (issue #322). sandcastle
   * defaults this to 1, which stops the inner agent before it can emit DONE;
   * AFK overrides it so the agent iterates until its completionSignal. Omitted →
   * `buildRunOptions` applies {@link DEFAULT_MAX_ITERATIONS}. `makeRunAgent`
   * threads the RED_AFK_MAX_ITERATIONS env override in here when set.
   */
  maxIterations?: number;
  /**
   * Extra environment variables the spawned agent must inherit (FIX J). The
   * `pre_worktree` lifecycle hook (process-issue) computes a mutable `env` slice
   * — the built-in cargo/gradle defaults set `CARGO_TARGET_DIR=.../slot-N` for
   * per-slot build isolation so parallel fleet workers don't deadlock on one
   * target dir. `RunOptions` has NO `env` field, so AFK applies this onto its own
   * `process.env` immediately before the sandcastle `run()` call.
   *
   * MECHANISM / LIMITATION: this is correct ONLY for the default `noSandbox`
   * mode, where the sandcastle-spawned agent inherits the AFK worker process's
   * `process.env` (each fleet worker is its own process, so the mutation is
   * isolated per-worker). Under docker/podman isolation the agent runs in a
   * container that does NOT inherit `process.env`; delivering this env into the
   * container (the sandbox env lane) is out of scope here. Runtime confirmation
   * that the agent's build actually sees CARGO_TARGET_DIR is pending #284.
   */
  env?: Record<string, string>;
  /**
   * Absolute path sandcastle drains its own file-log to (the `logging.path` of
   * the "file" mode). AFK points this at the attempt dir's `sandcastle.log` so
   * the inner agent's formatted stream lands under `.red/` next to the lanes.
   * Required to enable {@link onAgentEvent}: sandcastle only surfaces the stream
   * callback in log-to-file mode. Omitted → `buildRunOptions` leaves `logging`
   * unset and sandcastle uses its default location.
   */
  logPath?: string;
  /**
   * Observability seam restoring the agent-lane liveness signal on the native
   * path (the shell era tee'd inner-agent stdout into the lanes; sandcastle now
   * captures the stream itself). When set together with {@link logPath},
   * `buildRunOptions` wires it into sandcastle's `logging.onAgentStreamEvent`,
   * yielding one callback per text chunk / tool call. process-issue forwards
   * each event to `agent.log.jsonl` (the clean lane `reaper-signal` /
   * `supervisor-fs` read for liveness) + the firehose — without it the lanes'
   * mtime freezes at iteration start and the stall detector / monitor go blind
   * to a live agent. sandcastle swallows any error this callback throws.
   */
  onAgentEvent?: (event: AgentStreamEvent) => void;
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
  /**
   * Optional warn sink for degrade-safe diagnostics (FIX D effort drop, FIX F
   * continuous-push-under-isolation notice). Defaults to `console.warn` in the
   * real wiring; tests inject a recorder. Never throws — these are advisories.
   */
  warn?: (message: string) => void;
}

/**
 * The reasoning-effort values each provider's option type accepts. codex tops
 * out at "xhigh" (no "max"); claude accepts the full union (see the sandcastle
 * AgentProvider d.ts — CodexOptions.effort vs ClaudeCodeOptions.effort). The
 * effort is gated per provider in `agentFor` (FIX D): an out-of-range value is
 * DROPPED (provider default) with a warn rather than cast through to a runtime
 * provider rejection / infra crash.
 */
export const CODEX_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh"];
export const CLAUDE_EFFORTS: readonly AgentEffort[] = ["low", "medium", "high", "xhigh", "max"];

/**
 * Validate a requested effort against a provider's accepted set. Returns the
 * effort when accepted, or `undefined` when it must be dropped (degrade to the
 * provider default). Pure — the warn is emitted by the caller (`agentFor`).
 */
export function effortForProvider(
  runner: AgentRunner,
  effort: AgentEffort | undefined,
): AgentEffort | undefined {
  if (effort === undefined) return undefined;
  const accepted = runner === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS;
  return accepted.includes(effort) ? effort : undefined;
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
  // Observability lane (native-path liveness): point sandcastle's file-log at
  // the attempt dir's sandcastle.log and, when a sink is provided, forward each
  // agent stream event to it via `logging.onAgentStreamEvent`. sandcastle only
  // exposes the stream callback in "file" logging mode, so the callback rides
  // alongside the path. Omitting `logPath` leaves `logging` unset (sandcastle
  // default) — backward-compatible for callers/tests that don't observe.
  const logging: RunOptions["logging"] | undefined = input.logPath
    ? {
        type: "file",
        path: input.logPath,
        ...(input.onAgentEvent ? { onAgentStreamEvent: input.onAgentEvent } : {}),
      }
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
    // sandcastle defaults maxIterations to 1, which stops the agent before it
    // can emit DONE (issue #322). Set a generous, env-tunable ceiling so the
    // completionSignal stays the real terminator.
    maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_S,
    ...(hooks ? { hooks } : {}),
    ...(logging ? { logging } : {}),
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
  // FIX H: sandcastle's run() rejects with Effect-style errors (AgentError /
  // ExecError, see errors.d.ts) whose quota / usage-limit text usually lands on
  // `.message`, but may be nested under `.cause`, `.error`, or only reachable via
  // `toString()`. Recursively collect every reachable string field (bounded
  // depth + a visited set, so a cyclic Cause can't loop) and match the exhaustion
  // regex against any of them. This only ever BROADENS detection — a non-quota
  // error still has no matching string anywhere — so it cannot reclassify a real
  // failure as exhaustion.
  const parts: string[] = [];
  collectErrorStrings(error, parts, new Set(), 0);
  return parts.some((p) => isRunnerExhausted(p));
}

/** Recursively gather string values reachable from an error-ish value, bounded
 * by depth and a visited set so cyclic Effect `Cause` graphs terminate. */
function collectErrorStrings(value: unknown, out: string[], seen: Set<object>, depth: number): void {
  if (depth > 5) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  // Capture a custom toString() (Effect errors render the quota text here even
  // when no plain string field carries it). Skip the default Object.prototype
  // tag, which is pure noise ("[object Object]").
  const str = String(value);
  if (str && str !== "[object Object]") out.push(str);
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectErrorStrings(v, out, seen, depth + 1);
  }
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
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  // FIX F: continuous-push is a host.onWorktreeReady hook, which sandcastle only
  // runs for host-visible worktrees (noSandbox / bind-mount). Under docker/podman
  // the agent works in an isolated copy the hook can't see, so the push silently
  // never fires — a SIGKILL mid-run loses every intermediate commit with no
  // backup. Surface that the resilience guarantee does not apply (behaviour
  // unchanged; advisory only).
  if (input.continuousPush && (input.sandboxMode === "docker" || input.sandboxMode === "podman")) {
    warn(
      `[afk] warn: continuous-push is unavailable under ${input.sandboxMode} isolation; ` +
        "intermediate commits are not backed up mid-run — final sync only.",
    );
  }
  // FIX J: deliver the pre_worktree hook env (e.g. CARGO_TARGET_DIR=.../slot-N)
  // to the sandcastle-spawned agent. RunOptions has no `env` field, so for the
  // default noSandbox mode — where the agent inherits this worker process's
  // env — we apply it to process.env right before the run. Each fleet worker is
  // its own process, so this is isolated per-worker. Under docker/podman the env
  // must enter the container instead (sandbox env lane) — out of scope (#284).
  for (const [k, v] of Object.entries(input.env ?? {})) process.env[k] = v;
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
  // FIX D: the effort unions differ per provider (codex tops out at "xhigh", no
  // "max"). Gate the requested effort against the provider's accepted set BEFORE
  // building the agent: an out-of-range value (e.g. codex + "max") is DROPPED
  // (provider default) with a warn rather than cast through to a runtime provider
  // rejection / infra crash. Degrade safely — never throw on a misconfig.
  const warn = (m: string) => console.warn(m);
  const agentFor: SandcastleDeps["agentFor"] = (runner, model, opts) => {
    const requested = opts?.effort;
    const effort = effortForProvider(runner, requested);
    if (requested !== undefined && effort === undefined) {
      warn(
        `[afk] warn: effort '${requested}' is not accepted by runner '${runner}' ` +
          `(accepted: ${(runner === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS).join(", ")}); ` +
          "falling back to the provider default.",
      );
    }
    // `effort` is now guaranteed to be in the provider's accepted union; the cast
    // narrows the shared AgentEffort union to each provider's option literal.
    return runner === "codex"
      ? core.codex(model, effort ? ({ effort } as Parameters<typeof core.codex>[1]) : undefined)
      : core.claudeCode(model, effort ? ({ effort } as Parameters<typeof core.claudeCode>[1]) : undefined);
  };
  const sandboxFor: SandcastleDeps["sandboxFor"] = (mode) => {
    if (mode === "docker") return dockerMod.docker();
    if (mode === "podman") return podmanMod.podman();
    return noSandboxMod.noSandbox();
  };
  return { run: core.run as SandcastleDeps["run"], agentFor, sandboxFor, warn };
}
