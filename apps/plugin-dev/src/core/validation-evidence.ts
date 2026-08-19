import type { ClassifiableCheck, ValidationRecord } from "./feedback.js";
import { blockingValidationChecks } from "./verdict.js";

export const ALL_GREEN_VALIDATION_INCONSISTENCY =
  "aggregate validation result reported failure with all-green validation evidence; " +
  "refusing blocked:validation park";

/** Reconcile an aggregate failure against the durable per-command authority. */
export function reconcileValidationEvidence<T extends ClassifiableCheck>(
  reportedFailed: boolean,
  checks: readonly T[],
): { ok: boolean; checks: T[]; sidecar: string[]; evidenceInconsistency?: string } {
  if (!reportedFailed || blockingValidationChecks(checks).length > 0 || checks.length === 0) {
    return {
      ok: !reportedFailed,
      checks: [...checks],
      sidecar: checks.map((check) => JSON.stringify(check.record)),
    };
  }
  const allGreen = checks.every(
    (check) => check.status !== "failed" || check.record.exitCode === 0,
  );
  if (!allGreen) {
    return {
      ok: false,
      checks: [...checks],
      sidecar: checks.map((check) => JSON.stringify(check.record)),
    };
  }
  const reconciled = checks.map((check) => {
    if (check.status !== "failed" || check.record.exitCode !== 0) return check;
    const record: ValidationRecord = {
      ...check.record,
      status: "passed",
      summary: "command exited 0",
    };
    delete record.suspectInfra;
    delete record.infra;
    return { ...check, status: "passed", record } as T;
  });
  return {
    ok: true,
    checks: reconciled,
    sidecar: reconciled.map((check) => JSON.stringify(check.record)),
    evidenceInconsistency: ALL_GREEN_VALIDATION_INCONSISTENCY,
  };
}

export function applyValidationEvidence<T extends ClassifiableCheck>(
  reportedFailed: boolean,
  checks: T[],
  sidecar: string[],
): { failed: boolean; evidenceInconsistency?: string } {
  const reconciled = reconcileValidationEvidence(reportedFailed, checks);
  checks.splice(0, checks.length, ...reconciled.checks);
  sidecar.splice(0, sidecar.length, ...reconciled.sidecar);
  return {
    failed: !reconciled.ok,
    ...(reconciled.evidenceInconsistency
      ? { evidenceInconsistency: reconciled.evidenceInconsistency }
      : {}),
  };
}
