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


/**
 * The TOON JSON-IO guard allowlist path. Defined here (a typescript-free leaf
 * module) rather than in `toon-json-guard.ts` so runtime code never imports
 * the guard, which pulls the full `typescript` compiler into the bundle.
 */
export const ALLOWLIST_PATH = ".red/contracts/toon-json-file-io-allowlist.json";

/**
 * Trust-preserving exemption for the TOON JSON-IO guard allowlist
 * (`.red/contracts/toon-json-file-io-allowlist.json`). An `external` entry is a
 * permanent JSON exception that BYPASSES the guard, so growing or changing that
 * set is a trust decision that must be human-reviewed. A migration slice, by
 * contrast, only ever SHRINKS the allowlist — it removes `migrate` entries as it
 * converts JSON→TOON — which is safe to auto-land.
 *
 * Returns true when the `external` set GREW or CHANGED between `oldContent` and
 * `newContent`: a new external id, or a changed reason on an existing one.
 * Removing external entries, and any change to `migrate` entries, are safe (the
 * guard still independently catches genuinely-new JSON). Unparseable new content
 * is treated as widened — fail closed. PURE — no IO.
 */
export function allowlistExternalWidened(oldContent: string, newContent: string): boolean {
  const externalSet = (content: string): Map<string, string> => {
    const parsed = JSON.parse(content) as { entries?: unknown };
    const out = new Map<string, string>();
    if (Array.isArray(parsed.entries)) {
      for (const entry of parsed.entries) {
        const rec = entry as Record<string, unknown>;
        if (rec.classification === "external") {
          out.set(String(rec.id ?? ""), typeof rec.reason === "string" ? rec.reason : "");
        }
      }
    }
    return out;
  };
  let newExternal: Map<string, string>;
  try {
    newExternal = externalSet(newContent);
  } catch {
    return true; // fail closed: an unparseable new allowlist must be reviewed
  }
  let oldExternal: Map<string, string>;
  try {
    oldExternal = externalSet(oldContent);
  } catch {
    oldExternal = new Map(); // no trustworthy baseline → any external reads as new
  }
  for (const [id, reason] of newExternal) {
    if (oldExternal.get(id) !== reason) return true;
  }
  return false;
}

// ---------- ordered gate verdict (ADR 0119, issue #2245) ----------

// The order and its fold moved to `@reddb-io/worker/engine` when the native ACP
// Worker began running the declared stages locally (issue #4020, ADR 0148):
// both bodies need the same table, and two spellings of a stage order agree
// only until somebody edits one. Re-exported here because the callers that
// import it from this module are asking for the gate, not for a package.
export {
  GATE_STAGE_ORDER,
  gateVerdict,
  type GateStage,
  type GateStageOutcome,
  type GateVerdict,
} from "@reddb-io/worker/engine";
