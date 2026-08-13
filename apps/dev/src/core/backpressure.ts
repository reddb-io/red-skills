// backpressure — the AFK operator-declared pre-merge gate (PRD #429, issue #430).
//
// A sibling of feedback.ts. Where feedback derives test/typecheck/lint/build from
// the touched package scopes, backpressure runs an EXPLICIT, operator-declared,
// ordered list of shell commands from `.red/config.yaml` (`afk.backpressure`)
// against the worker-branch worktree. It SUPPLEMENTS the feedback gate — it never
// replaces it — and runs AFTER feedback passes on the DONE path: any command that
// exits non-zero blocks the merge and parks the issue to ready-for-human exactly
// like a feedback failure.
//
// Like feedback, IO is fully injected: `exec` runs the real shell command in the
// worker-branch checkout, and `now` supplies the millisecond clock, so the
// decision logic and the `red.afk.validation.v1` sidecar record shape are
// unit-testable against fixed inputs with no real process ever spawned. The
// record shaping (`buildValidationRecord` / `outputSummary` / `formatValidationLine`)
// and the `red.afk.validation.v1` schema are reused verbatim from feedback.ts so
// the two gates emit byte-identical sidecar records.

import { KILLED_EXIT_CODE } from "../runtime/exec.js";
import {
  buildValidationRecord,
  formatValidationLine,
  outputSummary,
  type ExecResult,
  type ValidationRecord,
  type ValidationStatus,
} from "./feedback.js";

/**
 * Default per-command kill deadline for the backpressure gate (10 minutes).
 * The gate runs arbitrary operator `sh -c` commands AFTER the inner agent has
 * emitted DONE — outside the reach of the attempt-progress guard and the fleet
 * reaper — so without a bound a hung command deadlocks the worker forever
 * (PRD #567). Bounding it makes a hung command resolve as a non-zero failure
 * (via {@link KILLED_EXIT_CODE}) that surfaces as a validation block instead.
 */
export const DEFAULT_BACKPRESSURE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Injected shell executor for a single backpressure command. Receives the raw
 * command string (e.g. `npm run test`), the working directory it runs in (the
 * worker-branch checkout root), and the per-command kill deadline; resolves with
 * the captured exit code + streams. Mirrors the hook executor's
 * `sh -c <command>` contract. A command killed by `timeoutMs` resolves
 * non-zero (the exec edge reports {@link KILLED_EXIT_CODE}), never code 0.
 */
export type BackpressureExec = (input: {
  command: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<ExecResult>;

/** One completed backpressure command, surfaced alongside its sidecar record. */
export interface BackpressureCheck {
  /** `backpressure:<cmd>`, e.g. `backpressure:npm run test`. */
  name: string;
  /** The exact command string that ran. */
  command: string;
  status: ValidationStatus;
  record: ValidationRecord;
}

export interface RunBackpressureInput {
  /** Worker-branch checkout token, passed through as each command's `cwd`. */
  worktree: string;
  /** Operator-declared commands (from `afk.backpressure`), run in order. */
  commands: readonly string[];
  /** Injected millisecond clock — no `Date.now()` at module scope. */
  now: () => number;
  /**
   * Per-command kill deadline. Defaults to
   * {@link DEFAULT_BACKPRESSURE_TIMEOUT_MS}; a command that overruns it is
   * killed and recorded as a `failed` (timed-out) validation block.
   */
  timeoutMs?: number;
}

export interface RunBackpressureResult {
  /** False when any command exited non-zero — the merge gate (PRD #429). */
  ok: boolean;
  /** Every command that ran, in declaration order. */
  checks: BackpressureCheck[];
  /** The sidecar lines, one JSONL record per command, in the same order. */
  sidecar: string[];
}

/**
 * Run the operator-declared backpressure commands in order against the
 * worker-branch worktree. For each command: time it with the injected clock,
 * run it via the injected exec in the worktree dir under a bounded kill
 * deadline (`timeoutMs`, default {@link DEFAULT_BACKPRESSURE_TIMEOUT_MS}), and
 * emit a `passed`/`failed` `red.afk.validation.v1` record named
 * `backpressure:<cmd>`. A command killed by the deadline resolves non-zero (the
 * exec edge reports {@link KILLED_EXIT_CODE}) and is recorded as a `failed`
 * (timed-out) block, never silently passing — so a hung command surfaces as a
 * validation block instead of deadlocking the worker. Blank/whitespace entries
 * are skipped (not recorded). Every command runs so the operator sees the full
 * picture; `ok` is false if ANY command failed, blocking the merge. An empty
 * command list is a no-op (`ok:true`, no checks, no sidecar). Nothing here
 * touches the filesystem or a real clock.
 */
export async function runBackpressure(
  exec: BackpressureExec,
  input: RunBackpressureInput,
): Promise<RunBackpressureResult> {
  const { worktree, commands, now } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS;
  const checks: BackpressureCheck[] = [];
  const sidecar: string[] = [];
  let failed = false;

  for (const raw of commands) {
    const command = raw.trim();
    if (command === "") continue;

    const name = `backpressure:${command}`;
    const start = now();
    const result = await exec({ command, cwd: worktree, timeoutMs });
    const durationMs = now() - start;
    const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
    if (status === "failed") failed = true;
    // A timed-out command (killed at the deadline) reports KILLED_EXIT_CODE with
    // no useful captured output — give the operator an explicit timed-out
    // summary instead of the generic `command exited non-zero`.
    const summary =
      result.infraEvidence?.kind === "stall"
        ? outputSummary(status, `${result.stdout}${result.stderr}`)
        : result.code === KILLED_EXIT_CODE
        ? `command timed out after ${timeoutMs}ms`
        : outputSummary(status, `${result.stdout}${result.stderr}`);
    const record = buildValidationRecord({
      name,
      status,
      command,
      exitCode: result.code,
      durationMs,
      summary,
      infra: result.infraEvidence?.kind,
      resources: result.resources,
    });
    checks.push({ name, command, status, record });
    sidecar.push(formatValidationLine(record));
  }

  return { ok: !failed, checks, sidecar };
}

/**
 * Header line for the aggregated backpressure evidence ledger (issue #1279). It
 * states, in-band, that the review is purely additive observability so nobody
 * reads a COMMENT review as a gate: the merge/park decision is owned entirely by
 * {@link runBackpressure}'s `ok` flag and is byte-for-byte unchanged by this.
 */
export const BACKPRESSURE_REVIEW_HEADER =
  "🤖 backpressure evidence ledger — operator-declared merge-gate checks " +
  "(non-blocking, observability only; the merge/park decision is unchanged).";

/**
 * Render the aggregated, NON-BLOCKING backpressure evidence ledger for a PR
 * review body (issue #1279). PURE — no IO, no clock. Maps every executed
 * {@link BackpressureCheck} (both positive and negative) to one line:
 *   - passed → `✅ backpressure:<cmd>`
 *   - failed → `❌ backpressure:<cmd> → <summary>`
 * (the check's `name` is already `backpressure:<cmd>`). Returns `null` for an
 * empty check list so the caller posts NOTHING — an empty ledger is never a
 * review. This renders an EVIDENCE view of what already ran; it never re-decides
 * the merge, which stays owned by {@link RunBackpressureResult.ok}.
 */
export function renderBackpressureReviewBody(
  checks: readonly BackpressureCheck[],
): string | null {
  if (checks.length === 0) return null;
  const lines = checks.map((check) =>
    check.status === "passed"
      ? `✅ ${check.name}`
      : `❌ ${check.name} → ${check.record.summary ?? "command failed"}`,
  );
  return [BACKPRESSURE_REVIEW_HEADER, "", ...lines].join("\n");
}
