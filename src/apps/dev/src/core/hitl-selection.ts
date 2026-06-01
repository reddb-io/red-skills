export interface HitlCandidate {
  number: number;
  title: string;
  body: string;
  labels: string[];
  createdAt?: string | null;
}

export interface HitlSelectionOptions {
  skipped?: readonly number[];
}

const LABEL_HUMAN = "ready-for-human";
const LABEL_PRD = "type:prd";
const LABEL_URGENT = "priority:urgent";
const LABEL_HIGH = "priority:high";

function hasLabel(candidate: HitlCandidate, label: string): boolean {
  return candidate.labels.includes(label);
}

function priorityRank(candidate: HitlCandidate): number {
  if (hasLabel(candidate, LABEL_URGENT)) return 0;
  if (hasLabel(candidate, LABEL_HIGH)) return 1;
  return 2;
}

function createdAtMs(candidate: HitlCandidate): number | null {
  if (!candidate.createdAt) return null;
  const ms = Date.parse(candidate.createdAt);
  return Number.isFinite(ms) ? ms : null;
}

function compareAgeThenNumber(a: HitlCandidate, b: HitlCandidate): number {
  const ams = createdAtMs(a);
  const bms = createdAtMs(b);
  if (ams !== null && bms !== null && ams !== bms) return ams - bms;
  return a.number - b.number;
}

/** Select the operator-facing HITL queue: open non-PRD ready-for-human Issues,
 * sorted by urgency/high priority first and oldest first inside each band. */
export function selectHitlQueue(candidates: readonly HitlCandidate[]): HitlCandidate[] {
  return candidates
    .filter((candidate) => hasLabel(candidate, LABEL_HUMAN))
    .filter((candidate) => !hasLabel(candidate, LABEL_PRD))
    .sort((a, b) => {
      const prio = priorityRank(a) - priorityRank(b);
      if (prio !== 0) return prio;
      return compareAgeThenNumber(a, b);
    });
}

/** Recommend the first HITL queue item that has not been skipped in this
 * maintainer session. The caller owns prompting; this function owns ordering. */
export function recommendHitlIssue(
  candidates: readonly HitlCandidate[],
  options: HitlSelectionOptions = {},
): HitlCandidate | null {
  const skipped = new Set(options.skipped ?? []);
  return selectHitlQueue(candidates).find((candidate) => !skipped.has(candidate.number)) ?? null;
}
