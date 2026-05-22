/**
 * candidate-reader — pure adapter from the report-only `memory curate skills
 * --json` envelope to the `archive`-category candidates the `/curate` skill
 * acts on. Defensive on top of Memory's own filtering: even if a future
 * report leaks a `plugin`/`hub` skill into the archive list, this reader
 * drops it before consent.
 */
import {
  READ_ONLY_SOURCE_KINDS,
  type ArchiveCandidate,
  type CuratorReportEnvelope,
  type CuratorReportRecommendation,
} from "./types.js";

export interface ReadResult {
  candidates: ArchiveCandidate[];
  /** Items present in the report but filtered out (read-only or non-curatable). */
  filtered: { name: string; reason: string }[];
}

export interface ReadOptions {
  /** Set of names the orchestrator marked as pinned (skipped + reported). */
  pinned?: ReadonlySet<string>;
}

export function readArchiveCandidates(
  envelope: CuratorReportEnvelope,
  opts: ReadOptions = {},
): ReadResult {
  const pinned = opts.pinned ?? new Set<string>();
  const candidates: ArchiveCandidate[] = [];
  const filtered: { name: string; reason: string }[] = [];

  for (const rec of envelope.recommendations) {
    if (rec.category !== "archive") continue;
    if (READ_ONLY_SOURCE_KINDS.has(rec.source_kind)) {
      filtered.push({ name: rec.name, reason: `source_kind=${rec.source_kind} is read-only` });
      continue;
    }
    if (!rec.curatable) {
      filtered.push({ name: rec.name, reason: "not curatable per report" });
      continue;
    }
    if (pinned.has(rec.name)) {
      filtered.push({ name: rec.name, reason: "pinned" });
      continue;
    }
    candidates.push({
      name: rec.name,
      source_kind: rec.source_kind,
      path: rec.path,
      reason: rec.reason,
      pinned: false,
    });
  }
  return { candidates, filtered };
}

/** Parse a raw JSON string into an envelope. Throws on malformed JSON. */
export function parseCuratorReport(raw: string): CuratorReportEnvelope {
  const value = JSON.parse(raw) as Partial<CuratorReportEnvelope>;
  if (!Array.isArray(value.recommendations)) {
    throw new Error("curator report missing recommendations[]");
  }
  // Strip unknown keys defensively while keeping the typed shape.
  const recs: CuratorReportRecommendation[] = value.recommendations.map((r) => ({
    name: String(r.name),
    source_kind: String(r.source_kind),
    path: String(r.path),
    curatable: Boolean(r.curatable),
    category: String(r.category),
    reason: String(r.reason ?? ""),
  }));
  return {
    generatedAt: String(value.generatedAt ?? ""),
    staleDays: Number(value.staleDays ?? 0),
    totalSkills: Number(value.totalSkills ?? 0),
    curatableSkills: Number(value.curatableSkills ?? 0),
    readOnlySkills: Number(value.readOnlySkills ?? 0),
    recommendations: recs,
  };
}
