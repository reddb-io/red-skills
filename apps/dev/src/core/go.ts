// go — the `/go` dispatch planner (ADR 0081, PRD #928 / issue #938 / S4).
//
// `/go` is the semi-structured front door between `/goal` and `/afk`. It mints a
// DISPOSABLE tracking issue in an ISOLATED LANE (`lane:go`, out of
// `ready-for-agent` so the running fleet can never claim it), spins a DEDICATED
// castle worker of kind `go`, and reuses the ENTIRE AFK engine end-to-end with
// `origin=go`, `--kind go`, and the INTERACTIVE
// (pause/ask) gate sink. The disposable issue auto-closes on merge because the
// engine's PR body already carries `Closes #N` (core/merge.ts).
//
// IO-free: every effect (label, issue create, engine run) is injected, so the
// dispatch DECISIONS — lane label, disposable body, namespaced root, engine
// argv, gate context — are pure and unit-testable with zero gh or subprocess.

import { LABEL_GO_LANE, tagLabel } from "./triage-labels.js";

export { LABEL_GO_LANE };

/** Spawn-time provenance stamped on a `/go` worker (`AfkStateSchema.origin`),
 * so the monitor/statusline render its per-source count distinctly from
 * `/afk` (issue #930). */
export const GO_ORIGIN = "go";

/** Castle worker kind for `/go`, recorded in the castle worker `state.toon`. */
export const GO_KIND = "go";

/** `/go` runs with a human present → the interactive (pause/ask) gate sink,
 * never the headless park-to-`ready-for-human` sink `/afk` uses. */
export const GO_GATE_CONTEXT = "interactive" as const;

/**
 * `/go` dispatch modes (issue #923, from firstmate). Each mode selects HOW the
 * reused engine finishes the run:
 *
 * - `no-mistakes` — route the run through the HARDENED pre-PR pipeline (#920 /
 *   the retired `/ship` slice): review → validate → escalate intent findings before the
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
 *   pipeline (core/pre-pr-pipeline.ts + the pre-PR ship gate).
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

// ---------- the generator-then-diff verify tail (#2711) ----------
//
// A `/go` `--verify` chain routinely ends `… && pnpm pi:manifests && git diff
// --exit-code`, meaning "regenerating the repo's generated mirrors must leave
// the tree clean". The INTENT is right and worth keeping — a mirror that only
// exists in the generator's head is exactly the drift that reddens the next
// branch to touch it. The TAIL, however, is half-blind: `git diff` reads tracked
// files only, so a generator that writes a NEW mirror file leaves an untracked
// path the check never sees, and the dispatch goes green over uncommitted
// generated output.
//
// So the tail is REPLACED rather than merely justified: staging intents first
// (`git add -A --intent-to-add .`) makes untracked paths visible to `git diff`
// without staging any content, and the `--exit-code` verdict is unchanged. A
// generator that legitimately produces output the run has not committed still
// FAILS — that is the point, and a test pins it — but now it fails for new files
// too, instead of passing for them.

/** The replacement tail: same verdict, now including files the run never
 * tracked. `--intent-to-add` records paths, never content, so nothing is
 * staged for commit and the working tree is untouched. */
export const VERIFY_CLEAN_TREE_TAIL = "git add -A --intent-to-add . && git diff --exit-code";

/** A TRAILING bare `git diff --exit-code` — no pathspec, no extra flags. A
 * path-scoped or mid-chain diff is the author's deliberate narrower check and
 * is left exactly as written. */
const BARE_DIFF_TAIL = /(^|&&\s*)git\s+diff\s+--exit-code\s*$/;

/**
 * Rewrite a trailing bare `git diff --exit-code` into {@link VERIFY_CLEAN_TREE_TAIL}.
 * Idempotent (the replacement's own tail is preceded by the intent-to-add, so a
 * second pass is a no-op) and total: any other command is returned verbatim.
 */
export function normalizeGoVerifyCommand(command: string): string {
  const text = command.trim();
  if (text === "" || text.includes("--intent-to-add")) return command;
  if (!BARE_DIFF_TAIL.test(text)) return command;
  return text.replace(BARE_DIFF_TAIL, (_m, lead: string) => `${lead}${VERIFY_CLEAN_TREE_TAIL}`);
}

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
  /** Optional per-dispatch steering block forwarded to the inner agent prompt. */
  request?: string;
  /** True when the repo already has a configured harness/backpressure gate. */
  hasHarness?: boolean;
  /** Territory tags stamped on the minted issue as `tag:<value>` labels (bare
   * values). Missing labels are auto-created before the mint. */
  tags?: string[];
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
  const verifyCommand = normalizeGoVerifyCommand(dodSpec.verifyCommand ?? "").trim();
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
  const tagLabels = (dodSpec.tags ?? []).map(tagLabel);
  return { title, body, labels: [LABEL_GO_LANE, ...tagLabels] };
}

/**
 * Build the run-engine argv that reuses the FULL AFK engine for exactly ONE
 * minted disposable issue: single-issue (`--issues N`), single-shot (`--once`),
 * `origin=go`, `kind=go`, and listing the isolated `lane:go` pool (`--lane`)
 * instead of `ready-for-agent`. The dispatch `mode` (default `direct-PR`) appends its
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
  request?: string;
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
    "--kind",
    GO_KIND,
    "--lane",
    LABEL_GO_LANE,
  ];
  // The default `direct-PR` mode is the standard path and appends nothing, so an
  // unmoded /go produces exactly the base argv.
  const modeFlag = GO_MODE_ENGINE_FLAG[opts.mode ?? DEFAULT_GO_MODE];
  if (modeFlag) args.push(modeFlag);
  if (opts.yolo) args.push(GO_YOLO_FLAG);
  const verifyCommand = normalizeGoVerifyCommand(opts.verifyCommand ?? "").trim();
  if (verifyCommand) args.push(GO_VERIFY_FLAG, verifyCommand);
  const request = opts.request?.trim();
  if (request) args.push("--request", request);
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
  /** Close the just-minted disposable Ticket when Worker admission fails before
   * any Worker exists to own cleanup. Production dispatchers always provide it;
   * optionality preserves pure planner callers that cannot fail admission. */
  disposeIssue?: (issue: number) => Promise<void>;
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
  // Every label the mint stamps must exist first — the lane label AND any
  // territory `tag:<v>` labels (auto-created on first use, D4).
  for (const label of spec.labels) {
    await deps.ensureLabel(label);
  }
  const issue = await deps.createIssue(spec);
  let engineExit: number;
  try {
    engineExit = await deps.runEngine(
      buildGoEngineArgs({
        issue,
        runner: opts.runner,
        mode: opts.mode,
        yolo: opts.yolo,
        verifyCommand: opts.verifyCommand,
        request: opts.request,
        hasHarness: opts.hasHarness,
      }),
    );
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

// ---------- zero-attempt dispatch verdict (#2385) ----------
//
// A targeted dispatch (`--issues N` — every `/go`, and a hand-aimed `/afk`)
// exists to make ONE issue progress. When that issue is claimed and immediately
// released, or never selected at all, the engine used to still exit 0 and the
// progress line still read `1/1 (100%)` — a false success over zero work, which
// is exactly how three broken `/go` runs read as clean. A run that attempted
// nothing is a FAILURE and must say so in its exit code.

/** Outcomes that mean the worker never attempted the issue — it withdrew before
 * (or instead of) doing any work. */
export const NO_ATTEMPT_OUTCOMES: readonly string[] = ["claim-lost", "hook-aborted"];

/**
 * Decide whether a targeted dispatch ran ZERO attempts (pure). Returns the
 * operator-facing reason when the run must exit non-zero, or null when at least
 * one issue was genuinely attempted.
 *
 * `targeted` is false for an open-ended `/afk` drain, where picking up nothing
 * (an empty queue, an issue another fleet worker won) is normal and stays exit 0.
 */
export function zeroAttemptDispatchFailure(
  targeted: boolean,
  processed: readonly { issue: number; outcome: string; reason?: string }[],
): string | null {
  if (!targeted) return null;
  if (processed.length === 0) return "no targeted issue was selected or processed";
  const attempted = processed.filter((p) => !NO_ATTEMPT_OUTCOMES.includes(p.outcome));
  if (attempted.length > 0) return null;
  // The outcome NAMES the withdrawal; the reason explains it (#3156). A verdict
  // that printed only `claim-lost` sent an operator to the claim arbitration for
  // an answer the withdrawal already held — and to a log the sweep had deleted.
  return `no attempt ran (${processed
    .map((p) => `#${p.issue}: ${p.outcome}${p.reason ? ` — ${p.reason}` : ""}`)
    .join(", ")})`;
}
