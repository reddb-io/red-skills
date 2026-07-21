// companion — the PURE decision core for the active "Companion mode" monitor
// (#921, PRD #907). GNHF's monitor is a COMPANION, not just a dashboard: it
// watches a live worker, and when the worker drifts (churning iterations without
// producing work, wedged waiting, or sprawling far past the issue's scope) it
// converts the observation into the NEXT acceptance criteria and re-enqueues the
// issue with a bounded correction — instead of only reporting.
//
// This module owns the DECISION only (no IO): given a worker's vitals + the
// per-issue intervention budget, decide whether the attempt is drifting, what
// the correction should say, and — idempotently — whether a correction has
// already been issued for this exact (issue, attempt, signal). The IO pass
// (read worker state, write the issue body/comment/labels) lives in
// runtime/companion-io.ts and the monitor `--companion` flag; both are kept thin
// so this decision logic is unit-testable with plain values.
//
// Safety invariants encoded here (NOT in the IO layer, so they cannot be
// bypassed):
//   - an empty/clean verdict yields NO plan (the monitor stays read-only);
//   - the same (issue, attempt, signal) yields the SAME fingerprint, so a
//     re-poll never appends a second identical correction (idempotency);
//   - once the per-issue intervention budget is spent, the plan ESCALATES to a
//     human instead of injecting yet another correction — a drifting issue can
//     never loop forever.

/** The subset of a worker's vitals the drift detector reads. Mirrors the
 * `current.*` fields of WorkerVitals (iteration churn, line volume, waiting
 * windows) — passed as plain numbers so the detector is pure. */
export interface CompanionVitals {
  /** Current sandcastle agentic-iteration number (1..maxIterations). A high
   * value with little produced work = re-invocation churn. */
  iteration: number;
  /** Cumulative lines added on the worker branch this attempt (committed +
   * uncommitted). The "is it producing work" signal. */
  locAdded: number;
  /** Cumulative lines removed. With locAdded, the total churn / scope size. */
  locRemoved: number;
  /** Heartbeat windows with zero new stream events (waiting/blocked). A high
   * value with flat diff = wedged. */
  waiting: number;
}

/** Operator-tunable drift thresholds (config `plugins.dev.afk.companion.*`). */
export interface CompanionThresholds {
  /** `iteration >= this` AND below the progress floor → iteration-churn. */
  iterationChurn: number;
  /** `waiting >= this` AND below the progress floor → stuck-waiting. */
  waitingWindows: number;
  /** `locAdded + locRemoved >= this` → scope-creep (sprawling past the issue). */
  diffDriftLoc: number;
  /** Below this many added lines a worker has produced ~nothing — the "flat
   * diff" half of the churn/stuck predicates. */
  minProgressLoc: number;
}

/** Sensible defaults — conservative so the companion only fires on clear drift.
 * All overridable via the config thresholds. */
export const DEFAULT_COMPANION_THRESHOLDS: CompanionThresholds = {
  iterationChurn: 8,
  waitingWindows: 20,
  diffDriftLoc: 4000,
  minProgressLoc: 5,
};

export type DriftSignal = "iteration-churn" | "stuck-waiting" | "scope-creep";

export interface DriftVerdict {
  /** True when at least one drift signal fired. */
  drifting: boolean;
  /** Every signal that fired, in priority order. */
  signals: DriftSignal[];
  /** The dominant signal (first in priority order) — the fingerprint key + the
   * driver of the correction text. Undefined when not drifting. */
  primary?: DriftSignal;
}

/**
 * Pure drift predicate over a single vitals snapshot. Priority order
 * (scope-creep > iteration-churn > stuck-waiting) is intentional: a worker that
 * is BOTH churning and sprawling should be corrected on the more dangerous
 * scope drift first. A worker producing real work (locAdded ≥ minProgressLoc)
 * is never flagged for churn/stuck — only genuine spin is drift.
 */
export function detectDrift(v: CompanionVitals, t: CompanionThresholds): DriftVerdict {
  const signals: DriftSignal[] = [];
  const flat = v.locAdded < t.minProgressLoc;
  if (v.locAdded + v.locRemoved >= t.diffDriftLoc) signals.push("scope-creep");
  if (flat && v.iteration >= t.iterationChurn) signals.push("iteration-churn");
  if (flat && v.waiting >= t.waitingWindows) signals.push("stuck-waiting");
  return { drifting: signals.length > 0, signals, primary: signals[0] };
}

/**
 * Stable, deterministic fingerprint for ONE correction. Identical inputs →
 * identical string, so the IO layer can scan an issue's existing comments for
 * this marker and skip a duplicate (idempotency). Deliberately readable rather
 * than hashed — it doubles as the human-visible audit key. No clock / no
 * randomness (both are unavailable in this codebase's deterministic paths).
 */
export function companionFingerprint(issue: number, signal: DriftSignal): string {
  // The attempt ordinal is retired (ADR 0103): a worker runs one attempt, so
  // the key is (issue, signal). Legacy `a<n>` markers remain matchable by the
  // IO scanner for dedupe against pre-0103 comments.
  return `red:companion:${issue}:${signal}`;
}

/** A short, bounded "next acceptance criteria" note per drift signal — the
 * observation converted into a concrete corrective directive the next attempt
 * reads. Kept terse on purpose: a correction, not an essay. */
export function buildCorrectionNote(verdict: DriftVerdict): string {
  switch (verdict.primary) {
    case "scope-creep":
      return "This attempt is sprawling far beyond the issue's scope. Stop, re-read the acceptance criteria, and constrain the change to ONLY what the issue asks — revert unrelated edits before continuing.";
    case "iteration-churn":
      return "This attempt is burning iterations without producing committed work — likely re-validating the same broken approach. Stop and change strategy: write a failing test that pins the exact gap, then make it pass. Commit each small step.";
    case "stuck-waiting":
      return "This attempt appears wedged (many windows with no progress). Stop waiting on the current path. Re-read the issue + recent failures, state your blocker explicitly, and either take a different approach or emit BLOCKED with a concrete question.";
    default:
      return "Re-read the acceptance criteria and verify your work against them before continuing.";
  }
}

/** What the companion decided to DO for a worker this poll. */
export type CompanionPlan =
  | {
      kind: "correct";
      fingerprint: string;
      signal: DriftSignal;
      /** The bounded correction directive to inject as the next acceptance
       * criteria (issue body `## Agent brief` + audit comment). */
      note: string;
    }
  | {
      kind: "escalate";
      fingerprint: string;
      signal: DriftSignal;
      /** Why the companion stopped correcting and handed off to a human. */
      reason: string;
    };

export interface CompanionPlanInput {
  issue: number;
  attempt: number;
  vitals: CompanionVitals;
  thresholds: CompanionThresholds;
  /** Fingerprints already present on the issue (parsed from prior companion
   * audit comments) — the idempotency guard. */
  seenFingerprints: ReadonlySet<string>;
  /** The per-issue intervention budget (recoveryCap("drift", env)). Once the
   * attempt count reaches it, the companion escalates instead of correcting. */
  cap: number;
}

/**
 * The companion's per-worker decision. Returns `null` when there is nothing to
 * do — NOT drifting, or a correction for this exact (issue, attempt, signal)
 * already exists. Returns an `escalate` plan once the per-issue budget is spent,
 * else a bounded `correct` plan. PURE: the caller performs the gh writes.
 */
export function planCompanionCorrection(input: CompanionPlanInput): CompanionPlan | null {
  const verdict = detectDrift(input.vitals, input.thresholds);
  if (!verdict.drifting || verdict.primary === undefined) return null;
  const signal = verdict.primary;
  const fingerprint = companionFingerprint(input.issue, signal);
  // Idempotency: one correction per (issue, signal). With the attempt ordinal
  // retired (ADR 0103) this matches the previous behavior exactly — the ordinal
  // was constant at 1, so the key never varied within an issue anyway.
  if (input.seenFingerprints.has(fingerprint)) return null;
  if (input.attempt >= input.cap) {
    return {
      kind: "escalate",
      fingerprint,
      signal,
      reason: `Companion intervention budget spent (attempt ${input.attempt} ≥ cap ${input.cap}); handing off to a human instead of injecting another correction.`,
    };
  }
  return { kind: "correct", fingerprint, signal, note: buildCorrectionNote(verdict) };
}
