/**
 * completion.ts — the monotonic completion transaction.
 *
 * Waking another process is the dangerous moment of a wait: the sleeper opens
 * the result the instant it is signaled, so anything not already durable does
 * not exist. This module sequences that moment.
 *
 * The transaction has exactly three states and only moves forward:
 *
 * 1. **sealed** — the target verdict is decided and written to disk. The verdict
 *    is now immutable; nothing after this point may change what the wait
 *    observed about its target.
 * 2. **delivering** — hooks run. The durable record already says
 *    `delivery.status: pending`, which is honest: a reader that arrives now
 *    knows the verdict AND knows delivery is unresolved.
 * 3. **settled** — the delivery receipt is stamped `success` or `failure`.
 *
 * The deliberate consequence: the record is never written as provisionally
 * successful and then downgraded. `pending` is the only non-terminal delivery
 * value, so no reader can mistake an in-flight wake for a completed one.
 */
import { resolve } from "node:path";
import type { JsonObject, JsonValue } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import {
  exitCodeFor,
  WAIT_RESULT_SCHEMA,
  WAIT_SCHEMA_VERSION,
  type DeliveryResult,
  type Verdict,
  type WaitExitCode,
  type WaitKind,
  type WaitOptions,
  type WaitRegistryEntry,
} from "./model.js";
import { atomicWrite } from "./registry.js";
import { deliverCompletion } from "./delivery.js";

/** Delivery as recorded on disk — `pending` exists only between seal and settle. */
export type DeliveryStatus = "pending" | "success" | "failure";

export interface CompletionOutcome {
  /** The final envelope, delivery receipt included. */
  result: JsonObject;
  /** The process exit code: the semaphore the caller returns. */
  exitCode: WaitExitCode;
}

/**
 * Run the whole completion sequence for one wait.
 *
 * `cleanupProven` carries the termination evidence: a wait that could not prove
 * its command tree is gone reports 2, because "we think it exited" is not the
 * same claim as "it exited".
 */
export async function completeWait(input: {
  kind: WaitKind;
  entry: WaitRegistryEntry;
  verdict: Verdict;
  options: WaitOptions;
  cwd: string;
  cleanupProven?: boolean;
  survivors?: number[];
}): Promise<CompletionOutcome> {
  const { kind, entry, options, cwd } = input;
  const verdict = withCleanupEvidence(input.verdict, input.cleanupProven, input.survivors);
  const completedAt = new Date().toISOString();

  // 1. Seal: the verdict becomes durable BEFORE anything can wake on it.
  const sealed = renderResult(kind, entry, verdict, { status: "pending" }, completedAt);
  await persistResult(options.resultFile, sealed, options.format);

  // 2. Deliver: hooks see the sealed record, never a half-formed one.
  const delivery = await deliverCompletion(options, sealed, cwd);

  // 3. Settle: stamp the receipt. The verdict fields are re-rendered from the
  //    same inputs, so the only field that can differ from the sealed record is
  //    the delivery receipt itself.
  const settled = renderResult(kind, entry, verdict, delivery, completedAt);
  await persistResult(options.resultFile, settled, options.format);
  return { result: settled, exitCode: finalExitCode(verdict, delivery) };
}

/**
 * The exit semaphore. A delivery failure degrades to 2 rather than borrowing the
 * target's code: the caller genuinely does not know whether anyone was woken, and
 * 2 is exactly "indeterminate".
 */
export function finalExitCode(verdict: Verdict, delivery: { status: DeliveryStatus }): WaitExitCode {
  // Pending delivery reports 2 for the same reason failure does: until the
  // receipt is stamped, nobody knows whether the wake landed. Starting at 2 also
  // keeps the sealed record monotonic — it can only ever be revised toward the
  // target's code, never away from a premature success.
  if (delivery.status !== "success") return 2;
  return verdict.status === "running" ? 2 : exitCodeFor(verdict.status);
}

/**
 * Fold termination evidence into the verdict. An unprovable cleanup cannot stay
 * a success — a surviving descendant may still be holding the very lock or port
 * the caller is about to use.
 */
function withCleanupEvidence(verdict: Verdict, cleanupProven: boolean | undefined, survivors: number[] = []): Verdict {
  if (cleanupProven !== false) return verdict;
  return {
    status: "indeterminate",
    exitCode: 2,
    summary: `${verdict.summary}; could not verify process cleanup`,
    details: {
      ...(verdict.details ?? {}),
      cleanup: { verified: false, survivors },
    },
  };
}

/**
 * The `rsp.wait.result` v1 envelope.
 *
 * `target_exit_code` is the verdict about the thing being waited on;
 * `exit_code` is what the process returns after delivery is accounted for.
 * Keeping both means a green PR whose notify hook failed reads as exactly that,
 * instead of masquerading as a failed PR.
 */
export function renderResult(
  kind: WaitKind,
  entry: WaitRegistryEntry,
  verdict: Verdict,
  delivery: DeliveryResult | { status: "pending" },
  completedAt: string,
): JsonObject {
  return {
    schema: WAIT_RESULT_SCHEMA,
    version: WAIT_SCHEMA_VERSION,
    wait: {
      id: entry.id,
      target: entry.target,
      kind,
      status: verdict.status,
      reason: entry.reason,
      started_at: entry.started_at,
      completed_at: completedAt,
      poll_tier: entry.poll_tier,
    },
    verdict: {
      exit_code: finalExitCode(verdict, delivery),
      target_exit_code: verdict.exitCode,
      summary: verdict.summary,
      delivery: delivery as unknown as JsonValue,
      ...(verdict.details ? { details: verdict.details as JsonValue } : {}),
    },
  };
}

/** Write the envelope to `--result-file` by atomic rename, or do nothing. */
export async function persistResult(
  path: string | undefined,
  result: JsonObject,
  format: "toon" | "json",
): Promise<void> {
  if (!path) return;
  await atomicWrite(resolve(path), renderStructured(result, format));
}

/**
 * TOON is the canonical rendering; `--json` is the explicit compatibility
 * presentation for callers piping into JSON tooling.
 */
export function renderStructured(value: JsonObject, format: "toon" | "json"): string {
  return format === "json" ? `${JSON.stringify(value, null, 2)}\n` : `${encodeSnapshotToon(value)}\n`;
}
