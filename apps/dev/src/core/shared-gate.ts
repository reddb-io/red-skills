// shared-gate — closed mechanical allowlist + context-aware escalation (ADR 0081, issue #931).
//
// The SINGLE authority for classifying gate findings as mechanical vs. intent,
// applying mechanical findings in-tree, and routing intent findings to the right
// escalation sink. Designed to be shared by `/go` (interactive) and `/afk`
// (headless) without duplicating the classification logic.
//
// Two rules drive everything:
//   1. CLOSED ALLOWLIST — a finding is mechanical only when its kind appears on
//      the enumerated list below. Anything absent from the list is INTENT by
//      default. There is no catch-all "other mechanical"; the default is intent.
//   2. CONTEXT-AWARE SINK — mechanical findings auto-apply + commit (always);
//      intent findings are handed to the caller-injected EscalationSink, which
//      differs by context: interactive (/go) = pause and ask; headless (/afk) =
//      park to ready-for-human.
//
// IO-free: every effect (apply, commit, escalate) is injected, so the decision
// logic, classification, and result shape are fully unit-testable with zero
// subprocesses or network access.

// ---------- mechanical allowlist ----------

/**
 * The CLOSED, AUDITABLE set of mechanical finding kinds. A finding whose `kind`
 * is NOT in this set is classified as INTENT by default — no catch-all.
 *
 * ADR 0081 enumerates exactly these kinds. To add a new mechanical kind, amend
 * this list AND update the ADR. Anything outside this set must go through human
 * review.
 */
export const MECHANICAL_KINDS = [
  "formatter",
  "import-organizer",
  "lint-fix",
  "comment-typo",
  "trailing-whitespace",
  "trailing-newline",
] as const;

export type MechanicalKind = (typeof MECHANICAL_KINDS)[number];

/** A gate finding — one diagnostic produced by the review/lint/format step. */
export interface GateFinding {
  /** The canonical kind. Must be one of {@link MECHANICAL_KINDS} to be auto-applied. */
  kind: string;
  /** Human-readable description of the finding (shown in escalation comments). */
  description: string;
  /** Optional patch or command to apply the fix. Populated for mechanical findings. */
  patch?: string;
}

// ---------- classification ----------

/**
 * Classify a single gate finding. PURE predicate — no IO.
 *
 * Returns `"mechanical"` only when `finding.kind` is a member of the closed
 * {@link MECHANICAL_KINDS} allowlist. Every other kind is `"intent"` — the safe
 * default that prevents silent auto-commit of logic changes.
 */
export function classifyFinding(finding: GateFinding): "mechanical" | "intent" {
  const allowed = new Set<string>(MECHANICAL_KINDS);
  return allowed.has(finding.kind) ? "mechanical" : "intent";
}

// ---------- escalation sinks ----------

/**
 * The execution context that selects the escalation sink.
 *
 * - `"interactive"` — a human is present (e.g. `/go`). The sink pauses and asks
 *   the maintainer to approve, fix, or skip each intent finding.
 * - `"headless"` — no human is present (e.g. `/afk`). The sink parks the issue
 *   to `ready-for-human` with `blocked:validation` and a comment.
 */
export type GateContext = "interactive" | "headless";

/** The outcome of an escalation for a single intent finding. */
export type EscalationOutcome = "approved" | "skipped" | "parked";

/** An injected escalation action for one intent finding. Returns the outcome. */
export type EscalationSink = (finding: GateFinding) => Promise<EscalationOutcome>;

/** An injected apply + commit action for one mechanical finding. */
export type MechanicalApply = (finding: GateFinding) => Promise<void>;

// ---------- result ----------

/** Per-finding resolution recorded in the gate result. */
export interface FindingResolution {
  finding: GateFinding;
  classification: "mechanical" | "intent";
  /** Set for mechanical findings that were auto-applied. */
  applied?: true;
  /** Set for intent findings that were escalated via the sink. */
  escalationOutcome?: EscalationOutcome;
}

/**
 * The result of running the shared gate over a set of findings.
 *
 * - `passed` — all findings were either mechanical (auto-applied) or intent
 *   findings that the maintainer approved. The gate is green.
 * - `parked` — at least one intent finding was parked (headless sink) or skipped
 *   and blocked the gate. The caller must not proceed to merge.
 */
export interface SharedGateResult {
  /** True only when every finding resolved without blocking. */
  passed: boolean;
  /** Per-finding detail records, in input order. */
  resolutions: FindingResolution[];
  /** Total count of mechanical findings that were auto-applied + committed. */
  mechanicalApplied: number;
  /** Total count of intent findings that were escalated (any outcome). */
  intentEscalated: number;
}

// ---------- gate runner ----------

/**
 * Dependencies for the shared gate — all effects injected for testability.
 */
export interface SharedGateDeps {
  /** Apply a mechanical finding in-tree and commit it. */
  applyMechanical: MechanicalApply;
  /** Escalate one intent finding to the context-appropriate sink. */
  escalateIntent: EscalationSink;
}

/**
 * Run the shared validation gate over `findings`.
 *
 * For each finding:
 *   - **Mechanical** → `deps.applyMechanical(finding)` (auto-apply + commit).
 *   - **Intent** → `deps.escalateIntent(finding)` (context-aware sink).
 *
 * The gate is GREEN (`passed: true`) when every intent finding resolves with
 * `"approved"`. A single `"parked"` or `"skipped"` (when the caller treats skip
 * as blocking) outcome makes the gate RED. The convention followed here is:
 *   - `"approved"` → non-blocking (maintainer accepted the change)
 *   - `"parked"`   → blocking (headless sink requested human review)
 *   - `"skipped"`  → blocking (interactive sink: skip = do not land)
 *
 * PURE SEQUENCING — no decision logic lives here beyond the classification +
 * routing; all judgment (interactive prompt wording, park comment text) stays in
 * the injected sinks.
 */
export async function runSharedGate(
  findings: readonly GateFinding[],
  deps: SharedGateDeps,
): Promise<SharedGateResult> {
  const resolutions: FindingResolution[] = [];
  let mechanicalApplied = 0;
  let intentEscalated = 0;
  let passed = true;

  for (const finding of findings) {
    const classification = classifyFinding(finding);

    if (classification === "mechanical") {
      await deps.applyMechanical(finding);
      resolutions.push({ finding, classification, applied: true });
      mechanicalApplied++;
    } else {
      const escalationOutcome = await deps.escalateIntent(finding);
      resolutions.push({ finding, classification, escalationOutcome });
      intentEscalated++;
      if (escalationOutcome !== "approved") {
        passed = false;
      }
    }
  }

  return { passed, resolutions, mechanicalApplied, intentEscalated };
}

// ---------- built-in sink factories ----------

/**
 * Build the headless escalation sink. Parks on any intent finding: logs the
 * finding to `parkIntent` (caller handles label/comment write) and returns
 * `"parked"` — always blocking, always requiring human review.
 */
export function makeHeadlessSink(parkIntent: (finding: GateFinding) => Promise<void>): EscalationSink {
  return async (finding) => {
    await parkIntent(finding);
    return "parked";
  };
}

/**
 * Build the interactive escalation sink. Delegates the approve/skip decision to
 * the injected `promptUser` callback (the CLI prompt or test double). Returns
 * whatever the prompt returns — the sink itself carries no prompt wording.
 */
export function makeInteractiveSink(
  promptUser: (finding: GateFinding) => Promise<"approved" | "skipped">,
): EscalationSink {
  return async (finding) => {
    return promptUser(finding);
  };
}
