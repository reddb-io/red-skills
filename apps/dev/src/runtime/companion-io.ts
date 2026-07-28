// runtime/companion-io.ts — the IO half of the active "Companion mode" monitor
// (#921, PRD #907). The PURE decision core is core/companion.ts: given a worker's
// vitals + the per-issue intervention budget it decides whether the attempt is
// drifting and what the bounded correction should say. This module performs the
// reads and writes around that decision — and NOTHING else:
//
//   reads   worker state files (the SAME single-owner reader the dashboard uses)
//           + the issue body/labels/comments (only for a worker already judged
//           to be drifting, so a healthy fleet triggers ZERO gh calls);
//   writes  the issue BODY (`## Agent brief` for a correction, `## Current
//           blocker` for an escalation) + a fingerprinted audit comment + the
//           `ready-for-agent` / `ready-for-human` label — write-only, idempotent.
//
// Safety contract (the issue's acceptance criteria):
//   - the monitor stays read-only unless the caller passes `--companion`; this
//     module is never invoked otherwise (commands/monitor.ts gates it);
//   - at most ONE correction per (issue, attempt, signal): the fingerprint is
//     parsed back out of the issue's existing comments, so a re-poll is a no-op;
//   - the bounded budget is shared (recoveryCap("drift", env)); at the cap the
//     plan ESCALATES to ready-for-human instead of correcting again;
//   - it NEVER kills a process — re-enqueue + the corrected brief delegate
//     termination/respawn to the reaper + fleet supervisor (works WITH /afk fleet).

import { dirname } from "node:path";
import * as ghx from "./gh.js";
import type { GhContext } from "./gh.js";
import { readWorkerStates, type WorkerStatesReadOpts, type WorkerStateRecord } from "../core/worker-state-reader.js";
import { parseWorkerAttemptPath } from "../core/worker-paths.js";
import { upsertAgentBrief, AGENT_BRIEF_HEADING } from "../core/agent-brief.js";
import { upsertCurrentBlocker } from "../core/blocker-state.js";
import { recoveryCap, type RecoveryEnv } from "../core/recovery.js";
import {
  detectDrift,
  planCompanionCorrection,
  DEFAULT_COMPANION_THRESHOLDS,
  type CompanionThresholds,
  type CompanionVitals,
  type CompanionPlan,
} from "../core/companion.js";
import { getConfig, type ConfigValues } from "../core/config.js";
import { transitionLabels, type StateTransition } from "../core/state-transition.js";
import type { AfkState } from "../types/state.js";

/** The issue-body section the correction directive lands in — the next attempt's
 * brief. Kept stable so a re-correction REPLACES the section rather than stacking. */
export const COMPANION_BRIEF_HEADING = AGENT_BRIEF_HEADING;

/** Fallback drift cap if the reason were ever absent from the recovery table
 * (it is registered there with this same default — belt and suspenders). */
export const DEFAULT_DRIFT_CAP = 2;

/**
 * Resolve the operator-tunable drift thresholds from the folded config
 * (`plugins.dev.afk.companion.*` → `afk.companion.*`). Each key falls back to the
 * matching {@link DEFAULT_COMPANION_THRESHOLDS} field when unset / non-numeric /
 * non-positive, so a typo can never relax a threshold to 0 and fire on every
 * worker.
 */
export function resolveCompanionThresholds(values: ConfigValues): CompanionThresholds {
  const num = (key: string, fallback: number): number => {
    const n = Number(getConfig(values, key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    iterationChurn: num("afk.companion.iteration_churn", DEFAULT_COMPANION_THRESHOLDS.iterationChurn),
    waitingWindows: num("afk.companion.waiting_windows", DEFAULT_COMPANION_THRESHOLDS.waitingWindows),
    diffDriftLoc: num("afk.companion.diff_drift_loc", DEFAULT_COMPANION_THRESHOLDS.diffDriftLoc),
    minProgressLoc: num("afk.companion.min_progress_loc", DEFAULT_COMPANION_THRESHOLDS.minProgressLoc),
  };
}

/** The shared bounded-recovery budget for the `drift` reason (#921). */
export function resolveDriftCap(env: RecoveryEnv): number {
  return recoveryCap("drift", env) ?? DEFAULT_DRIFT_CAP;
}

/** Project the persisted worker vitals onto the pure detector's input. The
 * `iteration` field is `number | string` on disk (default ""); a non-numeric
 * value coerces to 0 so a fresh/identity-only state never falsely churns. */
export function companionVitals(state: AfkState): CompanionVitals {
  const iterRaw = state.current.iteration;
  const iteration = typeof iterRaw === "number" ? iterRaw : Number(iterRaw);
  return {
    iteration: Number.isFinite(iteration) ? iteration : 0,
    locAdded: state.current.loc_added,
    locRemoved: state.current.loc_removed,
    waiting: state.current.waiting_count,
  };
}

/** Every companion fingerprint embedded in a comment body, regardless of where it
 * sits (visible text or an HTML-comment marker). Matches the current grammar
 * `companionFingerprint` emits (`red:companion:<issue>:<signal>`, ADR 0103) AND
 * the legacy pre-0103 form with the retired attempt ordinal
 * (`red:companion:<issue>:a<attempt>:<signal>`), so old comments still dedupe. */
const FINGERPRINT_RE = /red:companion:\d+:(?:a\d+:)?[a-z-]+/g;

/**
 * The idempotency guard: collect every companion fingerprint already present in
 * the issue's comments. A re-poll of the same (issue, attempt, signal) finds its
 * fingerprint here and {@link planCompanionCorrection} returns null — so no
 * second identical correction is ever appended.
 */
export function parseSeenFingerprints(commentBodies: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const body of commentBodies) {
    for (const m of body.matchAll(FINGERPRINT_RE)) out.add(m[0]);
  }
  return out;
}

/** The audit comment posted alongside a correction/escalation. Carries the
 * fingerprint as a hidden marker (the durable idempotency key) plus a
 * human-readable note. Mirrors the `<details data-kind>` audit shape requeue uses. */
function auditComment(plan: CompanionPlan, issue: number, attempt: number): string {
  const body =
    plan.kind === "correct"
      ? `Drift detected (\`${plan.signal}\`) on attempt ${attempt}. Injected a bounded correction into the issue brief and re-enqueued for a fresh attempt.\n\nCorrection:\n${plan.note}`
      : `Drift detected (\`${plan.signal}\`) on attempt ${attempt}. ${plan.reason}`;
  return [
    `<details data-kind="companion">`,
    `<summary>Companion ${plan.kind === "correct" ? "correction" : "escalation"} — ${plan.signal}</summary>`,
    "",
    `<!-- ${plan.fingerprint} -->`,
    body,
    "</details>",
  ].join("\n");
}

/** Rewrite the issue body for a `correct` plan: replace the `## Agent brief`
 * section with the bounded correction directive the next attempt reads. Uses
 * byte-exact anchor editing so every byte outside the brief block is preserved. */
export function applyCorrectionBody(body: string, note: string, signal: string): string {
  const brief = [
    "<!-- companion-correction -->",
    "",
    `Companion drift correction (\`${signal}\`):`,
    "",
    note,
  ].join("\n");
  return upsertAgentBrief(body, brief);
}

/** Rewrite the issue body for an `escalate` plan: open a `## Current blocker`
 * (kind `drift`) so /hitl can pick it up — the bounded budget is spent. */
export function applyEscalationBody(body: string, signal: string, reason: string): string {
  return upsertCurrentBlocker(body, {
    status: "blocked",
    kind: "drift",
    summary: `Companion drift correction budget spent (${signal}).`,
    next: `${reason} A human should re-read the issue, decide whether to re-scope or close it, then requeue.`,
  });
}

/** The outcome of a single worker's companion pass — surfaced for the dashboard
 * line + tests. `corrected`/`escalated` carry the applied disposition; `none`
 * means not drifting or already-corrected (idempotent no-op). */
export interface CompanionOutcome {
  issue: number;
  attempt: number;
  disposition: "corrected" | "escalated" | "skipped-idempotent" | "clean";
  signal?: string;
}

export interface CompanionPassOptions {
  /** The primary checkout root (`afkPaths(root).workersRoot` is read from here). */
  workersRoot: string;
  ctx: GhContext;
  thresholds: CompanionThresholds;
  cap: number;
  /** Print the plan but perform NO gh writes (still reads to compute the plan). */
  dryRun?: boolean;
  /** Injected for tests: the worker-state read (defaults to the real reader). */
  readStates?: (root: string, opts?: WorkerStatesReadOpts) => Promise<WorkerStateRecord[]>;
  /** Injected for tests: liveness clock / probes forwarded to the reader. */
  readOpts?: WorkerStatesReadOpts;
}

/**
 * Run ONE companion pass over the live fleet. For each pid-live worker holding an
 * issue: compute its vitals, and only if the PURE detector flags drift, read the
 * issue (body/labels/comments), plan via {@link planCompanionCorrection}, and —
 * unless `dryRun` — apply the body rewrite + audit comment + label transition.
 *
 * A healthy fleet performs ZERO gh calls (the drift gate short-circuits before
 * the issue read), keeping the active monitor cheap. Returns one outcome per
 * worker the pass examined, in fleet order.
 */
export async function runCompanionPass(options: CompanionPassOptions): Promise<CompanionOutcome[]> {
  const readStates = options.readStates ?? readWorkerStates;
  const records = await readStates(options.workersRoot, options.readOpts);
  const outcomes: CompanionOutcome[] = [];

  for (const rec of records) {
    // The companion watches a LIVE worker (pid identity matches). A wedged
    // worker is `quiet-but-live` — still pid-live — so `rec.live` (identity, not
    // freshness) is the right gate: it catches both the churning AND the wedged.
    // A truly dead worker (pid gone) is the reaper's job, not the companion's.
    if (!rec.live) continue;
    const id = parseWorkerAttemptPath(dirname(rec.path));
    if (!id) continue;

    const vitals = companionVitals(rec.state);
    // Pure short-circuit: no drift → no issue read, no write (read-only-safe).
    if (!detectDrift(vitals, options.thresholds).drifting) {
      outcomes.push({ issue: id.issue, attempt: id.attempt, disposition: "clean" });
      continue;
    }

    const view = await ghx.viewIssueFull(options.ctx, id.issue);
    if (view === null) continue; // transient gh failure / 404 — skip this tick.
    const comments = await ghx.issueComments(options.ctx, id.issue);
    const seen = parseSeenFingerprints(comments.map((c) => c.body));

    const plan = planCompanionCorrection({
      issue: id.issue,
      attempt: id.attempt,
      vitals,
      thresholds: options.thresholds,
      seenFingerprints: seen,
      cap: options.cap,
    });
    if (plan === null) {
      // Drifting, but a correction for this exact (issue, attempt, signal)
      // already exists — the idempotent no-op.
      outcomes.push({ issue: id.issue, attempt: id.attempt, disposition: "skipped-idempotent" });
      continue;
    }

    if (options.dryRun) {
      outcomes.push({
        issue: id.issue,
        attempt: id.attempt,
        disposition: plan.kind === "correct" ? "corrected" : "escalated",
        signal: plan.signal,
      });
      continue;
    }

    // Body rewrite FIRST (the durable correction), then the fingerprinted audit
    // comment (the idempotency key), then the label transition. Ordering is
    // deliberate: if a later step fails, the next poll re-reads — and the absent
    // fingerprint means it retries the whole transition rather than half-applying.
    // The label delta comes from the ADR 0122 planner (#2663), fed the issue's
    // CURRENT labels: it only removes what is actually present and only adds
    // what is absent — so a one-sided `gh issue edit --remove-label X` for an X
    // the issue never had can't fail the whole (remove + add) command — and it
    // additionally sheds the state roles and `blocked:*` reasons the two
    // hand-rolled deltas used to leave stacked on the corrected issue.
    if (plan.kind === "correct") {
      await ghx.editBody(options.ctx, id.issue, applyCorrectionBody(view.body, plan.note, plan.signal));
      await ghx.comment(options.ctx, id.issue, auditComment(plan, id.issue, id.attempt));
      await applyCompanionTransition(options.ctx, id.issue, view.labels, { kind: "queue" });
      outcomes.push({ issue: id.issue, attempt: id.attempt, disposition: "corrected", signal: plan.signal });
    } else {
      await ghx.editBody(options.ctx, id.issue, applyEscalationBody(view.body, plan.signal, plan.reason));
      await ghx.comment(options.ctx, id.issue, auditComment(plan, id.issue, id.attempt));
      await applyCompanionTransition(options.ctx, id.issue, view.labels, { kind: "human" });
      outcomes.push({ issue: id.issue, attempt: id.attempt, disposition: "escalated", signal: plan.signal });
    }
  }

  return outcomes;
}

/**
 * Apply one companion drift correction through the ADR 0122 transition API
 * (#2663). The planner owns the delta: `queue` re-arms a drifting attempt on
 * `ready-for-agent`, `human` escalates it — both computed against the issue's
 * CURRENT labels, so the mutation is idempotent AND provably leaves exactly one
 * state role. A refusal (a `queue` while `req:*` edges survive) performs no
 * edit; the body rewrite and the fingerprinted audit comment already landed, so
 * the next poll re-reads and the operator sees the unchanged labels.
 */
async function applyCompanionTransition(
  ctx: GhContext,
  issue: number,
  current: readonly string[],
  transition: StateTransition,
): Promise<void> {
  await transitionLabels((remove, add) => ghx.editLabels(ctx, issue, remove, add), current, transition);
}

/** One-line dashboard summary of a companion pass (printed under the dashboard
 * when `--companion` is on). Empty string when nothing drifted, so a calm fleet
 * adds no noise. */
export function summarizeCompanionPass(outcomes: readonly CompanionOutcome[], dryRun = false): string {
  const acted = outcomes.filter((o) => o.disposition === "corrected" || o.disposition === "escalated");
  if (acted.length === 0) return "";
  const verb = dryRun ? "would " : "";
  const parts = acted.map(
    (o) => `#${o.issue} a${o.attempt} ${verb}${o.disposition === "corrected" ? "correct" : "escalate"} (${o.signal})`,
  );
  return `companion: ${parts.join(", ")}`;
}
