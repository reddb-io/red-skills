import {
  recall as graphRecall,
  type RecallOptions,
  type RecallStore,
  type RecalledNode,
} from "./engine.js";
import { tokenize } from "./recall.js";
import type { SkillRollup } from "./skill-events.js";

export type SkillRecommendationEvidenceKind = "memory" | "telemetry";
export type SkillEvidenceStrength = "strong" | "moderate" | "weak" | "missing";

export type SkillRecommendationRecalledNode = Pick<
  RecalledNode,
  "rid" | "label" | "node_type" | "score" | "properties" | "excerpt"
>;

export interface SkillRecommendationCitation {
  marker: string;
  kind: SkillRecommendationEvidenceKind;
  urn: string;
  title: string;
  detail: string;
}

export interface SkillRecommendation {
  name: string;
  sourceKind: string | null;
  path: string | null;
  score: number;
  confidence: "high" | "medium" | "low";
  evidenceStrength: SkillEvidenceStrength;
  reasons: string[];
  citations: SkillRecommendationCitation[];
}

export interface SkillRecommendationReport {
  task: string;
  status: "ok" | "insufficient-evidence";
  recommendations: SkillRecommendation[];
  missingEvidence: string[];
}

export interface BuildSkillRecommendationsOptions extends Pick<RecallOptions, "scope" | "now"> {
  limit?: number;
  depth?: number;
  skillRollups?: readonly SkillRollup[];
}

export async function buildSkillRecommendations(
  store: RecallStore,
  task: string,
  opts: BuildSkillRecommendationsOptions = {},
): Promise<SkillRecommendationReport> {
  const recalled = await graphRecall(store, task, {
    k: opts.limit ?? 12,
    depth: opts.depth ?? 1,
    scope: opts.scope,
    now: opts.now,
  });
  return buildSkillRecommendationsFromEvidence(
    task,
    recalled.nodes,
    opts.skillRollups ?? [],
    opts.limit ?? 5,
  );
}

export function renderSkillRecommendationsSection(report: SkillRecommendationReport): string {
  const lines = ["## Skill recommendations"];
  if (report.recommendations.length === 0) {
    lines.push("- No ranked RedSkills recommendation. Evidence: missing or weak.");
    for (const item of report.missingEvidence) lines.push(`  - ${item}`);
    return `${lines.join("\n")}\n`;
  }

  for (const recommendation of report.recommendations) {
    const source = recommendation.sourceKind ? `, ${recommendation.sourceKind}` : "";
    lines.push(
      `- ${recommendation.name} (${recommendation.confidence} confidence, ${recommendation.evidenceStrength} evidence${source}; score ${recommendation.score.toFixed(4)})`,
    );
    if (recommendation.path) lines.push(`  Path: ${recommendation.path}`);
    lines.push(`  Why: ${recommendation.reasons.join("; ")}`);
    lines.push(
      `  Citations: ${recommendation.citations.map((citation) => citation.marker).join(" ") || "none"}`,
    );
  }

  const citationLines = report.recommendations.flatMap(
    (recommendation) => recommendation.citations,
  );
  if (citationLines.length > 0) {
    lines.push("");
    lines.push("Skill recommendation citations");
    for (const citation of citationLines) {
      lines.push(
        `- ${citation.marker} ${citation.urn} (${citation.kind}) ${citation.title}: ${citation.detail}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

interface Candidate {
  name: string;
  sourceKind: string | null;
  path: string | null;
  score: number;
  reasons: Set<string>;
  citations: SkillRecommendationCitation[];
  hasMemory: boolean;
  hasTelemetry: boolean;
}

export function buildSkillRecommendationsFromEvidence(
  task: string,
  memoryEvidence: readonly SkillRecommendationRecalledNode[],
  telemetry: readonly SkillRollup[] = [],
  limit = 5,
): SkillRecommendationReport {
  const candidates = new Map<string, Candidate>();
  let memoryMarker = 1;
  let telemetryMarker = 1;

  for (const node of memoryEvidence) {
    const skillNames = skillNamesFromNode(node);
    for (const name of skillNames) {
      const candidate = candidateFor(candidates, name, null, null);
      candidate.score += 1 + node.score;
      candidate.hasMemory = true;
      candidate.reasons.add(
        `Memory evidence [M${memoryMarker}] names this skill for a similar task`,
      );
      candidate.citations.push({
        marker: `[M${memoryMarker}]`,
        kind: "memory",
        urn: `memory_nodes:${node.rid}`,
        title: node.properties.title ?? node.label,
        detail: normalizeEvidence(node.excerpt || node.properties.summary || node.properties.content || ""),
      });
    }
    if (skillNames.length > 0) memoryMarker += 1;
  }

  for (const rollup of telemetry) {
    const matchScore = taskMatchScore(task, [rollup.name, rollup.path]);
    const existing = candidates.get(rollup.name);
    if (matchScore <= 0 && !existing) continue;

    const candidate = candidateFor(candidates, rollup.name, rollup.source_kind, rollup.path);
    candidate.score += (matchScore > 0 ? 1.5 + matchScore : 0.75) + telemetryQualityScore(rollup);
    candidate.hasTelemetry = true;
    if (matchScore > 0) candidate.reasons.add("task text matched the skill name or path");
    candidate.reasons.add(
      `Skill telemetry shows ${rollup.event_count} event(s), ${rollup.use_count} use(s), and ${rollup.result_count} result(s)`,
    );
    candidate.citations.push({
      marker: `[T${telemetryMarker++}]`,
      kind: "telemetry",
      urn: `skill-telemetry:${rollup.source_kind}:${rollup.name}`,
      title: `${rollup.name} telemetry`,
      detail: telemetryDetail(rollup),
    });
  }

  const recommendations = [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(0, limit))
    .map(toRecommendation);

  const missingEvidence: string[] = [];
  if (memoryEvidence.length === 0) missingEvidence.push("no Memory evidence matched this task");
  if (telemetry.length === 0) missingEvidence.push("no Skill telemetry rollups are available");
  if (recommendations.length === 0) {
    missingEvidence.push("no RedSkills skill names matched the task text or recalled evidence");
  }

  return {
    task,
    status: recommendations.length > 0 ? "ok" : "insufficient-evidence",
    recommendations,
    missingEvidence,
  };
}

function candidateFor(
  candidates: Map<string, Candidate>,
  name: string,
  sourceKind: string | null,
  path: string | null,
): Candidate {
  const existing = candidates.get(name);
  if (existing) {
    existing.sourceKind ??= sourceKind;
    existing.path ??= path;
    return existing;
  }
  const candidate: Candidate = {
    name,
    sourceKind,
    path,
    score: 0,
    reasons: new Set(),
    citations: [],
    hasMemory: false,
    hasTelemetry: false,
  };
  candidates.set(name, candidate);
  return candidate;
}

function toRecommendation(candidate: Candidate): SkillRecommendation {
  const evidenceStrength = strength(candidate);
  return {
    name: candidate.name,
    sourceKind: candidate.sourceKind,
    path: candidate.path,
    score: Number(candidate.score.toFixed(4)),
    confidence:
      evidenceStrength === "strong" ? "high" : evidenceStrength === "moderate" ? "medium" : "low",
    evidenceStrength,
    reasons: [...candidate.reasons],
    citations: candidate.citations,
  };
}

function strength(candidate: Candidate): SkillEvidenceStrength {
  if (candidate.hasMemory && candidate.hasTelemetry) return "strong";
  if (candidate.hasMemory || candidate.hasTelemetry) return "moderate";
  return "missing";
}

function taskMatchScore(task: string, fields: readonly string[]): number {
  const taskTokens = new Set(tokenize(task));
  if (taskTokens.size === 0) return 0;
  let score = 0;
  for (const field of fields) {
    for (const token of tokenize(field)) {
      if (taskTokens.has(token)) score += 1;
    }
  }
  return score;
}

function telemetryQualityScore(rollup: SkillRollup): number {
  const succeeded = rollup.outcome_counts.succeeded ?? 0;
  const failed = rollup.outcome_counts.failed ?? 0;
  const resultTotal = succeeded + failed;
  const successRatio = resultTotal > 0 ? succeeded / resultTotal : 0;
  return Math.min(2, rollup.use_count * 0.25 + rollup.result_count * 0.2 + successRatio);
}

function telemetryDetail(rollup: SkillRollup): string {
  const succeeded = rollup.outcome_counts.succeeded ?? 0;
  const failed = rollup.outcome_counts.failed ?? 0;
  return `${rollup.event_count} event(s), ${rollup.use_count} use(s), ${succeeded} succeeded, ${failed} failed; last activity ${rollup.last_activity}`;
}

function skillNamesFromNode(node: SkillRecommendationRecalledNode): string[] {
  const names = new Set<string>();
  const skill = node.properties.skill;
  if (isSkillObject(skill)) names.add(skill.name);

  for (const tag of node.properties.tags ?? []) {
    const match = /^skill:(.+)$/.exec(tag);
    if (match?.[1]) names.add(match[1]);
  }

  for (const field of [
    node.label,
    node.properties.title,
    node.properties.summary,
    node.properties.content,
  ]) {
    if (!field) continue;
    for (const match of field.matchAll(/\b(?:dev|memory):[a-z0-9][a-z0-9:-]*\b/gi)) {
      names.add(match[0]);
    }
  }

  return [...names].sort();
}

function isSkillObject(value: unknown): value is { name: string } {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function normalizeEvidence(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}
