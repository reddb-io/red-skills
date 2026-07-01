// go — the `/go` dispatch planner (ADR 0081, PRD #928 / issue #938 / S4).
//
// `/go` is the semi-structured front door between `/goal` and `/afk`. It mints a
// DISPOSABLE tracking issue in an ISOLATED LANE (`lane:go`, out of
// `ready-for-agent` so the running fleet can never claim it), spins a DEDICATED
// namespaced worker (`go-workers/`, separate from `/afk`'s `workers/`), and
// reuses the ENTIRE AFK engine end-to-end with `origin=go` and the INTERACTIVE
// (pause/ask) gate sink. The disposable issue auto-closes on merge because the
// engine's PR body already carries `Closes #N` (core/merge.ts).
//
// IO-free: every effect (label, issue create, engine run) is injected, so the
// dispatch DECISIONS — lane label, disposable body, namespaced root, engine
// argv, gate context — are pure and unit-testable with zero gh or subprocess.

import { LABEL_GO_LANE } from "./triage-labels.js";

export { LABEL_GO_LANE };

/** Spawn-time provenance stamped on a `/go` worker (`AfkStateSchema.origin`),
 * so the monitor/statusline render its per-source count distinctly from
 * `/afk` (issue #930). */
export const GO_ORIGIN = "go";

/** The worker/worktree root segment for `/go`, kept separate from `/afk`'s
 * `workers/` so the two never collide under `.red/tmp`. Honoured by
 * `worker-paths.workersSegment()` via `RED_AFK_WORKERS_NAMESPACE`. */
export const GO_WORKERS_SEGMENT = "go-workers";

/** `/go` runs with a human present → the interactive (pause/ask) gate sink,
 * never the headless park-to-`ready-for-human` sink `/afk` uses. */
export const GO_GATE_CONTEXT = "interactive" as const;

/** The minted disposable tracking issue for one `/go` demand. */
export interface DisposableIssueSpec {
  title: string;
  body: string;
  labels: string[];
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return (nl === -1 ? s : s.slice(0, nl)).trim();
}

/**
 * Build the disposable tracking issue for a demand. The ONLY routing label is
 * the isolated `lane:go` lane — NEVER `ready-for-agent` — so the running
 * fleet's candidate listing (which lists `ready-for-agent`) can never surface
 * it. Throws on an empty demand so `/go` never mints a contentless issue.
 */
export function buildDisposableIssue(demand: string): DisposableIssueSpec {
  const text = demand.trim();
  if (!text) throw new Error("/go requires a non-empty demand");
  const title = `/go: ${firstLine(text).slice(0, 72) || "dispatch"}`;
  const body = [
    "## Demand",
    "",
    text,
    "",
    "---",
    "",
    "🤖 Disposable `/go` dispatch issue — minted in the isolated `lane:go` lane,",
    "out of `ready-for-agent` so the running fleet cannot claim it. The dedicated",
    "`/go` worker processes it directly and the issue auto-closes when its PR merges.",
  ].join("\n");
  return { title, body, labels: [LABEL_GO_LANE] };
}

/** The `/go` worker/worktree root: `<tmpDir>/go-workers`, separate from
 * `/afk`'s `<tmpDir>/workers`. */
export function goWorkersRoot(tmpDir: string): string {
  return `${tmpDir.replace(/\/+$/, "")}/${GO_WORKERS_SEGMENT}`;
}

/**
 * Build the run-engine argv that reuses the FULL AFK engine for exactly ONE
 * minted disposable issue: single-issue (`--issues N`), single-shot (`--once`),
 * `origin=go`, and listing the isolated `lane:go` pool (`--lane`) instead of
 * `ready-for-agent`. An optional runner pins the backend. Throws on a
 * non-positive issue so a failed mint can never spawn a worker at issue 0.
 */
export function buildGoEngineArgs(opts: { issue: number; runner?: string }): string[] {
  if (!Number.isInteger(opts.issue) || opts.issue <= 0) {
    throw new Error(`buildGoEngineArgs: invalid issue ${opts.issue}`);
  }
  const args = [
    "--once",
    "--issues",
    String(opts.issue),
    "--origin",
    GO_ORIGIN,
    "--lane",
    LABEL_GO_LANE,
  ];
  if (opts.runner) args.push("--runner", opts.runner);
  return args;
}

/** Effects the `/go` dispatch injects. Faked in tests. */
export interface GoDispatchDeps {
  /** Idempotently ensure the isolated lane label exists before minting into it. */
  ensureLabel: (name: string) => Promise<void>;
  /** Mint the disposable issue; resolves its new number. */
  createIssue: (spec: DisposableIssueSpec) => Promise<number>;
  /** Run the reused AFK engine with the built argv; resolves the exit code. */
  runEngine: (args: string[]) => Promise<number>;
}

/** What one `/go` dispatch produced. */
export interface GoDispatchResult {
  issue: number;
  engineExit: number;
}

/**
 * Orchestrate one `/go` dispatch: ensure the isolated `lane:go` label exists,
 * mint the disposable issue in it (never `ready-for-agent`), then reuse the AFK
 * engine to process exactly that issue with `origin=go`. PURE SEQUENCING — all
 * IO is injected; the namespaced worker root + interactive gate sink are wired
 * by the caller around `runEngine`.
 */
export async function dispatchGo(
  deps: GoDispatchDeps,
  demand: string,
  opts: { runner?: string } = {},
): Promise<GoDispatchResult> {
  const spec = buildDisposableIssue(demand);
  await deps.ensureLabel(LABEL_GO_LANE);
  const issue = await deps.createIssue(spec);
  const engineExit = await deps.runEngine(buildGoEngineArgs({ issue, runner: opts.runner }));
  return { issue, engineExit };
}
