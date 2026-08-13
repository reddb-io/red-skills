import {
  VALIDATION_SCHEMA,
  type RunFeedbackResult,
  type ValidationRecord,
} from "../feedback.js";
import type { ProcessIssueDeps } from "./types.js";

function validationRecords(value: string | undefined): ValidationRecord[] {
  if (!value) return [];
  const records: ValidationRecord[] = [];
  for (const line of value.split("\n")) {
    try {
      const parsed = JSON.parse(line) as Partial<ValidationRecord>;
      if (
        parsed.schema === VALIDATION_SCHEMA &&
        typeof parsed.name === "string" &&
        (parsed.status === "passed" || parsed.status === "failed" || parsed.status === "skipped")
      ) {
        records.push(parsed as ValidationRecord);
      }
    } catch {
      // Scope headers and prose are not validation records.
    }
  }
  return records;
}

function hasNonValidationRecord(value: string | undefined): boolean {
  if (!value) return false;
  return value.split("\n").some((line) => {
    try {
      const parsed = JSON.parse(line) as { schema?: unknown };
      return typeof parsed.schema === "string" && parsed.schema !== VALIDATION_SCHEMA;
    } catch {
      return false;
    }
  });
}

/** Select the exact command fact that licenses a validation Park. */
export function validationBlockerSummary(value: string | undefined): string | undefined {
  const records = validationRecords(value);
  if (records.length === 0) return undefined;
  const failed = records.filter((record) => record.status === "failed");
  const contradictory = failed.find((record) => record.exitCode === 0);
  if (contradictory) {
    throw new Error(
      `validation blocker rejected: ${contradictory.name} carries exitCode 0`,
    );
  }
  if (failed.length === 0) {
    // A different structured safety finding (for example branch reversion)
    // independently licenses this Park; its formatter owns the summary.
    if (hasNonValidationRecord(value)) return undefined;
    throw new Error(
      "validation blocker rejected: park path received all-green validation evidence",
    );
  }
  const record = failed[0]!;
  if (record.command) {
    if (record.exitCode === undefined || !Number.isFinite(record.exitCode)) {
      throw new Error(
        `validation blocker rejected: ${record.name} names a command without a non-zero exitCode`,
      );
    }
    return (
      `Validation command \`${record.command}\` failed with exitCode ${record.exitCode}: ` +
      `${record.summary ?? record.name}`
    );
  }
  return record.summary ?? record.name;
}

export function reportValidationEvidenceInconsistency(
  feedback: Pick<RunFeedbackResult, "evidenceInconsistency">,
  reseedLane: string,
  deps: Pick<ProcessIssueDeps, "appendIterLog" | "recordWorkerEvent">,
): void {
  if (!feedback.evidenceInconsistency) return;
  const reason = feedback.evidenceInconsistency;
  deps.appendIterLog(`🤖 ${reseedLane}: INCONSISTENT Validation result — ${reason}.`);
  deps.recordWorkerEvent?.("worker.validation_evidence_inconsistency", {
    stage: "feedback",
    reason,
  });
}
