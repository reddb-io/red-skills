/**
 * Pure ADR triage classifier (ADR 0127, superseding ADR 0112).
 *
 * The detection pass of `/adr-editor` needs to look at every ADR cheaply and
 * say which ones carry debt. This module is that cheap pass: it takes
 * already-parsed ADR records and answers three read-only questions — which
 * bucket each record falls in (`triageAdrs`), how the collection clusters by
 * subject (`groupAdrs`), and where the collection contradicts itself
 * (`detectAdrInconsistencies`).
 *
 * It moves nothing and writes nothing — the IO shell (archive `git mv`,
 * frontmatter edits, INDEX resync) lives elsewhere and consumes these reports.
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
  /**
   * ADR numbers documented as bullets in `.red/adr/INDEX.md`. Index-drift
   * detection is skipped entirely when absent — an empty list would report
   * every record as undocumented.
   */
  indexNumbers?: readonly string[];
  /** @deprecated Age is evidence to inspect, never a terminal disposition. */
  inertAfterDays?: number;
  /** Decision points at/above which an ADR is overloaded. Default 5. */
  splitDecisionThreshold?: number;
  /** Shared title terms at/above which two ADRs cover one subject. Default 3. */
  mergeOverlapThreshold?: number;
  /** Current code, test, documentation, and newer-ADR evidence gathered by the caller. */
  candidateEvidence?: readonly AdrCandidateEvidence[];
  /** Visible INDEX review annotations parsed by the caller. */
  reviewMarkers?: readonly AdrReviewMarker[];
}

export type AdrCandidateEvidenceKind = "code" | "test" | "documentation" | "newer-adr";

export interface AdrCandidateEvidence {
  kind: AdrCandidateEvidenceKind;
  path: string;
  detail: string;
  numbers: readonly string[];
  /** Git-aware callers set this only when the evidence changed after the recorded review SHA. */
  changedSinceReview: boolean;
}

export interface AdrReviewMarker {
  number: string;
  reviewedOn: string;
  baseSha: string;
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

/**
 * The phrase that names THIS record's successor — `Superseded by ADR-0112`,
 * `Superseded-by: 0112`. Direction is the whole point: a status that says the
 * record *supersedes* something else is the forward end of a chain and reveals
 * nothing about the record's own fate.
 */
const SUPERSEDED_BY = "supersed(?:ed|es)[-\\s]+by\\b";

/** Emphasis and punctuation a real header puts between the phrase and its target — `**Superseded by**: #2417`. */
const POINTER_GAP = "[\\s*_:\\-]*";

/** A bare terminal `Superseded` — the word standing alone, naming nobody. */
const TERMINAL_SUPERSEDED = /\bsuperseded\b[*_`)\s]*[.;,]?\s*$/im;

/** `Superseded by ADR-0112` in an ADR's own status — the terminal marker. */
function supersededBy(record: AdrRecord): string | undefined {
  return new RegExp(`${SUPERSEDED_BY}${POINTER_GAP}\\[?\\s*(?:ADR[-\\s]?)?(\\d{4})`, "i").exec(record.status)?.[1];
}

/**
 * The successor a pointer names when that successor is not an ADR — an issue,
 * a PR, or a URL. A decision is only superseded by another decision, so this
 * counts as debt, never as a resolved supersession.
 */
function nonAdrSuccessor(record: AdrRecord): string | undefined {
  if (supersededBy(record)) return undefined;
  const token = new RegExp(`${SUPERSEDED_BY}${POINTER_GAP}(#\\d+|https?://\\S+)`, "i").exec(record.status)?.[1];
  return token?.replace(/[.,;:)\]]+$/, "");
}

/**
 * True only when the status says THIS record IS superseded: a `superseded by`
 * pointer, or a terminal `Superseded` standing alone. Merely naming a record
 * this one supersedes is what a healthy successor reads like, so it is never a
 * claim — reading it as one flags every live successor as broken.
 */
function claimsSupersession(record: AdrRecord): boolean {
  return new RegExp(SUPERSEDED_BY, "i").test(record.status) || TERMINAL_SUPERSEDED.test(record.status);
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

/** Backticked tokens that look like a file path — `apps/plugin-dev/src/cli.ts`. */
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
    const nonAdr = nonAdrSuccessor(record);
    signals.push(nonAdr ? `successor-not-adr:${nonAdr}` : "successor-unnamed");
    return {
      bucket: "missing-supersession",
      signals,
      reason: nonAdr
        ? `Status names ${nonAdr} as successor, which is not an ADR; a decision is superseded only by another decision.`
        : "Status says this record is superseded without naming the successor ADR.",
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

// ---------------------------------------------------------------------------
// grouping
// ---------------------------------------------------------------------------

export type AdrGroupKind = "index-section" | "subject-cluster";

export interface AdrGroup {
  kind: AdrGroupKind;
  /** The INDEX section heading, or the shared terms that formed the cluster. */
  title: string;
  numbers: string[];
}

export interface AdrGroupReport {
  groups: AdrGroup[];
  /** Records in no INDEX section and in no multi-record subject cluster. */
  ungrouped: string[];
  subject?: AdrTriageSubjectReport;
}

/** Merge indices into disjoint sets — the cluster spine for subject grouping. */
function unionFind(size: number): { union(a: number, b: number): void; find(a: number): number } {
  const parent = Array.from({ length: size }, (_unused, index) => index);
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root]!;
    let cursor = a;
    while (parent[cursor] !== root) {
      const next = parent[cursor]!;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  return {
    find,
    union(a, b) {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
    },
  };
}

/** Name a cluster by the terms most of its members share, most common first. */
function clusterTitle(records: readonly AdrRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const term of titleTerms(record)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  const shared = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([term]) => term);
  return shared.length > 0 ? shared.join(" + ") : "unnamed cluster";
}

/**
 * Cluster the whole tree by subject: INDEX theme sections first, then the
 * records no section claims, clustered by shared title terms.
 *
 * Grouping always runs over the whole tree — a cluster is a cross-record fact,
 * so a subject filter narrows only which numbers are reported back, exactly as
 * it does in `triageAdrs`.
 */
export function groupAdrs(context: AdrTriageContext, options: AdrTriageOptions = {}): AdrGroupReport {
  const subject = options.subject;
  const inScope = (number: string): boolean => {
    if (!subject) return true;
    const record = context.adrs.find((candidate) => candidate.number === number);
    return record ? matchesSubject(record, subject, context) : false;
  };

  const mergeThreshold = context.mergeOverlapThreshold ?? DEFAULT_MERGE_OVERLAP;
  const present = new Set(context.adrs.map((record) => record.number));
  const sectioned = new Set<string>();
  const groups: AdrGroup[] = [];

  for (const section of context.indexSections ?? []) {
    const numbers = section.numbers.filter((number) => present.has(number));
    for (const number of numbers) sectioned.add(number);
    const scoped = numbers.filter(inScope);
    if (scoped.length > 0) groups.push({ kind: "index-section", title: section.title, numbers: scoped });
  }

  const loose = context.adrs.filter((record) => !sectioned.has(record.number));
  const sets = unionFind(loose.length);
  for (let a = 0; a < loose.length; a += 1) {
    const terms = titleTerms(loose[a]!);
    for (let b = a + 1; b < loose.length; b += 1) {
      const shared = Array.from(titleTerms(loose[b]!)).filter((term) => terms.has(term));
      if (shared.length >= mergeThreshold) sets.union(a, b);
    }
  }

  const clusters = new Map<number, AdrRecord[]>();
  for (let index = 0; index < loose.length; index += 1) {
    const root = sets.find(index);
    const members = clusters.get(root) ?? [];
    members.push(loose[index]!);
    clusters.set(root, members);
  }

  const ungrouped: string[] = [];
  for (const members of clusters.values()) {
    const numbers = members.map((record) => record.number).filter(inScope);
    if (numbers.length === 0) continue;
    if (members.length < 2) {
      ungrouped.push(...numbers);
      continue;
    }
    groups.push({ kind: "subject-cluster", title: clusterTitle(members), numbers });
  }
  ungrouped.sort();

  const report: AdrGroupReport = { groups, ungrouped };
  if (subject) {
    const matched = [...groups.flatMap((group) => group.numbers), ...ungrouped].sort();
    report.subject =
      subject.kind === "numbers"
        ? {
            kind: subject.kind,
            matched,
            unmatched: subject.numbers.filter((number) => !present.has(number)),
          }
        : { kind: subject.kind, matched };
  }
  return report;
}

// ---------------------------------------------------------------------------
// reverse-grill cluster ranking
// ---------------------------------------------------------------------------

export type AdrClusterRecommendation = "review-now" | "review-next" | "defer-until-new-evidence";

export interface AdrRankedCluster {
  rank: number;
  title: string;
  numbers: string[];
  evidence: AdrCandidateEvidence[];
  hasNewEvidence: boolean;
  recommendation: AdrClusterRecommendation;
  /** Deterministic ordering aid, not a disposition or replacement for maintainer judgment. */
  score: number;
}

export interface AdrClusterRankingReport {
  clusters: AdrRankedCluster[];
  excludedArchived: string[];
}

function isArchivedPath(path: string): boolean {
  return /^\.red\/adr\/archive\//.test(path);
}

/**
 * Rank active ADR clusters for the reverse grill. The helper emits candidate
 * evidence and a stable place to start; it never chooses an ADR disposition.
 * Archived records are deliberately absent from both clustering and evidence.
 */
export function rankAdrClusters(context: AdrTriageContext): AdrClusterRankingReport {
  const activeAdrs = context.adrs.filter((record) => !isArchivedPath(record.path));
  const activeNumbers = new Set(activeAdrs.map((record) => record.number));
  const excludedArchived = context.adrs
    .filter((record) => isArchivedPath(record.path))
    .map((record) => record.number)
    .sort();
  const activeContext: AdrTriageContext = {
    ...context,
    adrs: activeAdrs,
    indexSections: context.indexSections?.map((section) => ({
      ...section,
      numbers: section.numbers.filter((number) => activeNumbers.has(number)),
    })),
  };
  const grouped = groupAdrs(activeContext);
  const clusterSeeds = [
    ...grouped.groups.map((group) => ({ title: group.title, numbers: group.numbers })),
    ...grouped.ungrouped.map((number) => ({
      title: activeAdrs.find((record) => record.number === number)?.title ?? `ADR ${number}`,
      numbers: [number],
    })),
  ];
  const reviewMarkers = new Set((context.reviewMarkers ?? []).map((marker) => marker.number));

  const scored = clusterSeeds.map((seed) => {
    const numberSet = new Set(seed.numbers);
    const evidence = (context.candidateEvidence ?? [])
      .filter((item) => item.numbers.some((number) => numberSet.has(number)))
      .map((item) => ({
        ...item,
        numbers: item.numbers.filter((number) => numberSet.has(number) && activeNumbers.has(number)),
      }))
      .filter((item) => item.numbers.length > 0);
    const hasNewEvidence = evidence.some((item) => item.changedSinceReview);
    const reviewed = seed.numbers.every((number) => reviewMarkers.has(number));
    const triageWeight = triageAdrs(activeContext, {
      subject: { kind: "numbers", numbers: seed.numbers },
    }).entries.reduce((score, entry) => score + (entry.bucket === "keep" ? 0 : 5), 0);
    const score = (hasNewEvidence ? 100 : 0) + (reviewed ? 0 : 20) + triageWeight + evidence.length;
    const recommendation: AdrClusterRecommendation = reviewed && !hasNewEvidence
      ? "defer-until-new-evidence"
      : hasNewEvidence
        ? "review-now"
        : "review-next";
    return { ...seed, evidence, hasNewEvidence, recommendation, score };
  });

  scored.sort(
    (a, b) => b.score - a.score || a.numbers[0]!.localeCompare(b.numbers[0]!) || a.title.localeCompare(b.title),
  );
  return {
    clusters: scored.map((cluster, index) => ({ rank: index + 1, ...cluster })),
    excludedArchived,
  };
}

// ---------------------------------------------------------------------------
// inconsistency detection
// ---------------------------------------------------------------------------

export type AdrInconsistencyKind =
  | "numbering-collision"
  | "dangling-supersede"
  | "supersession-cycle"
  | "index-drift"
  | "missing-supersession"
  | "stale-path"
  | "subject-overlap";

const INCONSISTENCY_KINDS: readonly AdrInconsistencyKind[] = [
  "numbering-collision",
  "dangling-supersede",
  "supersession-cycle",
  "index-drift",
  "missing-supersession",
  "stale-path",
  "subject-overlap",
];

export interface AdrInconsistency {
  kind: AdrInconsistencyKind;
  /** Every ADR number the finding implicates, ascending. */
  numbers: string[];
  /** One line a human can act on. */
  detail: string;
}

export interface AdrInconsistencyReport {
  inconsistencies: AdrInconsistency[];
  countsByKind: Record<AdrInconsistencyKind, number>;
  subject?: AdrTriageSubjectReport;
}

function isTerminal(record: AdrRecord): boolean {
  return Boolean(supersededBy(record)) || isDeprecated(record);
}

/**
 * Report every way the collection contradicts itself: duplicate numbers,
 * supersede pointers with no target, mutual supersession, INDEX drift,
 * unrecorded supersession, stale paths, and overlapping subjects.
 *
 * Detection is cross-record by nature and therefore always runs over the whole
 * tree; a subject filter keeps only findings that implicate a matched record.
 */
export function detectAdrInconsistencies(
  context: AdrTriageContext,
  options: AdrTriageOptions = {},
): AdrInconsistencyReport {
  const mergeThreshold = context.mergeOverlapThreshold ?? DEFAULT_MERGE_OVERLAP;
  const present = new Set(context.adrs.map((record) => record.number));
  const found: AdrInconsistency[] = [];

  const seen = new Set<string>();
  const collided = new Set<string>();
  for (const record of context.adrs) {
    if (seen.has(record.number)) collided.add(record.number);
    seen.add(record.number);
  }
  for (const number of [...collided].sort()) {
    const paths = context.adrs.filter((record) => record.number === number).map((record) => record.path);
    found.push({
      kind: "numbering-collision",
      numbers: [number],
      detail: `ADR number ${number} is claimed by ${paths.length} records: ${paths.join(", ")}.`,
    });
  }

  for (const record of context.adrs) {
    const pointers = new Set<string>([...(supersededBy(record) ? [supersededBy(record)!] : []), ...supersedes(record)]);
    for (const pointer of [...pointers].sort()) {
      if (present.has(pointer)) continue;
      found.push({
        kind: "dangling-supersede",
        numbers: [record.number],
        detail: `ADR ${record.number} points at ADR ${pointer}, which is not in the tree.`,
      });
    }
  }

  for (const record of context.adrs) {
    const successor = supersededBy(record);
    if (!successor || successor <= record.number) continue;
    const other = context.adrs.find((candidate) => candidate.number === successor);
    if (other && supersededBy(other) === record.number) {
      found.push({
        kind: "supersession-cycle",
        numbers: [record.number, successor],
        detail: `ADR ${record.number} and ADR ${successor} each declare the other their successor.`,
      });
    }
  }

  if (context.indexNumbers) {
    const documented = new Set(context.indexNumbers);
    for (const number of [...present].sort()) {
      if (!documented.has(number)) {
        found.push({
          kind: "index-drift",
          numbers: [number],
          detail: `ADR ${number} exists in the tree but has no INDEX bullet.`,
        });
      }
    }
    for (const number of [...documented].sort()) {
      if (!present.has(number)) {
        found.push({
          kind: "index-drift",
          numbers: [number],
          detail: `INDEX documents ADR ${number}, which is not in the tree.`,
        });
      }
    }
  }

  for (const record of context.adrs) {
    const classification = classify(record, context);
    if (classification.bucket === "missing-supersession") {
      found.push({ kind: "missing-supersession", numbers: [record.number], detail: classification.reason });
    }
    if (!context.existingPaths) continue;
    const stale = referencedPaths(record).filter((path) => !context.existingPaths!.includes(path));
    for (const path of stale) {
      found.push({
        kind: "stale-path",
        numbers: [record.number],
        detail: `ADR ${record.number} cites \`${path}\`, which no longer exists.`,
      });
    }
  }

  const live = context.adrs.filter((record) => !isTerminal(record));
  for (let a = 0; a < live.length; a += 1) {
    const terms = titleTerms(live[a]!);
    for (let b = a + 1; b < live.length; b += 1) {
      const shared = Array.from(titleTerms(live[b]!)).filter((term) => terms.has(term));
      if (shared.length < mergeThreshold) continue;
      const numbers = [live[a]!.number, live[b]!.number].sort();
      found.push({
        kind: "subject-overlap",
        numbers,
        detail: `ADR ${numbers[0]} and ADR ${numbers[1]} share the subject terms ${shared.sort().join(", ")}.`,
      });
    }
  }

  const subject = options.subject;
  const scoped = subject
    ? found.filter((finding) =>
        finding.numbers.some((number) => {
          const record = context.adrs.find((candidate) => candidate.number === number);
          return record ? matchesSubject(record, subject, context) : false;
        }),
      )
    : found;

  const inconsistencies = scoped
    .slice()
    .sort(
      (a, b) =>
        INCONSISTENCY_KINDS.indexOf(a.kind) - INCONSISTENCY_KINDS.indexOf(b.kind) ||
        a.numbers.join().localeCompare(b.numbers.join()) ||
        a.detail.localeCompare(b.detail),
    );

  const countsByKind = Object.fromEntries(
    INCONSISTENCY_KINDS.map((kind) => [kind, inconsistencies.filter((finding) => finding.kind === kind).length]),
  ) as Record<AdrInconsistencyKind, number>;

  const report: AdrInconsistencyReport = { inconsistencies, countsByKind };
  if (subject) {
    const matched = [...new Set(inconsistencies.flatMap((finding) => finding.numbers))].sort();
    report.subject =
      subject.kind === "numbers"
        ? {
            kind: subject.kind,
            matched,
            unmatched: subject.numbers.filter((number) => !present.has(number)),
          }
        : { kind: subject.kind, matched };
  }
  return report;
}
