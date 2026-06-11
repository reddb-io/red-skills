/**
 * The Code drift report (ADR 0035, issue #307) is read-only visibility over
 * engineering codes that are not in the suggested vocabulary. It groups unknown
 * codes by recurrence count so repeat codes can be considered for promotion or
 * aliasing while one-off noise remains visible.
 *
 * Unknown engineering codes are never rejected, quarantined, or excluded from
 * recall. This module is the pure aggregation core: no store, no I/O, no
 * mutation.
 */

import {
  EXTRACTION_SCHEMA_VERSION,
  SUGGESTED_ENGINEERING_CODES,
  isSuggestedEngineeringCode,
  normalizeEngineeringCode,
} from "./extraction-schema.js";
import type { EngineeringCodeCurationState } from "./code-curation.js";

/** Two or more occurrences make a code recurring rather than one-off. */
export const DEFAULT_RECURRING_THRESHOLD = 2;

/** One aggregated unknown engineering code. */
export interface CodeDriftEntry {
  /** Normalized kebab-case slug, matching the stored engineering-code form. */
  code: string;
  /** How many coded nodes carry this value. */
  count: number;
  /** Recurring codes are promotion/alias candidates; one-off codes are noise. */
  recurrence: "recurring" | "one-off";
}

/** Unknown engineering codes grouped by their exact recurrence count. */
export interface CodeDriftCountGroup {
  /** Shared recurrence count for every code in this group. */
  count: number;
  /** Recurrence class for this count under the configured threshold. */
  recurrence: "recurring" | "one-off";
  /** Codes with this recurrence count, sorted alphabetically. */
  codes: string[];
}

/** The full read-only code drift report. */
export interface CodeDriftReport {
  /** Version of the extraction schema whose suggested vocabulary was used. */
  schemaVersion: string;
  /** Version of the suggested engineering-code vocabulary, including curation. */
  suggestedVersion: string;
  /** Recurrence threshold used to split recurring from one-off. */
  recurringThreshold: number;
  /** Number of nodes carrying a non-blank engineering code. */
  totalCoded: number;
  /** Coded nodes whose code is in the suggested vocabulary. */
  knownCount: number;
  /** Coded nodes whose code is outside the suggested vocabulary. */
  unknownCount: number;
  /** Distinct unknown codes. */
  distinctUnknown: number;
  /** Every unknown code, sorted by count desc then code asc. */
  entries: CodeDriftEntry[];
  /** Unknown codes grouped by exact recurrence count. */
  groups: CodeDriftCountGroup[];
  /** Unknown codes that meet the recurring threshold. */
  recurring: CodeDriftEntry[];
  /** Unknown codes below the recurring threshold. */
  oneOff: CodeDriftEntry[];
}

export interface CodeDriftOptions {
  /** Override the recurrence threshold. Values below 2 are clamped to 2. */
  recurringThreshold?: number;
  /** Override the suggested-vocabulary predicate for tests or future callers. */
  isSuggested?: (code: string) => boolean;
  /** Resolve aliases before known/unknown grouping. Aliasing is explicit curation. */
  canonicalize?: (code: string) => string;
  /** Curation metadata used to report the suggested vocabulary version. */
  curation?: EngineeringCodeCurationState;
}

/**
 * Aggregate engineering codes into a read-only drift report.
 *
 * Pass each code once per node occurrence. Blank or punctuation-only values are
 * ignored. Codes are normalized before counting, so variants such as
 * `Root Cause`, `root-cause`, and `ROOT_CAUSE` collapse to one code.
 */
export function buildCodeDriftReport(
  codes: Iterable<string | null | undefined>,
  options: CodeDriftOptions = {},
): CodeDriftReport {
  const threshold = Math.max(2, options.recurringThreshold ?? DEFAULT_RECURRING_THRESHOLD);
  const isSuggested = options.isSuggested ?? isSuggestedEngineeringCode;
  const canonicalize = options.canonicalize ?? normalizeEngineeringCode;

  let totalCoded = 0;
  let knownCount = 0;
  const unknownCounts = new Map<string, number>();

  for (const raw of codes) {
    if (typeof raw !== "string") continue;
    const code = canonicalize(raw);
    if (!code) continue;
    totalCoded += 1;
    if (isSuggested(code)) {
      knownCount += 1;
      continue;
    }
    unknownCounts.set(code, (unknownCounts.get(code) ?? 0) + 1);
  }

  const entries: CodeDriftEntry[] = [...unknownCounts.entries()]
    .map(([code, count]) => ({
      code,
      count,
      recurrence: recurrenceFor(count, threshold),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  const groups = groupByCount(entries);
  const unknownCount = entries.reduce((sum, entry) => sum + entry.count, 0);

  return {
    schemaVersion: EXTRACTION_SCHEMA_VERSION,
    suggestedVersion: options.curation?.suggestedVersion ?? EXTRACTION_SCHEMA_VERSION,
    recurringThreshold: threshold,
    totalCoded,
    knownCount,
    unknownCount,
    distinctUnknown: entries.length,
    entries,
    groups,
    recurring: entries.filter((entry) => entry.recurrence === "recurring"),
    oneOff: entries.filter((entry) => entry.recurrence === "one-off"),
  };
}

function recurrenceFor(count: number, threshold: number): CodeDriftEntry["recurrence"] {
  return count >= threshold ? "recurring" : "one-off";
}

function groupByCount(entries: CodeDriftEntry[]): CodeDriftCountGroup[] {
  const byCount = new Map<number, CodeDriftCountGroup>();
  for (const entry of entries) {
    const existing = byCount.get(entry.count);
    if (existing) {
      existing.codes.push(entry.code);
      continue;
    }
    byCount.set(entry.count, {
      count: entry.count,
      recurrence: entry.recurrence,
      codes: [entry.code],
    });
  }
  return [...byCount.values()].map((group) => ({ ...group, codes: group.codes.sort() }));
}

/** Suggested vocabulary size, useful for report headers. */
export const SUGGESTED_CODE_COUNT = SUGGESTED_ENGINEERING_CODES.length;
