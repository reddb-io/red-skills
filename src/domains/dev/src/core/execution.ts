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
  idleTimeoutSeconds?: number;
}

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
  return {
    agent: deps.agentFor(input.runner, input.model, { effort: input.effort }),
    sandbox: deps.sandboxFor(input.sandboxMode ?? "none"),
    promptFile: input.handoffPath,
    branchStrategy,
    completionSignal: [...COMPLETION_SIGNALS],
    idleTimeoutSeconds: input.idleTimeoutSeconds ?? DEFAULT_IDLE_TIMEOUT_S,
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
