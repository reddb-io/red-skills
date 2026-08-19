// worker-budget — per-worker resource budgets and the NAMED termination they
// produce.
//
// Three rules shape every line below:
//
//  1. A BUDGETED TERMINATION NAMES ITS BUDGET. The hand-forward comment carries
//     the budget that fired, so "why did this worker end?" is answered by what
//     the termination said instead of by inference. It is distinct from a stall
//     (silence) and from a clean finish.
//  2. AN UNSET BUDGET IS UNLIMITED, NEVER ZERO. A missing / empty / non-numeric
//     / non-positive value resolves to *absent*, so a typo can never turn a
//     budget into an instant killer — the same failure mode the wall-clock
//     ceiling floors away in supervisor/config.ts.
//  3. A BUDGETED TERMINATION HANDS ITS WORK FORWARD. The cut-off is policy, not
//     a hang: whatever the worker committed is the next worker's starting
//     point, so the plan names the branch to resume from and the PR the issue is
//     pending on (the same contract #2701 gave the wall-clock cap).
//
// The budget is keyed to the WORKER, which is the unit that survived ADR 0130's
// extinction of the Attempt — a Worker already IS one Worker × one Ticket × one
// try, so there is no smaller thing left to charge. The `afk.attempt.budget.*`
// config keys and the `RED_AFK_ATTEMPT_*` env overrides keep their published
// spelling: renaming an operator-facing key is a separate breaking change.
//
// PURE (no IO, no clock, no env read at module scope): the supervisor samples
// the usage and executes the plan; this module only decides.

import { planCapHandoff, type CapHandoff, type CapHandoffInput } from "./wall-clock-cap.js";

/**
 * The budget vocabulary. One name per measurable signal, used by the resolver,
 * the evaluator and the hand-forward alike, so a reader never has to map one
 * spelling onto another.
 */
export type WorkerBudgetName = "wall_clock_s" | "peak_rss_mb" | "cost_usd";

/** Stable evaluation order: time, then memory, then money. */
export const WORKER_BUDGET_NAMES = [
  "wall_clock_s",
  "peak_rss_mb",
  "cost_usd",
] as const satisfies readonly WorkerBudgetName[];

/** The documented default for an unlimited budget — an explicit word, never an
 * empty string (every config key must resolve to a non-empty default) and never
 * `0` (which would read as "terminate immediately"). */
export const WORKER_BUDGET_UNLIMITED = "unlimited";

/**
 * Where each budget is configured, under `plugins.dev.afk.*` (folded to bare
 * `afk.*` by ADR 0042). `wall_clock_s` deliberately reuses the EXISTING
 * per-issue ceiling rather than minting a second wall-clock knob: two ceilings
 * disagreeing is the bug class ADR 0128 forbids.
 */
export const WORKER_BUDGET_CONFIG_KEYS = {
  wall_clock_s: "afk.issue_wall_clock_max_s",
  peak_rss_mb: "afk.attempt.budget.peak_rss_mb",
  cost_usd: "afk.attempt.budget.cost_usd",
} as const satisfies Record<WorkerBudgetName, string>;

/** Env overrides, mirroring the `RED_AFK_*` ladder the supervisor config uses. */
export const WORKER_BUDGET_ENV_KEYS = {
  wall_clock_s: "RED_AFK_ISSUE_WALL_CLOCK_MAX_S",
  peak_rss_mb: "RED_AFK_ATTEMPT_PEAK_RSS_MB",
  cost_usd: "RED_AFK_ATTEMPT_COST_USD",
} as const satisfies Record<WorkerBudgetName, string>;

/** Resolved ceilings. An ABSENT key is unlimited — never 0. */
export type WorkerBudgets = { readonly [K in WorkerBudgetName]?: number };

/** What one worker actually consumed, as sampled by the supervisor. */
export interface WorkerUsage {
  /** Wall clock the worker held its ticket, in seconds. */
  wallClockS?: number;
  /** Highest resident-set size observed across the worker's process tree, MB. */
  peakRssMb?: number;
  /** Reported spend for the worker, USD. */
  costUsd?: number;
}

export interface WorkerBudgetBreach {
  budget: WorkerBudgetName;
  /** The configured ceiling. */
  limit: number;
  /** What was observed when it fired. */
  observed: number;
}

function positive(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === WORKER_BUDGET_UNLIMITED) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

export interface WorkerBudgetSource {
  /** Env view for the `RED_AFK_*` overrides. */
  env?: Record<string, string | undefined>;
  /** `.red/config.yaml` reader for the `afk.*` keys. */
  getCfg?: (key: string) => string | undefined;
  /**
   * The per-issue wall-clock ceiling the supervisor already resolved. Passed in
   * so the budget table reports the ceiling that is actually enforced, rather
   * than re-deriving it from a second ladder.
   */
  wallClockS?: number;
}

/**
 * Resolve the budget table. Precedence per budget: env override, then config
 * key, then (for the wall clock only) the ceiling the supervisor resolved.
 * Anything that is not a positive finite number resolves to UNLIMITED.
 */
export function resolveWorkerBudgets(source: WorkerBudgetSource = {}): WorkerBudgets {
  const env = source.env ?? {};
  const getCfg = source.getCfg ?? ((): undefined => undefined);
  const budgets: { -readonly [K in WorkerBudgetName]?: number } = {};
  for (const name of WORKER_BUDGET_NAMES) {
    const resolved =
      positive(env[WORKER_BUDGET_ENV_KEYS[name]]) ??
      positive(getCfg(WORKER_BUDGET_CONFIG_KEYS[name])) ??
      (name === "wall_clock_s" ? positive(String(source.wallClockS ?? "")) : undefined);
    if (resolved !== undefined) budgets[name] = resolved;
  }
  return budgets;
}

/** The observation for one budget, or undefined when it was never sampled. */
function observationFor(usage: WorkerUsage, name: WorkerBudgetName): number | undefined {
  const raw =
    name === "wall_clock_s"
      ? usage.wallClockS
      : name === "peak_rss_mb"
        ? usage.peakRssMb
        : usage.costUsd;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * The first budget this usage reaches, in {@link WORKER_BUDGET_NAMES} order, or
 * null when every budget is unlimited or still unspent. A budget is EXCEEDED
 * when the observation REACHES it — a 4096 MB ceiling fires at 4096 MB.
 */
export function evaluateWorkerBudgets(
  usage: WorkerUsage,
  budgets: WorkerBudgets,
): WorkerBudgetBreach | null {
  for (const budget of WORKER_BUDGET_NAMES) {
    const limit = budgets[budget];
    if (limit === undefined) continue;
    const observed = observationFor(usage, budget);
    if (observed === undefined || observed < limit) continue;
    return { budget, limit, observed };
  }
  return null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Unit each budget is measured in, for the human-readable detail line. */
const BUDGET_UNITS: Record<WorkerBudgetName, string> = {
  wall_clock_s: "s",
  peak_rss_mb: "MB",
  cost_usd: "USD",
};

/** Marker every budget hand-forward comment opens with, so a surface (or a
 * test) finds it without matching prose. */
export const WORKER_BUDGET_HANDOFF_MARKER = "🤖 /afk attempt budget";

export type WorkerBudgetHandoffInput = Omit<CapHandoffInput, "capSeconds" | "durationS"> & {
  /** The budget that fired, with its ceiling and the observation. */
  breach: WorkerBudgetBreach;
};

/**
 * Plan the hand-forward for one budgeted termination. The wall-clock budget
 * delegates to {@link planCapHandoff} so #2701's comment stays exactly as
 * shipped; every other budget produces the same plan shape, naming its own
 * budget. The ref is handed forward when the branch carries commits, and the PR
 * is named whenever one is open — the work is already published on it.
 */
export function planBudgetHandoff(input: WorkerBudgetHandoffInput): CapHandoff {
  const { breach, ...rest } = input;
  if (breach.budget === "wall_clock_s") {
    return planCapHandoff({ ...rest, capSeconds: breach.limit, durationS: breach.observed });
  }

  const hasCommits =
    rest.branch !== undefined && rest.branch.length > 0 && rest.branchHead !== undefined;
  const resumeRef = hasCommits ? rest.branch : undefined;
  const pendingPullRequest = rest.pullRequest;
  const handsWorkForward = resumeRef !== undefined || pendingPullRequest !== undefined;
  const unit = BUDGET_UNITS[breach.budget];

  const lines: string[] = [
    `${WORKER_BUDGET_HANDOFF_MARKER}: this worker was stopped by the per-worker ` +
      `\`${breach.budget}\` budget (used ${round(breach.observed, 4)}${unit}, budget ` +
      `${round(breach.limit, 4)}${unit}, \`${WORKER_BUDGET_CONFIG_KEYS[breach.budget]}\`). ` +
      "It was NOT stalled — the cut-off is policy, not a hang.",
  ];
  if (pendingPullRequest !== undefined) {
    lines.push(
      `pending artifact: PR #${pendingPullRequest} — the issue is waiting on that PR, ` +
        "not on a fresh worker. The next worker adopts it through the no-agent gate.",
    );
  }
  if (resumeRef !== undefined) {
    lines.push(
      `resume-from-branch: \`${resumeRef}\`${rest.branchPublished === false ? " (local only — publish failed, adopt it from the worker host)" : ""}`,
    );
    lines.push("The next worker MUST continue from that branch — do NOT start over from main.");
  }
  if (!handsWorkForward) {
    lines.push("No committed work and no open PR were found, so nothing is handed forward.");
  }

  return {
    ...(resumeRef !== undefined ? { resumeRef } : {}),
    ...(pendingPullRequest !== undefined ? { pendingPullRequest } : {}),
    handsWorkForward,
    comment: lines.join("\n"),
  };
}
