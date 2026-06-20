// AFK execution backend on @reddb-io/red-castle (ADR 0033).
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

import type { AgentStreamEvent, RunOptions, RunResult } from "@reddb-io/red-castle";
import { isRunnerExhausted } from "./runner-spawn.js";
import { startLaneIdleReaper, DEFAULT_STALL_POLL_S } from "./lane-idle-reaper.js";
import { openCodeAuthEnv, resolveOpenCodeAuth } from "./opencode-env.js";

// Re-exported so process-issue / run can type their agent-event sink without
// importing the sandcastle package directly (execution.ts is the single seam
// coupled to sandcastle, ADR 0033).
export type { AgentStreamEvent } from "@reddb-io/red-castle";

// The runners with a first-class sandcastle agent provider. `opencode` (ADR
// 0059) is endpoint-agnostic — OpenCode itself routes `<provider>/<model>` slugs
// to OpenAI / OpenRouter / MiniMax / any OpenAI-compatible endpoint using the
// first set auth env-var (`OPENAI_API_KEY` > `MINIMAX_API_KEY` >
// `OPENROUTER_API_KEY`, see `opencode-env.ts`). AFK only propagates the key
// through `OpenCodeOptions.env`; OpenCode owns endpoint resolution. `opencode`
// is accepted only as an explicit pin (`--runner opencode` /
// `RED_AFK_RUNNER=opencode`), never auto-sniffed (runner-detection.ts), since
// no host session is OpenCode. `hermes` is a runner-neutral fallback contract
// with NO sandcastle provider, so it is not in this union — process-issue
// coerces it onto a backed runner before spawning.
export type AgentRunner = "claude" | "codex" | "opencode";
export type SandboxMode = "none" | "docker" | "podman";
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
// `exhausted` is surfaced when sandcastle's run() signals quota / rate-limit
// (RUNNER_EXHAUSTED in the shell port). `runner-transient` is surfaced when the
// runner transport/setup path failed before AFK got a usable agent result (for
// example Codex websocket 502 / thread-start failures). Both ride the same
// outcome union so process-issue can branch on them without treating the worker
// as crashed.
// `timeout` is surfaced when AFK's attempt wall-clock guard aborts a run that is
// alive but making no progress (no new commit within the cap) — the "productive
// infinite loop" the idle / max-iteration / stall guards all miss. It maps to the
// `stalled` terminal outcome downstream (→ blocked:stalled, ready-for-human),
// preserving the worktree/PR.
// `goal-moot` (ADR 0057): the attempt-guard poll observed the claimed issue
// already CLOSED, so the attempt's goal is already reflected in the world. The
// inner agent is aborted and process-issue maps it to a deterministic terminal
// outcome (own-merge → done, foreign close → claim-lost) without envelope spam.
export type AgentOutcome =
  | "done"
  | "blocked"
  | "no-sentinel"
  | "exhausted"
  | "runner-transient"
  | "timeout"
  | "goal-moot";

/** AFK's canonical sentinels, registered as sandcastle completion signals. */
export const DONE_SIGNAL = "<promise>DONE</promise>";
export const BLOCKED_SIGNAL = "<promise>BLOCKED</promise>";
export const COMPLETION_SIGNALS: readonly string[] = [DONE_SIGNAL, BLOCKED_SIGNAL];

export const DEFAULT_IDLE_TIMEOUT_S = 600;

/**
 * Attempt wall-clock guard (proof-of-PROGRESS): the inner agent is aborted when
 * no NEW commit has landed on the worker branch within this many seconds.
 * `idleTimeoutSeconds` catches *silence* (no output) and `maxIterations` caps
 * *re-invocations*, but a single iteration that stays busy — re-exploring,
 * re-running tests — without ever committing or signalling slips past both and
 * burns cycle indefinitely (the 1h41m #834 hang). The clock resets on every new
 * commit, so a steadily-committing agent is never killed; only one that spins
 * without producing work is. Env-tunable via `RED_AFK_ATTEMPT_TIMEOUT_S`.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_S = 2700;

/** Parse `RED_AFK_ATTEMPT_TIMEOUT_S` / `afk.attempt_timeout`: a positive integer,
 * else undefined (caller falls back to {@link DEFAULT_ATTEMPT_TIMEOUT_S}). `0`
 * is rejected (use a large value to effectively disable; never silently off). */
export function parseAttemptTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return undefined;
}

/**
 * Commit-anchored HARD cap on the attempt guard (issue #637): the edit-signal
 * (ADR 0051) may extend the soft deadline only this many seconds past the last
 * commit (or spawn). A busy-but-unproductive agent that re-validates in a loop
 * while occasionally touching a file resets the soft deadline forever — the
 * observed #579 worker burned 5h+ that way. Past the hard cap with no NEW
 * commit, the guard aborts regardless of worktree edits, which routes the
 * attempt to the `timeout` terminal where the ADR 0055 reconcile can land an
 * already-committed green branch without re-running the agent. Env-tunable via
 * `RED_AFK_ATTEMPT_HARD_CAP_S`.
 */
export const DEFAULT_ATTEMPT_HARD_CAP_S = 5400;

/** Parse `RED_AFK_ATTEMPT_HARD_CAP_S`: a positive integer, else undefined
 * (caller falls back to {@link DEFAULT_ATTEMPT_HARD_CAP_S}). Same typo-safe
 * contract as {@link parseAttemptTimeout} — `0` cannot disable the cap. */
export function parseAttemptHardCap(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  return undefined;
}

/**
 * The re-invocation ceiling handed to sandcastle's Orchestrator (issue #322).
 *
 * sandcastle's own DEFAULT_MAX_ITERATIONS is 1 (run.js), which cuts the inner
 * agent off after a SINGLE agentic invocation — it explores / writes files but
 * exhausts that one iteration's budget BEFORE it can emit `<promise>DONE</promise>`,
 * so AFK sees no completionSignal → no-sentinel → blocked:crashed and never
 * merges. The completionSignal (DONE/BLOCKED) is the REAL terminator; this is
 * only the safety ceiling for "the agent never signals". 20 is generous vs the
 * broken 1 yet bounded vs runaway: each iteration is itself bounded by
 * `idleTimeoutSeconds`, and DONE/BLOCKED stops the loop early, so a normal issue
 * finishes in 1-3 iterations and 20 is purely the cap — enough headroom for a
 * thorough agent without turning repeated no-sentinel failures into long loops.
 * Raised 12 → 20 because heavy issues (e.g. Rust replication that re-runs the
 * full `cargo test` suite to re-validate) legitimately spend more agentic turns
 * and were hitting the cap with a complete, mergeable branch but no sentinel.
 * The cap is the symptom-bound, not the cure — the real fix is the agent
 * emitting DONE as soon as the gate is green (AGENT-PROMPT) + a runtime salvage
 * of a no-sentinel-but-mergeable branch. Env-tunable via RED_AFK_MAX_ITERATIONS
 * (parsed by `parseMaxIterations`).
 */
export const DEFAULT_MAX_ITERATIONS = 20;

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
  /**
   * Path to the materialised handoff file. Still written to disk (worktree-wipe
   * survival + post-mortem + the `current.handoff` state pointer), but NO LONGER
   * the agent prompt — see {@link RunAgentInput.handoffContent}.
   */
  handoffPath: string;
  /**
   * The verbatim handoff text, delivered to red-castle as an **inline** prompt
   * (`prompt`, source `"inline"`) rather than a `promptFile` template (#758).
   *
   * red-castle runs `{{KEY}}` substitution **and** `` !`command` `` shell
   * expansion on `promptFile` templates, so any issue body carrying a literal
   * `{{…}}` (→ "no matching value" PromptError) or a code span ending in `!`
   * (Rust macros → false `` !` `` shell-exec, #756) crashed prompt resolution
   * before iteration 1 and orphaned the issue in `running`. AFK handoffs are
   * opaque text that never intends either feature, so inline delivery (which
   * red-castle passes through verbatim) is immune to the whole class.
   */
  handoffContent: string;
  /**
   * The AFK exit-protocol contract, delivered as a system prompt rather than
   * appended to the handoff body. red-castle picks the per-CLI delivery: claude
   * `--append-system-prompt` (a real system prompt, out of the user turn);
   * codex/opencode prepend it to the handoff content (no flag exists). Omitted →
   * no contract delivered.
   */
  systemPrompt?: string;
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
   * the "file" mode). AFK points this at the attempt dir's `afk.log` — our ONE
   * canonical log — so red-castle's setup narration (worktree / sandbox / deps)
   * AND the inner agent's formatted stream land in the same file as the heartbeat
   * lines, under `.red/`. (Was a separate `sandcastle.log`; unified so the log is
   * never empty during setup.)
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
  /**
   * Attempt wall-clock guard cap in seconds (proof-of-progress). When set,
   * `runAgent` aborts the sandcastle run if no NEW commit appears on the worker
   * branch within this window, resetting on each commit. Omitted → no guard
   * (back-compat for callers/tests that don't opt in). `makeRunAgent` threads
   * `RED_AFK_ATTEMPT_TIMEOUT_S` / `afk.attempt_timeout` here. See
   * {@link DEFAULT_ATTEMPT_TIMEOUT_S}.
   */
  attemptTimeoutSeconds?: number;
  /**
   * Commit-anchored HARD cap in seconds (issue #637): bounds how long the
   * edit-signal (`progressProbe`) may keep extending the soft deadline past the
   * last commit. Only meaningful when the guard is armed. Omitted → soft cap
   * only (back-compat). `makeRunAgent` threads `RED_AFK_ATTEMPT_HARD_CAP_S`
   * here. See {@link DEFAULT_ATTEMPT_HARD_CAP_S}.
   */
  attemptHardCapSeconds?: number;
  /**
   * Returns the current HEAD sha of the worker branch (the progress signal the
   * guard watches). Best-effort: resolves `undefined` on any git failure, which
   * the guard treats as "no progress observed". Required for the guard to arm.
   */
  headProbe?: () => Promise<string | undefined>;
  /**
   * Returns a monotone-ish "work volume" for the worker's worktree — the total
   * changed lines (added + removed) vs the merge-base, committed AND uncommitted.
   * The guard treats a CHANGE in this value between polls as progress and resets
   * the deadline, so a runner that edits without committing (codex emits DONE
   * only at the end) is not falsely stalled while it is actively producing code.
   * Best-effort: resolves `undefined` on any failure (no edit signal → the guard
   * falls back to the commit-anchored `headProbe` alone — the prior behaviour).
   * Optional: when absent, the guard is purely commit-anchored (ADR 0044).
   */
  progressProbe?: () => Promise<number | undefined>;
  /**
   * Externalized proof-of-life sink (PR-B): invoked once per attempt-guard poll
   * with the progress signal. Opaque to execution.ts — the caller (processIssue)
   * uses it to fire the `on_heartbeat` hook + emit the heartbeat record/state.
   * Only fires when the guard is armed (cap + headProbe present).
   */
  onHeartbeat?: (info: AttemptProgressInfo) => void;
  /**
   * Goal predicate (ADR 0057): reads the claimed issue's CLOSED state on the
   * existing attempt-guard poll (one issue-state read per tick). When it resolves
   * `true` the attempt is aborted as moot and `runAgent` returns the `goal-moot`
   * outcome (process-issue maps it: own-merge → done, foreign → claim-lost). Only
   * fires when the guard is armed (cap + headProbe present). Omitted → disabled.
   */
  goalProbe?: () => Promise<boolean | undefined>;
  /**
   * Lane-idle stall reaper (issue #363) — the solo-path port of the fleet's
   * passive stall detector + hard stall reaper. COMPLEMENTARY to the #400
   * attempt PROGRESS guard above (which is commit-anchored and caps the whole
   * attempt): this cuts an *idle* hang at the stall threshold (minutes) rather
   * than only at the progress cap, gated on the same busy-predicate so a worker
   * mid-build/test is never killed. Armed only when all of `laneIdleThresholdSeconds`,
   * `laneIdleKillThresholdSeconds`, `laneMtimeProbe`, and `inspectTree` are
   * supplied (no-sandbox only — see `makeRunAgent`). On a kill verdict the run is
   * aborted (sandcastle SIGTERM/SIGKILLs the inner tree) and the outcome is
   * `no-sentinel`, flowing through the existing no-sentinel terminal policy
   * (envelope + label rotation + worktree teardown).
   */
  laneIdleThresholdSeconds?: number;
  /** Lane-idle hard-reap threshold (RED_AFK_STALL_KILL_THRESHOLD_S). Must be
   * strictly greater than `laneIdleThresholdSeconds` — validated at boot by the
   * caller (resolveLaneIdleStallConfig). */
  laneIdleKillThresholdSeconds?: number;
  /** Lane-idle poll cadence in seconds (RED_AFK_STALL_POLL_S). Omitted →
   * DEFAULT_STALL_POLL_S. */
  laneIdlePollSeconds?: number;
  /**
   * Agent-lane (`agent.log.jsonl`) mtime probe in epoch SECONDS, 0 when absent.
   * The clean liveness signal — never afk.log / the firehose, which the
   * heartbeat keeps fresh and would mask a real stall (#243). Required to arm
   * the lane-idle reaper.
   */
  laneMtimeProbe?: () => number;
  /**
   * Inner-agent process-tree snapshot for the lane-idle reaper's busy-predicate
   * (reduced by deriveSnapshot). Required to arm the reaper. The real wiring
   * (runtime/proc-tree.ts) is safe-by-default — a failed `ps` reports busy, so a
   * flaky inspection can never authorise a kill.
   */
  inspectTree?: () => readonly import("./reaper-signal.js").ProcessSnapshotEntry[];
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
  /**
   * Build the sandbox provider for a mode. `opts.mountPath` (issue #405) is the
   * absolute host attempt dir: under docker/podman it is added as a bind-mount at
   * the identical path inside the container so the attempt dir's proof-of-life
   * lane (afk.state.json / agent.log.jsonl / log.jsonl) AND the worktree
   * sandcastle creates under it are host-visible in real time — the precondition
   * for arming the progress guard + heartbeat under isolation. Ignored for the
   * host-native `none` mode (no container to mount into).
   */
  sandboxFor: (mode: SandboxMode, opts?: { mountPath?: string }) => RunOptions["sandbox"];
  /**
   * Optional warn sink for degrade-safe diagnostics (FIX D effort drop, FIX F
   * continuous-push-under-isolation notice). Defaults to `console.warn` in the
   * real wiring; tests inject a recorder. Never throws — these are advisories.
   */
  warn?: (message: string) => void;
  /** Injectable clock (ms) for the attempt guard. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable periodic scheduler for the attempt guard — runs `fn` every `ms`
   * and returns a cancel function. Defaults to a `setInterval` wrapper (with
   * `unref` so it never keeps the process alive). Tests inject a manual pump.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /** Injectable `AbortController` factory for the attempt guard. Defaults to
   * `() => new AbortController()`. */
  makeAbortController?: () => AbortController;
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

/**
 * @deprecated Retained for source-level back-compat with the #626 contract; the
 * env-precedence resolver (`opencode-env.ts`) is the source of truth now. New
 * callers should use `OPENCODE_AUTH_ENV_PRECEDENCE` from there.
 */
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";

/**
 * The subset of the sandcastle package surface `buildAgent` needs — the three
 * provider factories AFK can drive. Injected so the runner→provider mapping
 * (model slug, effort/variant gating, auth env passthrough) is unit-testable
 * with fakes, without importing the package (which pulls real provider deps).
 * `defaultSandcastleDeps` supplies the real `core.{claudeCode,codex,opencode}`.
 */
export interface AgentFactories {
  claudeCode: (model: string, options?: { effort?: AgentEffort }) => RunOptions["agent"];
  codex: (model: string, options?: { effort?: AgentEffort }) => RunOptions["agent"];
  opencode: (model: string, options?: { variant?: string; env?: Record<string, string> }) => RunOptions["agent"];
}

/**
 * Map a runner+model+effort to a sandcastle agent provider, reading any provider
 * env passthrough from `env`. Pure: the package factories and the environment are
 * injected.
 *
 * - **claude / codex**: the requested effort is gated per provider (FIX D, see
 *   {@link effortForProvider}); an out-of-range value is DROPPED to the provider
 *   default with a warn rather than cast through to a runtime rejection. It is
 *   passed as the provider's numeric `effort` option.
 * - **opencode** (ADR 0059, amended): the model is `<provider>/<model>` where
 *   the leading segment tells OpenCode which endpoint to dispatch to
 *   (`openrouter/...`, `openai/...`, `minimax/...`, …). AFK's effort maps to
 *   OpenCode's `variant` (its own reasoning knob — a free-form string,
 *   distinct from the numeric effort the other two take), so no gating
 *   applies. The auth key — whichever precedence entry is set, see
 *   `opencode-env.ts` — is delivered through `OpenCodeOptions.env` (the auth
 *   seam). When NO auth env-var is set, no `env` option is added; OpenCode
 *   falls back to its own default lookup and surfaces its own auth error if no
 *   key is available through any other channel.
 */
export function buildAgent(
  factories: AgentFactories,
  runner: AgentRunner,
  model: string,
  opts: { effort?: AgentEffort } | undefined,
  env: NodeJS.ProcessEnv,
  warn?: (message: string) => void,
): RunOptions["agent"] {
  const requested = opts?.effort;

  if (runner === "opencode") {
    const options: { variant?: string; env?: Record<string, string> } = {};
    if (requested !== undefined) options.variant = requested;
    const authEnv = openCodeAuthEnv(resolveOpenCodeAuth(env));
    if (authEnv) options.env = authEnv;
    return factories.opencode(model, Object.keys(options).length > 0 ? options : undefined);
  }

  const effort = effortForProvider(runner, requested);
  if (requested !== undefined && effort === undefined) {
    warn?.(
      `[afk] warn: effort '${requested}' is not accepted by runner '${runner}' ` +
        `(accepted: ${(runner === "codex" ? CODEX_EFFORTS : CLAUDE_EFFORTS).join(", ")}); ` +
        "falling back to the provider default.",
    );
  }
  return runner === "codex"
    ? factories.codex(model, effort ? { effort } : undefined)
    : factories.claudeCode(model, effort ? { effort } : undefined);
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
  // the attempt dir's afk.log (the unified log, set by the caller) and, when a
  // sink is provided, forward each
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
    // Bind-mount the host attempt dir into the container at the identical path
    // (issue #405) so the proof-of-life lane + the worktree sandcastle creates
    // under it are host-visible mid-run — the precondition for arming the guard +
    // heartbeat under docker/podman. `none` ignores `mountPath` (no container).
    sandbox: deps.sandboxFor(input.sandboxMode ?? "none", input.cwd ? { mountPath: input.cwd } : undefined),
    // Re-anchor sandcastle's `.sandcastle/` dir + git ops at the caller's cwd
    // (AFK's per-attempt dir under .red/) so nothing is generated at the repo
    // root. Omitted → sandcastle defaults to process.cwd().
    ...(input.cwd ? { cwd: input.cwd } : {}),
    // Deliver the handoff INLINE (verbatim), not as a `promptFile` template:
    // red-castle expands `{{KEY}}` + `` !`cmd` `` only for templates, which
    // crashed prompt resolution on opaque issue-body content (#756, #758). AFK
    // passes no promptArgs, so inline is a clean pass-through.
    prompt: input.handoffContent,
    ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
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

/**
 * True when a sandcastle failure looks like a transient runner transport/setup
 * failure rather than agent-authored work. These should be bounded by AFK's
 * retry policy (cooldown circuit + capped retries → exit 75), not escape as raw
 * worker crashes that kill the orchestrator and orphan the issue in `running`.
 *
 * Covers two families: (a) Codex transport/setup hiccups (websocket, thread
 * start, spawn/cwd); and (b) **provider server-side overload** — a `529
 * Overloaded` / `overloaded_error` (Anthropic) or `503 Service Unavailable`,
 * which is temporary and server-side, not your code or your quota. Before this,
 * a 529 matched neither the exhaustion nor the transient pattern, so it hit the
 * `throw error` fall-through and crashed the whole drain (observed on the reddb
 * AFK lane: a sustained 529 killed the orchestrator mid-drain, orphaning the
 * claimed issue in `running`).
 */
export function isTransientRunnerError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const parts: string[] = [];
  collectErrorStrings(error, parts, new Set(), 0);
  return parts.some((p) => runnerTransientPattern.test(p));
}

const runnerTransientPattern =
  /failed to connect to websocket|HTTP error:\s*502 Bad Gateway|HTTP error:\s*503 Service Unavailable|\b529\b|overloaded|wss:\/\/chatgpt\.com\/backend-api\/codex\/responses|thread\/start failed|failed to load configuration|spawn sh ENOENT|cwd does not exist/i;

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

/** Default periodic scheduler: a `setInterval` that never keeps the event loop
 * alive (so a hung guard can't block process exit). */
function defaultSchedule(fn: () => void, ms: number): () => void {
  const t = setInterval(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearInterval(t);
}

/**
 * Arm the attempt progress guard. Polls `headProbe` every `intervalMs`; the
 * deadline resets whenever the HEAD sha ADVANCES (a new commit = real progress),
 * and `abort` fires once `capMs` elapses with no advance. Pure over its injected
 * clock / scheduler — no real timers, no git — so it is fully unit-testable. The
 * first observed head anchors the clock (≈ from spawn). A `headProbe` rejection
 * is treated as "no progress observed" (never resets), so a flaky git read
 * cannot keep a hung agent alive.
 */
export interface AttemptProgressInfo {
  /** The worker branch HEAD observed this tick (undefined when unresolved). */
  head: string | undefined;
  /** Epoch ms of the last observed progress (last new commit, or spawn). */
  lastProgressMs: number;
  /** The guard's clock (epoch ms) at this tick. */
  nowMs: number;
  /** Resolved base branch (lock > pin > main) for this attempt — populated by
   * processIssue so the emitHeartbeat sink can diff against the correct ref. */
  base?: string;
}

export function startAttemptGuard(opts: {
  capMs: number;
  intervalMs: number;
  headProbe: () => Promise<string | undefined>;
  now: () => number;
  schedule: (fn: () => void, ms: number) => () => void;
  /** `reason` distinguishes the soft commit/edit deadline ("stalled") from the
   * commit-anchored hard cap ("hard-cap", issue #637) and the goal predicate
   * ("goal-moot", ADR 0057 — the claimed issue is already CLOSED). Callbacks that
   * ignore the argument keep the prior behaviour. */
  abort: (reason: "stalled" | "hard-cap" | "goal-moot") => void;
  /**
   * Goal predicate (ADR 0057): reads the claimed issue's CLOSED state on THIS
   * same poll (one issue-state read per tick — no extra polling loop). Resolves
   * `true` when the issue is CLOSED, `false` when open, `undefined` on a gh /
   * network failure. Only a definite `true` aborts the attempt ("goal-moot");
   * `false` / `undefined` are no-ops, so a flaky read never kills on uncertainty.
   * Optional → omitted means the goal predicate is disabled (prior behaviour).
   */
  goalProbe?: () => Promise<boolean | undefined>;
  /** Worktree line-volume probe (ADR 0051): a CHANGE between polls counts as
   * progress and resets the deadline, so an editing-but-not-committing runner
   * (codex) is not falsely stalled. Optional → guard stays commit-anchored. */
  progressProbe?: () => Promise<number | undefined>;
  /** Commit-anchored hard cap (issue #637): when set, edit-signal resets may
   * extend the deadline only this long past the last commit (or spawn) — once
   * `hardCapMs` elapses with no NEW commit, abort fires regardless of worktree
   * edits. Without it a busy-but-unproductive agent that touches a file every
   * <capMs resets the soft deadline forever. Optional → soft cap only. */
  hardCapMs?: number;
  /** Fired once per poll (proof-of-life externalization): the externalized
   * heartbeat + on_heartbeat hook ride this same cadence (PR-B). Never throws —
   * the caller wraps its own IO. */
  onTick?: (info: AttemptProgressInfo) => void;
}): { stop: () => void; firedTimeout: () => boolean; firedGoalMoot: () => boolean } {
  let lastProgress = opts.now();
  let lastCommit = opts.now();
  let lastHead: string | undefined;
  let lastVolume: number | undefined;
  let fired = false;
  let goalMoot = false;
  const cancel = opts.schedule(() => {
    void (async () => {
      if (fired) return;
      // Goal predicate (ADR 0057): rides THIS poll — one issue-state read per
      // tick, no separate loop. A definite CLOSED means the attempt's goal is
      // already reflected in the world (someone landed it, or our own merge), so
      // the attempt is moot: abort. An open issue OR a failed read (`!== true`)
      // is a no-op — the predicate never kills on uncertainty. Checked before the
      // progress/deadline logic so a busy-but-committing agent on an already-closed
      // issue is still terminated within ~2 poll intervals.
      if (opts.goalProbe) {
        let closed: boolean | undefined;
        try {
          closed = await opts.goalProbe();
        } catch {
          closed = undefined;
        }
        if (fired) return;
        if (closed === true) {
          fired = true;
          goalMoot = true;
          opts.abort("goal-moot");
          return;
        }
      }
      // Commit signal (always present). A headProbe rejection = no progress
      // observed (let the deadline run), matching the prior commit-anchored
      // behaviour exactly when no progressProbe is supplied.
      let head: string | undefined;
      let headOk = true;
      try {
        head = await opts.headProbe();
      } catch {
        headOk = false;
      }
      if (fired) return;
      // Edit signal (optional). A new commit OR a change in the worktree's
      // line-volume since the last poll is real progress → reset the deadline.
      let volume: number | undefined;
      if (opts.progressProbe) {
        try {
          volume = await opts.progressProbe();
        } catch {
          volume = undefined;
        }
      }
      if (fired) return;
      const committed = headOk && head !== undefined && head !== lastHead;
      const edited = volume !== undefined && lastVolume !== undefined && volume !== lastVolume;
      if (committed) {
        lastProgress = opts.now();
        lastCommit = opts.now();
      } else if (edited) {
        lastProgress = opts.now();
      }
      // The soft deadline resets on commit OR edit; the hard cap resets on
      // commit ONLY, so periodic edits cannot keep an uncommitting agent alive
      // past it (issue #637 — the 5h+ re-validation loop).
      const softExpired = !committed && !edited && opts.now() - lastProgress >= opts.capMs;
      const hardExpired = !committed && opts.hardCapMs !== undefined && opts.now() - lastCommit >= opts.hardCapMs;
      if (softExpired || hardExpired) {
        fired = true;
        opts.abort(hardExpired && !softExpired ? "hard-cap" : "stalled");
      }
      if (headOk && head !== undefined) lastHead = head;
      if (volume !== undefined) lastVolume = volume;
      opts.onTick?.({ head: head ?? lastHead, lastProgressMs: lastProgress, nowMs: opts.now() });
    })();
  }, opts.intervalMs);
  return { stop: cancel, firedTimeout: () => fired && !goalMoot, firedGoalMoot: () => goalMoot };
}

/**
 * Run the inner agent on the issue via sandcastle and normalise the result.
 *
 * sandcastle's `run()` can signal exhaustion two ways: by throwing an error
 * whose message matches the exhaustion patterns (the common case — the provider
 * raises on a 429 / usage-limit), or by completing with exhaustion text on
 * stdout. Both map to the `exhausted` outcome (no commits, no sentinel). Any
 * other thrown error propagates unchanged.
 *
 * When `attemptTimeoutSeconds` + `headProbe` are supplied, an attempt progress
 * guard runs alongside: if no new commit lands within the cap, the run is
 * aborted (sandcastle kills the in-flight agent, preserving the worktree) and
 * the result is the `timeout` outcome.
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

  // Attempt progress guard (proof-of-progress): abort the run if no new commit
  // lands within the cap. Armed only when both the cap and a headProbe are
  // supplied; otherwise behaviour is unchanged.
  const now = deps.now ?? (() => Date.now());
  const makeController = deps.makeAbortController ?? (() => new AbortController());
  const schedule = deps.schedule ?? defaultSchedule;
  let guard: { stop: () => void; firedTimeout: () => boolean; firedGoalMoot: () => boolean } | undefined;
  let laneReaper: { stop: () => void; firedReap: () => boolean } | undefined;
  let controller: AbortController | undefined;
  if (input.attemptTimeoutSeconds && input.attemptTimeoutSeconds > 0 && input.headProbe) {
    const capMs = input.attemptTimeoutSeconds * 1000;
    controller = makeController();
    const cap = input.attemptTimeoutSeconds;
    const hardCap = input.attemptHardCapSeconds;
    guard = startAttemptGuard({
      capMs,
      intervalMs: Math.min(capMs, 60_000),
      headProbe: input.headProbe,
      ...(input.progressProbe ? { progressProbe: input.progressProbe } : {}),
      ...(hardCap && hardCap > 0 ? { hardCapMs: hardCap * 1000 } : {}),
      now,
      schedule,
      ...(input.goalProbe ? { goalProbe: input.goalProbe } : {}),
      abort: (reason) =>
        controller?.abort(
          new Error(
            reason === "goal-moot"
              ? "afk: attempt mooted — the claimed issue is already CLOSED (goal predicate, ADR 0057)"
              : reason === "hard-cap"
                ? `afk: attempt aborted — no new commit within ${hardCap}s despite worktree edits (hard cap, stalled)`
                : `afk: attempt aborted — no new commit within ${cap}s (stalled)`,
          ),
        ),
      // Externalized proof-of-life (PR-B): each poll fires the caller's opaque
      // heartbeat sink (firehose record + state.last_progress_at + on_heartbeat
      // hook). execution.ts stays ignorant of what it does.
      ...(input.onHeartbeat ? { onTick: input.onHeartbeat } : {}),
    });
  }

  // Lane-idle stall reaper (issue #363): the solo-path port of the fleet's
  // passive stall detector + hard stall reaper. COMPLEMENTARY to the progress
  // guard above (commit-anchored) — this cuts an *idle* hang at the stall
  // threshold, gated on the same busy-predicate. Armed when both thresholds plus
  // the lane probe + tree inspector are supplied. Shares the run's
  // AbortController so a kill tears down the same inner tree; runs on its own
  // side-channel poll (independent of the inner-agent stream) so a fully-hung
  // runner is still observed.
  if (
    input.laneIdleThresholdSeconds &&
    input.laneIdleThresholdSeconds > 0 &&
    input.laneIdleKillThresholdSeconds &&
    input.laneIdleKillThresholdSeconds > 0 &&
    input.laneMtimeProbe &&
    input.inspectTree
  ) {
    if (!controller) controller = makeController();
    const killController = controller;
    const pollS = input.laneIdlePollSeconds && input.laneIdlePollSeconds > 0 ? input.laneIdlePollSeconds : DEFAULT_STALL_POLL_S;
    laneReaper = startLaneIdleReaper({
      spawnEpoch: Math.floor(now() / 1000),
      stallThresholdS: input.laneIdleThresholdSeconds,
      stallKillThresholdS: input.laneIdleKillThresholdSeconds,
      intervalMs: pollS * 1000,
      laneMtime: input.laneMtimeProbe,
      inspectTree: input.inspectTree,
      // The lane reaper reasons in epoch SECONDS (lane mtime is seconds); the
      // shared clock `now` is ms, so divide here.
      now: () => Math.floor(now() / 1000),
      schedule,
      abort: () =>
        killController.abort(
          new Error(`afk: attempt reaped — agent lane idle past ${input.laneIdleKillThresholdSeconds}s with no active build/test (stalled)`),
        ),
    });
  }

  let result: RunResult;
  try {
    const options = buildRunOptions(deps, input);
    result = await deps.run(controller ? { ...options, signal: controller.signal } : options);
  } catch (error) {
    // The lane-idle reaper aborted: agent lane silent past the kill threshold
    // with no active build/test descendant + flat cpu → genuinely stuck. Map to
    // no-sentinel so it flows through the existing no-sentinel terminal policy.
    // Checked before the progress guard: an idle hang trips the faster lane layer
    // first, and "no-sentinel" is the issue-mandated outcome for a lane-idle reap.
    if (laneReaper?.firedReap()) {
      return {
        outcome: "no-sentinel",
        branch: input.branch,
        commits: [],
        stdout: `afk: attempt reaped — agent lane idle past ${input.laneIdleKillThresholdSeconds}s with no active build/test (stalled)`,
      };
    }
    // The goal predicate fired (ADR 0057): the claimed issue is already CLOSED,
    // so the attempt is moot. Surface the dedicated outcome — process-issue maps
    // it deterministically (own-merge → done, foreign close → claim-lost) without
    // a terminal envelope. Checked before the stall guard: a goal-moot abort sets
    // its own flag and firedTimeout() excludes it, so they never collide.
    if (guard?.firedGoalMoot()) {
      return {
        outcome: "goal-moot",
        branch: input.branch,
        commits: [],
        stdout: "afk: attempt mooted — the claimed issue is already CLOSED (goal predicate, ADR 0057)",
      };
    }
    // The progress guard aborted: alive but not committing → stalled.
    if (guard?.firedTimeout()) {
      return {
        outcome: "timeout",
        branch: input.branch,
        commits: [],
        stdout: `afk: attempt aborted — no new commit within ${input.attemptTimeoutSeconds}s (stalled)`,
      };
    }
    if (isExhaustionError(error)) {
      return { outcome: "exhausted", branch: input.branch, commits: [], stdout: "" };
    }
    if (isTransientRunnerError(error)) {
      return {
        outcome: "runner-transient",
        branch: input.branch,
        commits: [],
        stdout: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  } finally {
    guard?.stop();
    laneReaper?.stop();
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
    import("@reddb-io/red-castle"),
    import("@reddb-io/red-castle/sandboxes/no-sandbox"),
    import("@reddb-io/red-castle/sandboxes/docker"),
    import("@reddb-io/red-castle/sandboxes/podman"),
  ]);
  // FIX D / ADR 0059: the per-provider mapping (effort gating for claude/codex,
  // effort→`variant` for opencode, and the opencode auth env passthrough) lives
  // in the pure `buildAgent`, unit-tested with fake factories. Here we just
  // bind the real `core.*` factories and `process.env` — `buildAgent` reads
  // whichever of OPENAI_API_KEY / MINIMAX_API_KEY / OPENROUTER_API_KEY is set
  // (opencode-env.ts) and forwards it through `OpenCodeOptions.env`. The casts
  // narrow the shared option shape to each provider's option literal —
  // `buildAgent` only ever passes options the factory accepts.
  const warn = (m: string) => console.warn(m);
  const factories: AgentFactories = {
    claudeCode: (model, options) => core.claudeCode(model, options as Parameters<typeof core.claudeCode>[1]),
    codex: (model, options) => core.codex(model, options as Parameters<typeof core.codex>[1]),
    opencode: (model, options) => core.opencode(model, options as Parameters<typeof core.opencode>[1]),
  };
  const agentFor: SandcastleDeps["agentFor"] = (runner, model, opts) =>
    buildAgent(factories, runner, model, opts, process.env, warn);
  const sandboxFor: SandcastleDeps["sandboxFor"] = (mode, opts) => {
    // Issue #405: bind-mount the host attempt dir at the identical path so the
    // worktree sandcastle creates under it + the proof-of-life lane files are
    // host-visible in real time, arming the progress guard + heartbeat under
    // isolation. The mount uses an identity host→sandbox path so host probes
    // (branchHead / worktree diffstat) resolve the same locations the agent
    // writes. hostPath must exist (process-issue creates the attempt dir before
    // the run), else sandcastle fails fast with a clear error.
    const mounts = opts?.mountPath ? [{ hostPath: opts.mountPath, sandboxPath: opts.mountPath }] : undefined;
    if (mode === "docker") return dockerMod.docker(mounts ? { mounts } : undefined);
    if (mode === "podman") return podmanMod.podman(mounts ? { mounts } : undefined);
    return noSandboxMod.noSandbox();
  };
  return { run: core.run as SandcastleDeps["run"], agentFor, sandboxFor, warn };
}
