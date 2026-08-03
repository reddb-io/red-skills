// scout — the `/go --scout` dispatch planner (issue #922, PRD #928).
//
// `--scout` is a READ-ONLY investigation lane of `/go`: it mints a DISPOSABLE
// tracking issue in the isolated `lane:scout` lane (never `ready-for-agent` or
// `lane:go`), spins a castle worker stamped with `current.kind=scout`, and
// reuses the FULL AFK engine with `origin=scout`, `run_mode=scout`, and
// `continuousPush=false`.
//
// The `run_mode=scout` flag is the enforcement point in `process-issue.ts`:
// after the agent emits DONE, the engine skips push / feedback / landing
// entirely and posts the agent's report as a GitHub comment, then closes the
// disposable issue. No branch is ever pushed to the remote; no PR is created;
// nothing lands on main. Guaranteed by code, not by convention.
//
// IO-free: every effect (label, issue create, engine run) is injected, so the
// dispatch DECISIONS — lane label, disposable body, worker kind, engine
// argv — are pure and unit-testable with zero gh or subprocess.

import { LABEL_SCOUT_LANE } from "./triage-labels.js";

export { LABEL_SCOUT_LANE };

/** Spawn-time provenance stamped on a scout worker (`AfkStateSchema.origin`),
 * so the monitor/statusline render its per-source count distinctly from
 * `/afk` and `/go` (issue #930). */
export const SCOUT_ORIGIN = "scout";

/** Legacy worker/worktree root segment for scout runs. Current castle workers
 * stamp `current.kind=scout`; this segment remains for compatibility with older
 * readers and env-based dispatch probes. */
export const SCOUT_WORKERS_SEGMENT = "scout-workers";

/** The `run_mode` value that tells `process-issue` to skip all mutations
 * (push / feedback gate / PR / landing) and instead post a report comment. */
export const SCOUT_RUN_MODE = "scout";

/** The minted disposable tracking issue for one scout investigation. */
export interface ScoutIssueSpec {
  title: string;
  body: string;
  labels: string[];
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return (nl === -1 ? s : s.slice(0, nl)).trim();
}

/**
 * Build the disposable tracking issue for a scout demand. The ONLY routing
 * label is the isolated `lane:scout` lane — NEVER `ready-for-agent` — so the
 * running fleet and the `/go` worker can never surface it. The body includes a
 * read-only mandate so the agent never commits. Throws on an empty question.
 */
export function buildScoutIssueSpec(question: string): ScoutIssueSpec {
  const text = question.trim();
  if (!text) throw new Error("--scout requires a non-empty question");
  const title = `/scout: ${firstLine(text).slice(0, 70) || "investigate"}`;
  const body = [
    "## Question",
    "",
    text,
    "",
    "---",
    "",
    "🔍 Disposable `/go --scout` investigation issue — minted in the isolated",
    "`lane:scout` lane. The scout worker runs in **read-only mode**: it must",
    "NOT commit, push, or modify any files. The agent reads the codebase and",
    "produces a markdown report as its final output before emitting DONE.",
    "The orchestrator posts that report as a comment, then closes this issue.",
    "Nothing lands on main.",
  ].join("\n");
  return { title, body, labels: [LABEL_SCOUT_LANE] };
}

/** Legacy `/scout` worker/worktree root helper retained for compatibility. */
export function scoutWorkersRoot(tmpDir: string): string {
  return `${tmpDir.replace(/\/+$/, "")}/${SCOUT_WORKERS_SEGMENT}`;
}

/**
 * Build the run-engine argv that reuses the FULL AFK engine for exactly ONE
 * minted scout issue: single-issue (`--issues N`), single-shot (`--once`),
 * `origin=scout`, the isolated `lane:scout` pool (`--lane`), and
 * `run_mode=scout` (the enforcement point that disables all mutations).
 * An optional runner pins the backend. Throws on a non-positive issue.
 */
export function buildScoutEngineArgs(opts: { issue: number; runner?: string }): string[] {
  if (!Number.isInteger(opts.issue) || opts.issue <= 0) {
    throw new Error(`buildScoutEngineArgs: invalid issue ${opts.issue}`);
  }
  const args = [
    "--once",
    "--issues",
    String(opts.issue),
    "--origin",
    SCOUT_ORIGIN,
    "--lane",
    LABEL_SCOUT_LANE,
    "--run-mode",
    SCOUT_RUN_MODE,
  ];
  if (opts.runner) args.push("--runner", opts.runner);
  return args;
}

/** Effects the scout dispatch injects. Faked in tests. */
export interface ScoutDispatchDeps {
  /** Idempotently ensure the isolated lane label exists before minting into it. */
  ensureLabel: (name: string) => Promise<void>;
  /** Mint the disposable issue; resolves its new number. */
  createIssue: (spec: ScoutIssueSpec) => Promise<number>;
  /** Run the reused AFK engine with the built argv; resolves the exit code. */
  runEngine: (args: string[]) => Promise<number>;
  /** Close the minted disposable Ticket if admission fails before Worker birth. */
  disposeIssue?: (issue: number) => Promise<void>;
}

/** What one scout dispatch produced. */
export interface ScoutDispatchResult {
  issue: number;
  engineExit: number;
}

/**
 * Orchestrate one scout dispatch: ensure the isolated `lane:scout` label
 * exists, mint the disposable issue in it (never `ready-for-agent`), then
 * reuse the AFK engine to process exactly that issue with `origin=scout` and
 * `run_mode=scout`. PURE SEQUENCING — all IO is injected. The namespaced
 * worker root is wired by the caller around `runEngine`.
 */
export async function dispatchScout(
  deps: ScoutDispatchDeps,
  question: string,
  opts: { runner?: string } = {},
): Promise<ScoutDispatchResult> {
  const spec = buildScoutIssueSpec(question);
  await deps.ensureLabel(LABEL_SCOUT_LANE);
  const issue = await deps.createIssue(spec);
  let engineExit: number;
  try {
    engineExit = await deps.runEngine(buildScoutEngineArgs({ issue, runner: opts.runner }));
  } catch (error) {
    try {
      await deps.disposeIssue?.(issue);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Worker admission failed and disposable issue #${issue} could not be closed`,
      );
    }
    throw error;
  }
  return { issue, engineExit };
}
