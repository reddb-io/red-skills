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

import type { AgentStreamEvent, RunOptions, RunResult, LivenessVerdict } from "@reddb-io/red-castle";
import { extractAgentOutput } from "@reddb-io/red-castle";
import { buildLineRedactor } from "../../runtime/outbound-redaction.js";
import { resolveHostEnvAllowlist } from "../host-env-allowlist.js";
import { isRunnerExhausted } from "../runner-spawn.js";
import { startLaneIdleReaper, DEFAULT_STALL_POLL_S } from "../lane-idle-reaper.js";
import { deriveSnapshot } from "../reaper-signal.js";
import { RUNNER_SPECS, runnerSupportsStructuredOutput } from "../runner-spec.js";
import {
  BLOCKED_SIGNAL,
  COMPLETION_SIGNALS,
  DONE_SIGNAL,
} from "@reddb-io/red-castle/engine";
import {
  AGENT_OUTPUT_CLOSE,
  parseAgentOutput,
  type AgentOutput,
} from "../agent-output.js";
import {
  buildContinuousPushHook,
  buildNoLeakCommitMsgHook,
  buildWorktreePathCaptureHook,
  type HostHookCommand,
} from "./host-hooks.js";
import {
  startAttemptGuard,
  type AttemptBudget,
  type AttemptBudgetUsage,
  type AttemptProgressInfo,
  type AttemptTimeoutReason,
} from "./attempt-guard.js";

// Re-exported so process-issue / run can type their agent-event sink without
// importing the sandcastle package directly (execution.ts is the single seam
// coupled to sandcastle, ADR 0033).
// The runners with a first-class sandcastle agent provider. `opencode` (ADR
// 0059) is endpoint-agnostic — OpenCode itself routes `<provider>/<model>` slugs
// to OpenAI / OpenRouter / MiniMax / any OpenAI-compatible endpoint using the
// first set auth env-var (`OPENAI_API_KEY` > `MINIMAX_API_KEY` >
// `OPENROUTER_API_KEY`, see `opencode-env.ts`). AFK only propagates the key
// through `OpenCodeOptions.env`; OpenCode owns endpoint resolution. `opencode`
// is accepted only as an explicit pin (`--runner opencode` /
// `RED_AFK_RUNNER=opencode`), never auto-sniffed (runner-detection.ts), since
// no host session is OpenCode. `claude-minimax` (PRD #788) is likewise an
// explicit-pin-only lane: it reuses the unchanged `claude-code` provider but
// injects a MiniMax Anthropic-compat auth env and forces the `MiniMax-M3` model
// (see {@link buildAgent} and `minimax-env.ts`). `hermes` is a runner-neutral
// fallback contract with NO sandcastle provider, so it is not in this union —
// process-issue coerces it onto a backed runner before spawning.
export type AgentRunner = "claude" | "codex" | "opencode" | "claude-minimax";
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
  // External-signal kill (#1308): the inner process was terminated by an OS
  // signal (SIGKILL/SIGTERM). Carries the signal name in stdout. Routed to
  // `signal-killed` in AttemptOutcome so the kill cause is recorded distinctly
  // from a generic crash — same recovery policy as `no-sentinel`.
  | "signal-killed"
  | "exhausted"
  | "runner-transient"
  | "timeout"
  | "budget-exceeded"
  | "goal-moot";

/** Unix signal exit-code convention: exit code = 128 + signal number. */
const SIGNAL_EXIT_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/**
 * Returns the signal name and raw exit code if the error message matches the
 * Orchestrator's "exited with code N" pattern and N is in the signal range
 * (128–192, i.e. 128 + signal 0–64). Returns null for any other error (#1308).
 */
export function extractSignalKill(error: unknown): { signal: string; exitCode: number } | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /exited with code (\d+)/.exec(message);
  if (!match) return null;
  const exitCode = parseInt(match[1], 10);
  if (exitCode < 128 || exitCode > 192) return null;
  const signalNum = exitCode - 128;
  const signal = SIGNAL_EXIT_NAMES[signalNum] ?? `SIG${signalNum}`;
  return { signal, exitCode };
}

export const DEFAULT_IDLE_TIMEOUT_S = 600;

/**
 * Attempt wall-clock guard (proof-of-PROGRESS): the inner agent is aborted when
 * no NEW commit or other productive signal has landed on the worker branch
 * within this many seconds.
 * `idleTimeoutSeconds` catches *silence* (no output) and `maxIterations` caps
 * *re-invocations*, but a single iteration that stays busy — re-exploring,
 * re-running tests — without ever committing or signalling slips past both and
 * burns cycle indefinitely (the 1h41m #834 hang). The clock resets on every new
 * commit, so a steadily-committing agent is never killed; only one that spins
 * without producing work is.
 */
export const DEFAULT_ATTEMPT_TIMEOUT_S = 2700;

/**
 * Cadence of the independent worker-vitals sampler (ADR 0103). The heartbeat's
 * loc/tokens/tool stamp fires at least this often for EVERY run, independent of
 * the attempt-guard and of inner-agent stream activity, so a codex worker that
 * edits and then blocks on a long test suite still reports its live worktree
 * churn instead of a frozen `+0 -0`. Capped by `heartbeatIntervalMs` so an armed
 * guard's tighter cadence still wins when it is shorter.
 */
export const DEFAULT_VITALS_SAMPLE_MS = 20_000;

/**
 * Dedup window shared by the three heartbeat drivers (guard poll `onTick`, codex
 * stream pulse, and the {@link DEFAULT_VITALS_SAMPLE_MS} sampler). Two emits
 * landing within this window collapse to one, so an armed guard plus the sampler
 * never double-stamp the same instant. Kept well below the sampler interval so a
 * legitimate next sample is never suppressed — it only absorbs near-simultaneous
 * ticks. Sits below the SMALLEST real heartbeat cadence (a 1s attempt cap →
 * 1000ms poll) so consecutive polls always emit, while two drivers landing on
 * the same instant collapse to one.
 */
export const HEARTBEAT_DEDUP_MS = 500;

/**
 * Commit-anchored HARD cap on the attempt guard (issue #637): the edit-signal
 * (ADR 0051) may extend the soft deadline only this many seconds past the last
 * commit (or spawn). A busy-but-unproductive agent that re-validates in a loop
 * while occasionally touching a file resets the soft deadline forever — the
 * observed #579 worker burned 5h+ that way. Past the hard cap with no NEW
 * commit, the guard aborts even if worktree/activity signals keep extending the
 * soft deadline, which routes the attempt to the `timeout` terminal where the
 * ADR 0055 reconcile can land an already-committed green branch without
 * re-running the agent.
 */
export const DEFAULT_ATTEMPT_HARD_CAP_S = 5400;

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
   * The remote-tracking ref for the resolved base (e.g. `origin/main`, ADR 0031)
   * the worker branch is forked from. Passed to sandcastle's NamedBranchStrategy
   * `baseBranch` start point so the branch's parent is the freshly-fetched base,
   * not the potentially-stale local branch. process-issue populates this as
   * `${remote}/${base}` after calling `fetchBase`, so the ref is guaranteed current.
   * Sandcastle only honours it when the branch is created new. Defaults to HEAD
   * when omitted.
   */
  base?: string;
  /** Isolation: "none" (default, node-only) | "docker" | "podman". */
  sandboxMode?: SandboxMode;
  /**
   * Absolute host anchor for sandcastle's `.red-castle/` dir + git operations.
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
   * each event to `agent.log.toonl` (the clean lane `reaper-signal` /
   * `supervisor-fs` read for liveness) + the firehose — without it the lanes'
   * mtime freezes at iteration start and the stall detector / monitor go blind
   * to a live agent. sandcastle swallows any error this callback throws.
   */
  onAgentEvent?: (event: AgentStreamEvent) => void;
  /**
   * Attempt wall-clock guard cap in seconds (proof-of-progress). When set,
   * `runAgent` aborts the sandcastle run if no NEW commit appears on the worker
   * branch within this window, resetting on each commit. Omitted → no guard
   * (back-compat for callers/tests that don't opt in). See
   * {@link DEFAULT_ATTEMPT_TIMEOUT_S}.
   */
  attemptTimeoutSeconds?: number;
  /**
   * Commit-anchored HARD cap in seconds (issue #637): bounds how long the
   * edit-signal (`progressProbe`) may keep extending the soft deadline past the
   * last commit. Only meaningful when the guard is armed. Omitted → soft cap
   * only (back-compat). See {@link DEFAULT_ATTEMPT_HARD_CAP_S}.
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
   * Per-attempt resource budget (#908). When supplied alongside `budgetUsage`,
   * the attempt guard aborts with the `budget-exceeded` outcome once any ceiling
   * is breached. Rides the existing guard poll, so it is active whenever the
   * progress guard is armed (cap + headProbe). Omitted → no budget cap.
   */
  budget?: AttemptBudget;
  /** Sync probe returning the attempt's cumulative usage (the activity meter's
   * `peek()`), read each guard poll to evaluate `budget` and to treat live
   * tool/text activity as productive progress for the soft timeout. */
  budgetUsage?: () => AttemptBudgetUsage;
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
   * Red-castle liveness evaluator verdict probe (ADR 0083 §3). Returns the
   * combined lane-recency + process-cross-check verdict from the attempt's
   * `liveness.lane.jsonl` — the un-poisonable signal (#1022). Required to arm
   * the lane-idle reaper.
   */
  livenessVerdictProbe?: () => LivenessVerdict | null;
  /**
   * Inner-agent process-tree snapshot for the lane-idle reaper's busy-predicate
   * (reduced by deriveSnapshot). Required to arm the reaper. The real wiring
   * (runtime/proc-tree.ts) is safe-by-default — a failed `ps` reports busy, so a
   * flaky inspection can never authorise a kill.
   */
  inspectTree?: () => readonly import("../reaper-signal.js").ProcessSnapshotEntry[];
}

/** The git remote the continuous-push hook targets when none is supplied. */
export const DEFAULT_REMOTE = "origin";

export interface RunAgentResult {
  outcome: AgentOutcome;
  branch: string;
  commits: readonly { sha: string }[];
  completionSignal?: string;
  timeoutReason?: AttemptTimeoutReason;
  /**
   * The validated structured completion (ADR 0082) when the agent emitted a
   * well-formed `<agent-output>` block. Carries `summary`, `key_changes_made`,
   * and `key_learnings` for the PR body / audit trail / memory ingestion, plus
   * the `should_fully_stop` outer-loop signal. Absent when the run completed via
   * the text sentinel alone (the coexistence fallback).
   */
  agentOutput?: AgentOutput;
  stdout: string;
}

// Re-exported so process-issue / callers can consume the structured completion
// without importing agent-output.ts directly (execution.ts stays the runner
// result seam).
/** Provider factories + the sandcastle `run` entrypoint, injected for testing. */
export interface SandcastleDeps {
  run: (options: RunOptions) => Promise<RunResult>;
  agentFor: (runner: AgentRunner, model: string, opts?: { effort?: AgentEffort }) => RunOptions["agent"];
  /**
   * Build the sandbox provider for a mode. `opts.mountPath` (issue #405) is the
   * absolute host attempt dir: under docker/podman it is added as a bind-mount at
   * the identical path inside the container so the attempt dir's proof-of-life
   * lane (afk.state.toon / agent.log.toonl / log.toonl) AND the worktree
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

// The per-provider accepted-effort sets + the full RUNNER_SPECS policy table now
// live in `runner-spec.ts` (issue #823) — the single seam for per-runner provider
// policy. Re-exported here so existing `execution.ts` importers keep working.
/**
 * Validate a requested effort against a provider's accepted set ({@link
 * RUNNER_SPECS}). Returns the effort when accepted, or `undefined` when it must
 * be dropped (degrade to the provider default). Pure — the warn is emitted by
 * the caller (`buildAgent`).
 */
export function effortForProvider(
  runner: AgentRunner,
  effort: AgentEffort | undefined,
): AgentEffort | undefined {
  if (effort === undefined) return undefined;
  return RUNNER_SPECS[runner].efforts.includes(effort) ? effort : undefined;
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
  claudeCode: (model: string, options?: { effort?: AgentEffort; env?: Record<string, string> }) => RunOptions["agent"];
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
  const spec = RUNNER_SPECS[runner];
  const requested = opts?.effort;
  const authEnv = spec.resolveAuthEnv?.(env);

  // opencode (ADR 0059): the effort is OpenCode's free-form `variant` (not
  // gated), and the model `<provider>/<model>` slug is forwarded verbatim — the
  // leading segment tells OpenCode which endpoint to dispatch to. The auth key
  // (precedence owned by opencode-env.ts) rides in on `OpenCodeOptions.env`;
  // with no key set, no `env` option is added and OpenCode owns the fallback.
  if (spec.channel === "variant") {
    const options: { variant?: string; env?: Record<string, string> } = {};
    if (requested !== undefined) options.variant = requested;
    if (authEnv) options.env = authEnv;
    return factories.opencode(model, Object.keys(options).length > 0 ? options : undefined);
  }

  // effort channel (claude / codex / claude-minimax): gate the requested effort
  // against the spec's accepted set (FIX D). A runner with a `defaultEffort`
  // (claude-minimax → "low", PRD #794) CAPS a rejected/absent effort to it and
  // always passes it explicitly so the inner spawn never auto-selects a thinking
  // tier; a runner without one DROPS a rejected effort to the provider default.
  const accepted = requested !== undefined && spec.efforts.includes(requested);
  const effort = accepted ? requested : spec.defaultEffort;
  if (requested !== undefined && !accepted) {
    warn?.(
      spec.defaultEffort !== undefined
        ? `[afk] warn: effort '${requested}' triggers thinking which MiniMax-M3 does not accept; ` +
            `capping to '${spec.defaultEffort}' for runner '${runner}' ` +
            `(accepted: ${spec.efforts.join(", ")}).`
        : `[afk] warn: effort '${requested}' is not accepted by runner '${runner}' ` +
            `(accepted: ${spec.efforts.join(", ")}); ` +
            "falling back to the provider default.",
    );
  }

  // `forcedModel` (claude-minimax → MiniMax-M3) discards the resolved tier model.
  const targetModel = spec.forcedModel ?? model;
  if (spec.factory === "codex") {
    // The codex provider takes no `env` seam; codex never resolves an auth env.
    return factories.codex(targetModel, effort !== undefined ? { effort } : undefined);
  }
  const options: { effort?: AgentEffort; env?: Record<string, string> } = {};
  if (effort !== undefined) options.effort = effort;
  if (authEnv) options.env = authEnv;
  return factories.claudeCode(targetModel, Object.keys(options).length > 0 ? options : undefined);
}

/** Map an AFK completion signal back to an iteration outcome. */
export function interpretOutcome(signal: string | undefined): AgentOutcome {
  if (signal === DONE_SIGNAL) return "done";
  if (signal === BLOCKED_SIGNAL) return "blocked";
  return "no-sentinel";
}

/**
 * Resolve an attempt outcome from the two coexisting completion channels (ADR
 * 0082 §2). The structured `AgentOutput` wins when present and valid — a
 * schema-validated `success` is authoritative — and its `success` maps to
 * `done`/`blocked` exactly as the sentinel does. When no valid structured block
 * is present the text sentinel path applies untouched ({@link interpretOutcome}),
 * so every non-adopting runner and every legacy stdout keeps its current
 * behaviour. This is what lets a run that emitted a valid structured block but
 * forgot the `<promise>` sentinel yield a definite outcome instead of
 * `no-sentinel` (the #788 failure class).
 */
export function interpretCompletion(
  structured: AgentOutput | undefined,
  signal: string | undefined,
): AgentOutcome {
  if (structured) return structured.success ? "done" : "blocked";
  return interpretOutcome(signal);
}

/**
 * Enforce the native structured-output contract (ADR 0090, #932) on a
 * schema-enabled runner: a `done` outcome only stands when the agent also
 * emitted a valid red-castle `AgentOutput` block. On a schema-enabled runner
 * (claude first) a missing / malformed / schema-invalid `<agent-output>` DOWNGRADES
 * the `done` to `no-sentinel`, so the agent literally cannot terminate "done"
 * without the schema — routing a forgotten schema through the same recovery the
 * forgotten text sentinel already uses. Pure; the `warn` is emitted by the caller.
 *
 * Coexist: for runners WITHOUT native schema support the outcome passes through
 * unchanged, so the text sentinel remains their sole terminal signal. Only a
 * `done` outcome is gated — `blocked` / `no-sentinel` / exhaustion / timeout are
 * never touched (a schema is required to claim success, not to report a block).
 */
export function enforceStructuredOutput(
  runner: AgentRunner,
  outcome: AgentOutcome,
  stdout: string,
): { outcome: AgentOutcome; rejectedReason?: string } {
  if (outcome !== "done" || !runnerSupportsStructuredOutput(runner)) return { outcome };
  const extracted = extractAgentOutput(stdout);
  if (extracted.ok) return { outcome };
  return {
    outcome: "no-sentinel",
    rejectedReason: extracted.reason + (extracted.detail ? `: ${extracted.detail}` : ""),
  };
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
  // host.onWorktreeReady runs ON THE HOST in the freshly-created worktree BEFORE
  // the inner agent starts (host-visible worktree modes only). Host hooks ride
  // here, in order:
  //   1. No-leak commit-msg guard (#1366) — ALWAYS injected: reject public
  //      output leaks before they enter history.
  //   2. Continuous-push guarantee (issue #191) — injected only when enabled:
  //      push the branch up-front and install the post-commit push hook.
  // sandcastle only runs these for host-visible worktrees (noSandbox / bind-mount
  // worktree mode); for fully-isolated providers the agent works in a synced copy
  // the hooks can't see (final sync only).
  const worktreeReady: HostHookCommand[] = [buildWorktreePathCaptureHook(), buildNoLeakCommitMsgHook()];
  if (input.continuousPush) {
    worktreeReady.push(buildContinuousPushHook(input.branch, input.remote ?? DEFAULT_REMOTE));
  }
  const hooks: RunOptions["hooks"] = { host: { onWorktreeReady: worktreeReady } };
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
        // Capture-time leak masking (issue #1368): every textual stream event
        // (raw line, text/reasoning message, result, tool-call args) passes
        // through the precomputed line redactor BEFORE the event sink and the
        // verbose file sink, so secrets/session links/host identity never
        // reach the firehose, heartbeat vitals, or log tails that envelopes
        // later relay. Defense-in-depth under the outbound scrubOutbound seam.
        redactLine: buildLineRedactor(),
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
    // Re-anchor sandcastle's `.red-castle/` dir + git ops at the caller's cwd
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
    // Structured-output completion adapter (ADR 0090), claude-first rollout
    // (#919/#932). For the claude runner, register the `<agent-output>` closing
    // tag as an ADDITIONAL completion signal so the turn can terminate on the
    // schema-validated structured block ALONE — curing the `no-sentinel` class
    // for it — while the `<promise>` sentinels stay valid (coexistence). Every
    // other runner keeps just the sentinels until its own adoption slice lands.
    completionSignal:
      input.runner === "claude"
        ? [...COMPLETION_SIGNALS, AGENT_OUTPUT_CLOSE]
        : [...COMPLETION_SIGNALS],
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
  /failed to connect to websocket|HTTP error:\s*502 Bad Gateway|HTTP error:\s*503 Service Unavailable|\b529\b|overloaded|wss:\/\/chatgpt\.com\/backend-api\/codex\/responses|thread\/start failed|failed to load configuration|spawn sh ENOENT|cwd does not exist|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET/i;

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
 * Run the inner agent on the issue via sandcastle and normalise the result.
 *
 * sandcastle's `run()` can signal exhaustion two ways: by throwing an error
 * whose message matches the exhaustion patterns (the common case — the provider
 * raises on a 429 / usage-limit), or by completing with exhaustion text on
 * stdout. Both map to the `exhausted` outcome (no commits, no sentinel). A
 * transient transport / server-overload error maps to `runner-transient`; any
 * OTHER thrown error maps to `no-sentinel` (a recoverable crash) rather than
 * propagating — so an unrecognized runner failure never kills the drain or
 * orphans the issue in `running` (#767).
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
  let guard:
    | { stop: () => void; firedTimeout: () => boolean; firedGoalMoot: () => boolean; firedBudget: () => boolean }
    | undefined;
  let timeoutReason: AttemptTimeoutReason | undefined;
  let laneReaper: { stop: () => void; firedReap: () => boolean } | undefined;
  let controller: AbortController | undefined;
  let heartbeatIntervalMs = 60_000;
  let lastHeartbeatEmitMs: number | undefined;
  let vitalsSampler: (() => void) | undefined;
  const emitHeartbeat = (info: AttemptProgressInfo): void => {
    // Single throttle shared by all three heartbeat drivers — the attempt-guard
    // poll (`onTick`), the codex stream pulse, and the independent vitals sampler
    // (ADR 0103). Any two that land within {@link HEARTBEAT_DEDUP_MS} of each
    // other (e.g. the sampler and a guard poll ticking on the same instant) emit
    // ONCE, so an armed guard + the sampler never double-stamp the same window.
    if (lastHeartbeatEmitMs !== undefined && info.nowMs - lastHeartbeatEmitMs < HEARTBEAT_DEDUP_MS) return;
    lastHeartbeatEmitMs = info.nowMs;
    input.onHeartbeat?.(info);
  };
  const pulseCodexHeartbeatFromStream = (event: AgentStreamEvent): void => {
    if (!input.onHeartbeat || input.runner !== "codex" || !input.headProbe) return;
    if (event.type === "raw" || event.type === "sessionId") return;
    const nowMs = now();
    if (lastHeartbeatEmitMs !== undefined && nowMs - lastHeartbeatEmitMs < heartbeatIntervalMs) return;
    void (async () => {
      let head: string | undefined;
      try {
        head = await input.headProbe?.();
      } catch {
        head = undefined;
      }
      emitHeartbeat({ head, lastProgressMs: nowMs, nowMs });
    })();
  };
  const agentEventSink: RunAgentInput["onAgentEvent"] | undefined =
    input.onAgentEvent || input.runner === "codex"
      ? (event) => {
          input.onAgentEvent?.(event);
          pulseCodexHeartbeatFromStream(event);
        }
      : undefined;
  if (input.attemptTimeoutSeconds && input.attemptTimeoutSeconds > 0 && input.headProbe) {
    const capMs = input.attemptTimeoutSeconds * 1000;
    heartbeatIntervalMs = Math.min(capMs, 60_000);
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
      ...(input.budget && input.budgetUsage ? { budget: input.budget, budgetUsage: input.budgetUsage } : {}),
      ...(input.budgetUsage ? { activityUsage: input.budgetUsage } : {}),
      ...(input.inspectTree ? { activeDescendantProbe: () => deriveSnapshot(input.inspectTree!()).activeDescendant } : {}),
      abort: (reason) => {
        if (reason === "stalled" || reason === "edit-loop-stall" || reason === "hard-cap") timeoutReason = reason;
        controller?.abort(
          new Error(
            reason === "goal-moot"
              ? "afk: attempt mooted — the claimed issue is already CLOSED (goal predicate, ADR 0057)"
              : reason === "budget"
                ? "afk: attempt aborted — per-attempt resource budget exceeded (#908)"
                : reason === "hard-cap"
                  ? `afk: attempt aborted — no new commit within ${hardCap}s despite worktree edits (hard cap, stalled)`
                  : reason === "edit-loop-stall"
                    ? `afk: attempt aborted — worktree diff kept changing without new high-water progress within ${cap}s (edit-loop-stall)`
                    : `afk: attempt aborted — no new commit within ${cap}s (stalled)`,
          ),
        );
      },
      // Externalized proof-of-life (PR-B): each poll fires the caller's opaque
      // heartbeat sink (firehose record + state.last_progress_at + on_heartbeat
      // hook). execution.ts stays ignorant of what it does.
      ...(input.onHeartbeat ? { onTick: emitHeartbeat } : {}),
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
    input.livenessVerdictProbe &&
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
      livenessVerdict: input.livenessVerdictProbe,
      inspectTree: input.inspectTree,
      // The lane reaper reasons in epoch SECONDS; the shared clock `now` is ms.
      now: () => Math.floor(now() / 1000),
      schedule,
      abort: () =>
        killController.abort(
          new Error(`afk: attempt reaped — agent lane idle past ${input.laneIdleKillThresholdSeconds}s with no active build/test (stalled)`),
        ),
    });
  }

  // Independent worker-vitals sampler (ADR 0103). Vitals telemetry — loc,
  // tokens, tool/text/reasoning counters — must SURVIVE the attempt model on its
  // OWN cadence, decoupled from the attempt-guard. Before this, the only two
  // paths that fired `emitHeartbeat` (the loc/vitals stamp) were the guard's
  // `onTick` and the codex stream-pulse, and BOTH hang off `headProbe` + guard
  // arming: a codex worker in a single long iteration — especially one blocked
  // WAITING on a test suite, emitting no stream events — never stamped anything,
  // so `loc`/`tokens` sat at a permanent `+0 -0` for the whole run even though
  // the worktree carried a real diff. This timer fires the same stamp every
  // ~20s regardless of runner, guard, or stream activity, so the heartbeat
  // reflects the LIVE worktree. It shares `lastHeartbeatEmitMs` with the other
  // two paths, so an armed guard / active stream never double-stamps within the
  // window. Best-effort head probe: the loc diff is computed from the worktree
  // (uncommitted delta needs no head), so a codex worker with no commits still
  // reports its real churn. Armed whenever a heartbeat sink exists.
  if (input.onHeartbeat) {
    const sampleMs = Math.min(heartbeatIntervalMs, DEFAULT_VITALS_SAMPLE_MS);
    vitalsSampler = schedule(() => {
      const nowMs = now();
      void (async () => {
        let head: string | undefined;
        try {
          head = await input.headProbe?.();
        } catch {
          head = undefined;
        }
        // `emitHeartbeat` owns the dedup window, so the sampler, an armed guard
        // poll, and the stream pulse never double-stamp the same instant.
        emitHeartbeat({ head, lastProgressMs: nowMs, nowMs });
      })();
    }, sampleMs);
  }

  let result: RunResult;
  try {
    const options = buildRunOptions(deps, agentEventSink ? { ...input, onAgentEvent: agentEventSink } : input);
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
    // The budget guard aborted: the attempt breached a resource ceiling (#908)
    // — distinct from a stall (it may have been actively working, just too
    // expensively). Surface the dedicated `budget-exceeded` outcome so
    // process-issue salvages the partial work and parks it for a human rather
    // than blind-retrying a runaway. Checked before firedTimeout (firedTimeout
    // already excludes the budget abort, but order keeps intent explicit).
    if (guard?.firedBudget()) {
      return {
        outcome: "budget-exceeded",
        branch: input.branch,
        commits: [],
        stdout: "afk: attempt aborted — per-attempt resource budget exceeded (#908)",
      };
    }
    // The progress guard aborted: alive but not committing → stalled.
    if (guard?.firedTimeout()) {
      return {
        outcome: "timeout",
        branch: input.branch,
        commits: [],
        timeoutReason: timeoutReason ?? "stalled",
        stdout:
          timeoutReason === "edit-loop-stall"
            ? `afk: attempt aborted — worktree diff kept changing without new high-water progress within ${input.attemptTimeoutSeconds}s (edit-loop-stall)`
            : timeoutReason === "hard-cap"
              ? `afk: attempt aborted — no new commit within ${input.attemptHardCapSeconds}s despite worktree edits (hard cap, stalled)`
              : `afk: attempt aborted — no new commit within ${input.attemptTimeoutSeconds}s (stalled)`,
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
    // External-signal kill (#1308): the Orchestrator sets the message to
    // "${provider.name} exited with code N" when the inner process exits
    // non-zero. When N is in the 128–192 range (Unix convention: 128 +
    // signal_number), the process was killed by an OS signal — record the
    // signal name so the terminal record is actionable, distinct from a plain
    // crash. Same bounded recovery policy as `no-sentinel` (`crashed` cap).
    const signalKill = extractSignalKill(error);
    if (signalKill) {
      return {
        outcome: "signal-killed",
        branch: input.branch,
        commits: [],
        stdout: `afk: inner agent killed by ${signalKill.signal} (exit code ${signalKill.exitCode})`,
      };
    }
    // Any OTHER thrown runner error (an error class we don't yet recognize):
    // do NOT rethrow. A rethrow propagates uncaught past the per-issue loop,
    // kills the whole orchestrator mid-drain, and leaves the claimed issue
    // orphaned in `running` (the failure mode behind #766's 529 incident). Map
    // it to `no-sentinel` instead — the same outcome a crashed agent produces —
    // so the per-issue loop runs its graceful recovery: it posts a crash
    // envelope carrying this error text, rotates the label off `running`, and
    // pages `ready-for-human` (bounded by RED_AFK_RETRY_CRASH). The drain
    // survives every runner error class, known or not. (#767)
    return {
      outcome: "no-sentinel",
      branch: input.branch,
      commits: [],
      stdout: error instanceof Error ? error.message : String(error),
    };
  } finally {
    guard?.stop();
    laneReaper?.stop();
    vitalsSampler?.();
  }
  // A run that completed but surfaced exhaustion text on stdout (rather than
  // throwing) is also exhaustion — match the stdout the same way run_inner does.
  if (result.completionSignal === undefined && isRunnerExhausted(result.stdout ?? "")) {
    return { outcome: "exhausted", branch: result.branch, commits: result.commits, stdout: result.stdout };
  }
  // Structured-output completion adapter (ADR 0090): prefer a valid AgentOutput
  // block over the text sentinel. A run that emitted the structured block but no
  // sentinel now yields a definite `done`/`blocked` instead of `no-sentinel`.
  const agentOutput = parseAgentOutput(result.stdout ?? "");
  const rawOutcome = interpretCompletion(agentOutput, result.completionSignal);
  // Enforce the structured-output gate for schema-capable runners (ADR 0082,
  // #932): a claude DONE with no valid <agent-output> block is downgraded to
  // no-sentinel so the agent cannot claim success without the schema contract.
  const enforced = enforceStructuredOutput(input.runner, rawOutcome, result.stdout ?? "");
  if (enforced.rejectedReason) {
    warn(`[afk] warn: AgentOutput ${enforced.rejectedReason} — downgraded to ${enforced.outcome}`);
  }
  return {
    outcome: enforced.outcome,
    branch: result.branch,
    commits: result.commits,
    completionSignal: result.completionSignal,
    ...(agentOutput ? { agentOutput } : {}),
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
    // Host-env minimization (issue #1368): the agent process inherits only the
    // allowlisted host env (shell basics, ssh/git/gh, agent auth, RED_*, the
    // language toolchains) — never the full process.env with unrelated host
    // secrets. RED_AFK_HOST_ENV_ALLOW extends the list; the literal `*`
    // disables minimization (pre-#1368 behavior). Per-attempt env delivered by
    // mutating process.env (the FIX J lane) stays visible because those keys
    // (CARGO*, RED_*) are allowlisted.
    const hostEnvAllowlist = resolveHostEnvAllowlist(process.env);
    return noSandboxMod.noSandbox(hostEnvAllowlist ? { hostEnvAllowlist } : undefined);
  };
  return { run: core.run as SandcastleDeps["run"], agentFor, sandboxFor, warn };
}
