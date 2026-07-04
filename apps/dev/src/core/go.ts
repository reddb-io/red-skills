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

/**
 * `/go` dispatch modes (issue #923, from firstmate). Each mode selects HOW the
 * reused engine finishes the run:
 *
 * - `no-mistakes` — route the run through the HARDENED pre-PR pipeline (#920 /
 *   the `/ship` slice): review → validate → escalate intent findings before the
 *   PR is opened. Slowest, safest.
 * - `direct-PR` — the STANDARD path: run the gate and bring back a PR. Default.
 * - `local-only` — an APPROVED local fast-forward merge with NO PR opened; for
 *   trusted local-only demands the maintainer wants landed without a review PR.
 */
export type GoMode = "no-mistakes" | "direct-PR" | "local-only";

/** Every valid `--mode` value, in dispatch order (safest → most direct). */
export const GO_MODES: readonly GoMode[] = ["no-mistakes", "direct-PR", "local-only"];

/** `/go` defaults to the STANDARD `direct-PR` path when `--mode` is omitted. */
export const DEFAULT_GO_MODE: GoMode = "direct-PR";

/**
 * The engine flag each non-default mode appends to the reused-engine argv. The
 * default `direct-PR` mode is the STANDARD path and appends nothing, so an
 * unmoded `/go` produces exactly the base argv.
 *
 * - `no-mistakes` → `--pre-pr` routes the run through the hardened pre-PR
 *   pipeline (core/pre-pr-pipeline.ts + the `/ship` gate).
 * - `local-only` → `--local-merge` lands the branch by an approved local
 *   fast-forward instead of opening a PR.
 */
export const GO_MODE_ENGINE_FLAG: Record<GoMode, string | null> = {
  "no-mistakes": "--pre-pr",
  "direct-PR": null,
  "local-only": "--local-merge",
};

/** The engine flag the opt-in `+yolo` autonomy bump appends. */
export const GO_YOLO_FLAG = "--yolo";

/** One-shot inline verification command used only when a `/go` confirmation
 * approved an ephemeral machine gate for a repo with no configured harness. */
export const GO_VERIFY_FLAG = "--verify";

/** Bounded post-DONE machine-gate retry cap for `/go` dispatches. */
export const DEFAULT_GO_VERIFY_RETRIES = 2;

/** Tight cap for check-less `/go` dispatches when the maintainer declined an
 * ephemeral inline check in a repo with no configured harness/backpressure. */
export const GO_NO_HARNESS_ITER_CAP = 3;

/**
 * Resolve a raw `--mode` value to a canonical {@link GoMode}, case-insensitively
 * (so `Direct-PR` and `NO-MISTAKES` both parse). Throws on any unknown value so
 * a typo'd mode is a loud error, never a silent fall-through to the default.
 */
export function parseGoMode(raw: string): GoMode {
  const needle = raw.trim().toLowerCase();
  const match = GO_MODES.find((m) => m.toLowerCase() === needle);
  if (!match) {
    throw new Error(`invalid --mode "${raw}": expected one of ${GO_MODES.join(", ")}`);
  }
  return match;
}

/** The minted disposable tracking issue for one `/go` demand. */
export interface DisposableIssueSpec {
  title: string;
  body: string;
  labels: string[];
}

export interface GoDodSpec {
  /** The maintainer-approved high-detail rewrite of the demand. */
  task?: string;
  /** The maintainer-approved semantic Definition of Done. */
  dod?: string;
  /** Optional one-shot machine gate appended to backpressure for this dispatch. */
  verifyCommand?: string;
  /** True when the repo already has a configured harness/backpressure gate. */
  hasHarness?: boolean;
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
export function buildDisposableIssue(demand: string, dodSpec: GoDodSpec = {}): DisposableIssueSpec {
  const text = demand.trim();
  if (!text) throw new Error("/go requires a non-empty demand");
  const title = `/go: ${firstLine(text).slice(0, 72) || "dispatch"}`;
  const task = (dodSpec.task ?? text).trim();
  const dod = dodSpec.dod?.trim();
  const verifyCommand = dodSpec.verifyCommand?.trim();
  const machineGate =
    verifyCommand && verifyCommand.length > 0
      ? `Ephemeral inline check for this dispatch: \`${verifyCommand}\`.`
      : dodSpec.hasHarness === false
        ? "No configured harness/backpressure was approved for this dispatch; run best-effort under the tightened iteration cap."
        : "Configured `afk.backpressure` plus the auto-derived feedback gate (`test`/`typecheck`/`lint`/`build`).";
  const body = [
    dod ? "## Task" : "## Demand",
    "",
    dod ? task : text,
    ...(dod
      ? [
          "",
          "## Acceptance Criteria",
          "",
          dod,
          "",
          "## Machine Gate",
          "",
          machineGate,
        ]
      : []),
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
 * `ready-for-agent`. The dispatch `mode` (default `direct-PR`) appends its
 * routing flag and the opt-in `yolo` autonomy bump appends `--yolo`. An optional
 * runner pins the backend. Throws on a non-positive issue so a failed mint can
 * never spawn a worker at issue 0.
 */
export function buildGoEngineArgs(opts: {
  issue: number;
  runner?: string;
  mode?: GoMode;
  yolo?: boolean;
  verifyCommand?: string;
  hasHarness?: boolean;
  verifyRetries?: number;
}): string[] {
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
  // The default `direct-PR` mode is the standard path and appends nothing, so an
  // unmoded /go produces exactly the base argv.
  const modeFlag = GO_MODE_ENGINE_FLAG[opts.mode ?? DEFAULT_GO_MODE];
  if (modeFlag) args.push(modeFlag);
  if (opts.yolo) args.push(GO_YOLO_FLAG);
  const verifyCommand = opts.verifyCommand?.trim();
  if (verifyCommand) args.push(GO_VERIFY_FLAG, verifyCommand);
  if (opts.hasHarness === false && !verifyCommand) args.push("-n", String(GO_NO_HARNESS_ITER_CAP));
  if (opts.verifyRetries !== undefined) args.push("--go-verify-retries", String(opts.verifyRetries));
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
  opts: { runner?: string; mode?: GoMode; yolo?: boolean } & GoDodSpec = {},
): Promise<GoDispatchResult> {
  const spec = buildDisposableIssue(demand, opts);
  await deps.ensureLabel(LABEL_GO_LANE);
  const issue = await deps.createIssue(spec);
  const engineExit = await deps.runEngine(
    buildGoEngineArgs({
      issue,
      runner: opts.runner,
      mode: opts.mode,
      yolo: opts.yolo,
      verifyCommand: opts.verifyCommand,
      hasHarness: opts.hasHarness,
    }),
  );
  return { issue, engineExit };
}
