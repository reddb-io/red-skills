/**
 * Pure ADR triage classifier (ADR 0112, Spec #2219 / S2).
 *
 * The read-only detection pass of `/review-adrs` needs to look at every ADR
 * cheaply and say which ones carry debt. This module is that cheap pass: it
 * takes already-parsed ADR records and buckets each one from status, age,
 * inbound links, stale path references, supersession, and subject overlap.
 *
 * It moves nothing and writes nothing — the IO shell (archive `git mv`,
 * frontmatter edits, INDEX resync) lives elsewhere and consumes this report.
 */

export type AdrBucket =
  | "keep"
  | "stale-reference"
  | "missing-supersession"
  | "merge-candidate"
  | "split-candidate"
  | "archive-candidate";

const BUCKETS: readonly AdrBucket[] = [
  "keep",
  "stale-reference",
  "missing-supersession",
  "merge-candidate",
  "split-candidate",
  "archive-candidate",
];

export interface AdrRecord {
  /** Zero-padded ADR number, e.g. `"0112"`. */
  number: string;
  /** Repo-relative path of the record. */
  path: string;
  title: string;
  /** The prose under `## Status` — the supersession/deprecation signal lives here. */
  status: string;
  /** The rest of the record, from `## Context` onwards. */
  body: string;
  /** Days since the record last changed substantively. Absent reads as fresh. */
  ageDays?: number;
}

/** One INDEX.md theme section, so a subject filter can name a section. */
export interface AdrIndexSection {
  title: string;
  numbers: readonly string[];
}

export interface AdrTriageContext {
  adrs: readonly AdrRecord[];
  /**
   * Repo-relative paths that currently exist. Stale-path detection is skipped
   * entirely when absent — an empty inventory would flag every reference.
   */
  existingPaths?: readonly string[];
  indexSections?: readonly AdrIndexSection[];
  /** An unlinked ADR older than this is inert. Default 365. */
  inertAfterDays?: number;
  /** Decision points at/above which an ADR is overloaded. Default 5. */
  splitDecisionThreshold?: number;
  /** Shared title terms at/above which two ADRs cover one subject. Default 3. */
  mergeOverlapThreshold?: number;
}

export type AdrSubjectFilter =
  | { kind: "numbers"; numbers: readonly string[] }
  | { kind: "text"; query: string }
  | { kind: "index-section"; section: string };

export interface AdrTriageOptions {
  subject?: AdrSubjectFilter;
}

export interface AdrTriageEntry {
  number: string;
  path: string;
  title: string;
  bucket: AdrBucket;
  /** Machine-readable evidence, e.g. `superseded-by:0003`, `inbound-links:0`. */
  signals: string[];
  /** One line explaining the bucket to a human. */
  reason: string;
}

export interface AdrTriageSubjectReport {
  kind: AdrSubjectFilter["kind"];
  matched: string[];
  /** Requested numbers absent from the tree. Only for the `numbers` filter. */
  unmatched?: string[];
}

export interface AdrTriageReport {
  entries: AdrTriageEntry[];
  countsByBucket: Record<AdrBucket, number>;
  subject?: AdrTriageSubjectReport;
}

const DEFAULT_INERT_AFTER_DAYS = 365;
const DEFAULT_SPLIT_THRESHOLD = 5;
const DEFAULT_MERGE_OVERLAP = 3;

/** Title words too common to mean two ADRs share a subject. */
const TITLE_STOPWORDS = new Set([
  "a",
  "adr",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "one",
  "or",
  "over",
  "the",
  "to",
  "via",
  "with",
]);

// ---------------------------------------------------------------------------
// signal extraction
// ---------------------------------------------------------------------------

/** `Superseded by ADR-0112` in an ADR's own status — the terminal marker. */
function supersededBy(record: AdrRecord): string | undefined {
  return /supersed(?:ed|es)\s+by\s+(?:ADR[-\s]?)?(\d{4})/i.exec(record.status)?.[1];
}

function claimsSupersession(record: AdrRecord): boolean {
  return /supersed/i.test(record.status);
}

function isDeprecated(record: AdrRecord): boolean {
  return /\bdeprecat/i.test(record.status);
}

/** `Supersedes ADR-0004` anywhere in another record — the inbound marker. */
function supersedes(record: AdrRecord): string[] {
  const text = `${record.status}\n${record.body}`;
  return Array.from(text.matchAll(/\bsupersedes\s+(?:ADR[-\s]?)?(\d{4})/gi), (match) => match[1]!);
}

function referencesAdr(record: AdrRecord, number: string): boolean {
  const text = `${record.status}\n${record.body}`;
  return new RegExp(`\\bADR[-\\s]?${number}\\b|\\b${number}-`, "i").test(text);
}

/** Backticked tokens that look like a file path — `apps/dev/src/cli.ts`. */
function referencedPaths(record: AdrRecord): string[] {
  const text = `${record.status}\n${record.body}`;
  const quoted = Array.from(text.matchAll(/`([^`\n]+)`/g), (match) => match[1]!.trim());
  const paths = quoted.filter((token) => /^[\w.@-]+(?:\/[\w.@-]+)+$/.test(token) && /\.\w+$/.test(token));
  return Array.from(new Set(paths));
}

/** Top-level `- **Bold.**` bullets under `## Decision`. */
function decisionPoints(record: AdrRecord): number {
  const heading = /^##\s+Decision\s*$/m.exec(record.body);
  if (!heading) return 0;
  const rest = record.body.slice(heading.index + heading[0].length);
  const next = /^##\s/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;
  return Array.from(section.matchAll(/^- \*\*/gm)).length;
}

function titleTerms(record: AdrRecord): Set<string> {
  const terms = record.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1 && !TITLE_STOPWORDS.has(term) && !/^\d+$/.test(term));
  return new Set(terms);
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

interface Classification {
  bucket: AdrBucket;
  signals: string[];
  reason: string;
}

function classify(record: AdrRecord, context: AdrTriageContext): Classification {
  const inertAfterDays = context.inertAfterDays ?? DEFAULT_INERT_AFTER_DAYS;
  const splitThreshold = context.splitDecisionThreshold ?? DEFAULT_SPLIT_THRESHOLD;
  const mergeThreshold = context.mergeOverlapThreshold ?? DEFAULT_MERGE_OVERLAP;

  const others = context.adrs.filter((other) => other.number !== record.number);
  const signals: string[] = [];

  const successor = supersededBy(record);
  if (successor) signals.push(`superseded-by:${successor}`);
  if (isDeprecated(record)) signals.push("deprecated");

  const inboundSupersessions = others
    .filter((other) => supersedes(other).includes(record.number))
    .map((other) => other.number);
  const inboundLinks = others.filter((other) => referencesAdr(other, record.number)).length;
  signals.push(`inbound-links:${inboundLinks}`);

  const points = decisionPoints(record);
  signals.push(`decision-points:${points}`);

  const stalePaths = context.existingPaths
    ? referencedPaths(record).filter((path) => !context.existingPaths!.includes(path))
    : [];
  for (const path of stalePaths) signals.push(`stale-path:${path}`);

  const terms = titleTerms(record);
  const overlapping = others.filter((other) => {
    const shared = Array.from(titleTerms(other)).filter((term) => terms.has(term));
    return shared.length >= mergeThreshold;
  });
  for (const other of overlapping) signals.push(`overlaps:${other.number}`);

  const ageDays = record.ageDays ?? 0;
  signals.push(`age-days:${ageDays}`);

  // Precedence runs most-specific first: a record whose status lies about its
  // own supersession must be corrected before anything else is proposed.
  if (!successor && inboundSupersessions.length > 0) {
    for (const number of inboundSupersessions) signals.push(`superseded-without-status:${number}`);
    return {
      bucket: "missing-supersession",
      signals,
      reason: `ADR ${inboundSupersessions.join(", ")} supersedes this record, but its status never says so.`,
    };
  }

  if (!successor && claimsSupersession(record)) {
    signals.push("successor-unnamed");
    return {
      bucket: "missing-supersession",
      signals,
      reason: "Status claims supersession without naming the successor ADR.",
    };
  }

  if (successor) {
    return {
      bucket: "archive-candidate",
      signals,
      reason: `Superseded by ADR-${successor}; terminal record, safe to archive.`,
    };
  }

  if (isDeprecated(record)) {
    return { bucket: "archive-candidate", signals, reason: "Deprecated; terminal record, safe to archive." };
  }

  if (ageDays >= inertAfterDays && inboundLinks === 0) {
    return {
      bucket: "archive-candidate",
      signals,
      reason: `Inert: ${ageDays} days old and no ADR links to it.`,
    };
  }

  if (points >= splitThreshold) {
    return {
      bucket: "split-candidate",
      signals,
      reason: `Carries ${points} distinct decisions; a focused split reads better.`,
    };
  }

  if (overlapping.length > 0) {
    const partners = overlapping.map((other) => other.number).join(", ");
    return {
      bucket: "merge-candidate",
      signals,
      reason: `Shares its subject with ADR ${partners}; consider consolidating.`,
    };
  }

  if (stalePaths.length > 0) {
    return {
      bucket: "stale-reference",
      signals,
      reason: `Cites path(s) that no longer exist: ${stalePaths.join(", ")}.`,
    };
  }

  return { bucket: "keep", signals, reason: "Live decision with no detected debt." };
}

// ---------------------------------------------------------------------------
// subject filter
// ---------------------------------------------------------------------------

function matchesSubject(record: AdrRecord, subject: AdrSubjectFilter, context: AdrTriageContext): boolean {
  if (subject.kind === "numbers") return subject.numbers.includes(record.number);

  if (subject.kind === "text") {
    const haystack = `${record.title}\n${record.path}\n${record.status}\n${record.body}`.toLowerCase();
    const tokens = subject.query.toLowerCase().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
  }

  const section = (context.indexSections ?? []).find(
    (candidate) => candidate.title.toLowerCase() === subject.section.toLowerCase(),
  );
  return section ? section.numbers.includes(record.number) : false;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Bucket every ADR in the tree, optionally reporting only a subject-filtered
 * subset. Classification always runs against the whole tree — supersession and
 * inbound links are cross-record signals, so a narrow filter must never change
 * an ADR's bucket, only which buckets you are shown.
 */
export function triageAdrs(context: AdrTriageContext, options: AdrTriageOptions = {}): AdrTriageReport {
  const classified = context.adrs.map((record) => ({ record, ...classify(record, context) }));
  const subject = options.subject;
  const scoped = subject
    ? classified.filter((item) => matchesSubject(item.record, subject, context))
    : classified;

  const entries: AdrTriageEntry[] = scoped.map((item) => ({
    number: item.record.number,
    path: item.record.path,
    title: item.record.title,
    bucket: item.bucket,
    signals: item.signals,
    reason: item.reason,
  }));

  const countsByBucket = Object.fromEntries(
    BUCKETS.map((bucket) => [bucket, entries.filter((entry) => entry.bucket === bucket).length]),
  ) as Record<AdrBucket, number>;

  const report: AdrTriageReport = { entries, countsByBucket };

  if (subject) {
    const matched = entries.map((entry) => entry.number);
    report.subject =
      subject.kind === "numbers"
        ? {
            kind: subject.kind,
            matched,
            unmatched: subject.numbers.filter(
              (number) => !context.adrs.some((record) => record.number === number),
            ),
          }
        : { kind: subject.kind, matched };
  }

  return report;
}
