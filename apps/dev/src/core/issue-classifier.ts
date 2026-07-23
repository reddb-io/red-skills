import { AFK_MODEL_TIERS, getConfig, type AfkModelTier, type ConfigValues } from "./config.js";

export type TaskClass = AfkModelTier;

export interface IssueClassificationMetadata {
  issue: number;
  title: string;
  summary: string;
  labels: string[];
  referencedPaths: string[];
  extensions: string[];
  scopePaths: string[];
  referencedFileCount: number;
  diffSize: "small" | "medium" | "large";
  bodyChars: number;
  hasTests: boolean;
  riskKeywords: string[];
}

export type IssueClassifierModelCall = (input: {
  prompt: string;
  metadata: IssueClassificationMetadata;
}) => Promise<unknown>;

const TASK_CLASSES: readonly TaskClass[] = ["validate", "simple", "complex", "think"];
const RANK: Record<TaskClass, number> = {
  validate: 0,
  simple: 1,
  complex: 2,
  think: 3,
};

const RISK_KEYWORDS = [
  "security",
  "auth",
  "authentication",
  "authorization",
  "permission",
  "secret",
  "token",
  "concurrency",
  "race",
  "deadlock",
  "schema",
  "migration",
  "database",
  "data loss",
  "transaction",
] as const;

const THINK_KEYWORDS =
  /\b(architecture|architectural|adr|design decision|routing decision|strategy|tradeoff|choose|classifier|planner|planning)\b/i;
const SPEC_FAMILY_LABEL = /^spec:\d+$/i;

const DOC_EXTENSIONS = new Set(["md", "mdx", "txt", "rst", "adoc"]);
const VALIDATION_WORDS = /\b(validate|validation|lint|format|formatting|schema check|typecheck|type check)\b/i;
const DOC_WORDS = /\b(doc|docs|documentation|readme|changelog|copy|markdown)\b/i;

export function buildIssueClassificationMetadata(input: {
  issue: number;
  title: string;
  body: string;
  labels?: readonly string[];
}): IssueClassificationMetadata {
  const text = `${input.title}\n${input.body}`;
  const referencedPaths = extractReferencedPaths(text);
  const extensions = [...new Set(referencedPaths.map(extensionOf).filter((e): e is string => e !== undefined))].sort();
  const scopePaths = [...new Set(referencedPaths.map(scopeOf).filter((s): s is string => s !== undefined))].sort();
  const lower = text.toLowerCase();
  const riskKeywords = RISK_KEYWORDS.filter((kw) => lower.includes(kw));

  return {
    issue: input.issue,
    title: input.title,
    summary: oneParagraphSummary(input.title, input.body),
    labels: [...(input.labels ?? [])],
    referencedPaths,
    extensions,
    scopePaths,
    referencedFileCount: referencedPaths.length,
    diffSize: estimateDiffSize(referencedPaths.length, input.body.length),
    bodyChars: input.body.length,
    hasTests: hasTestSignal(text, referencedPaths),
    riskKeywords,
  };
}

export async function classifyIssue(
  metadata: IssueClassificationMetadata,
  modelCall?: IssueClassifierModelCall,
): Promise<TaskClass> {
  const explicitTier = explicitTierLabel(metadata.labels);
  if (explicitTier) return explicitTier;

  const deterministic = deterministicTaskClass(metadata);
  const modelTier = modelCall ? parseTaskClass(await modelCall({ prompt: classifierPrompt(metadata), metadata })) : undefined;

  if (isTrivialDocOrValidation(metadata)) {
    return minTier(modelTier ?? deterministic, "simple");
  }

  return maxTier(deterministic, modelTier ?? "validate");
}

function explicitTierLabel(labels: readonly string[]): TaskClass | undefined {
  for (const label of labels) {
    const match = /^tier:(validate|simple|complex|think)$/i.exec(label.trim());
    if (match) return match[1]!.toLowerCase() as TaskClass;
  }
  return undefined;
}

/**
 * Policy for the AFK PR review gate (ADR 0064 §10, issue #749). When
 * AFK opens a PR for a completed attempt, the change's classified task
 * tier decides whether it is "mechanical" (trivial / well-scoped, keeps the
 * existing fast-merge path) or "non-mechanical" (risky / architectural, earns a
 * fresh-agent review hop). Non-mechanical changes get `ready-for-review` applied
 * to the PR — which fires the advisory review from #746 — and hold the merge;
 * mechanical work fast-merges unchanged.
 *
 * Tuned per repo through the plugin config surface, so the gate can be turned
 * on/off and its threshold moved without code changes.
 */
export interface ReviewGateConfig {
  /**
   * Master on/off. Off (the default) → the gate never requests review and AFK /
   * the landing lane keeps today's fast-merge behaviour for every tier.
   */
  enabled: boolean;
  /**
   * The cheapest task tier that counts as NON-mechanical. Tiers below it stay
   * mechanical (fast-merge); this tier and anything above it request review.
   * Defaults to `complex`, so `validate` / `simple` fast-merge while `complex` /
   * `think` get the review hop.
   */
  threshold: TaskClass;
}

/** The default review-gate threshold: `complex` and above are non-mechanical. */
export const DEFAULT_REVIEW_GATE_THRESHOLD: TaskClass = "complex";

/**
 * A change is mechanical when its task tier sits strictly below `threshold` —
 * trivial / well-scoped work that keeps the fast-merge path. Pure ranking over
 * the shared tier order; no config or IO.
 */
export function isMechanicalChange(taskClass: TaskClass, threshold: TaskClass): boolean {
  return RANK[taskClass] < RANK[threshold];
}

/**
 * Decide whether a completed attempt's PR should get `ready-for-review` (and the
 * fresh-agent review hop) instead of fast-merging. True only when the gate is
 * enabled AND the change is non-mechanical (tier at or above the threshold).
 * Disabled → always false, preserving the existing fast-merge behaviour.
 */
export function shouldRequestReview(taskClass: TaskClass, config: ReviewGateConfig): boolean {
  if (!config.enabled) return false;
  return !isMechanicalChange(taskClass, config.threshold);
}

/**
 * Resolve the review gate from the flat config map (`afk.review_gate.*`). Returns
 * undefined when the gate is off (the default), so callers treat "no gate" and
 * "disabled gate" identically and keep the fast-merge path. An out-of-vocab
 * `threshold` falls back to {@link DEFAULT_REVIEW_GATE_THRESHOLD}. Shared by the
 * AFK run wiring and the landing lane so both read the gate the same way.
 */
export function resolveReviewGate(values: ConfigValues): ReviewGateConfig | undefined {
  if (getConfig(values, "afk.review_gate.enabled") !== "true") return undefined;
  const threshold = getConfig(values, "afk.review_gate.threshold");
  return {
    enabled: true,
    threshold: (AFK_MODEL_TIERS as readonly string[]).includes(threshold)
      ? (threshold as TaskClass)
      : DEFAULT_REVIEW_GATE_THRESHOLD,
  };
}

export function classifierPrompt(metadata: IssueClassificationMetadata): string {
  return [
    "Classify this AFK issue into the cheapest capable task tier.",
    "",
    "Return only JSON: {\"tier\":\"validate|simple|complex|think\"}.",
    "",
    "Tier meanings:",
    "- validate: docs-only, formatting-only, or fuzzy validation/checking.",
    "- simple: small, well-scoped code change.",
    "- complex: cross-module, risky, schema/migration/security/concurrency-sensitive code.",
    "- think: planning, architecture, routing, or ambiguous design work.",
    "",
    `Issue: #${metadata.issue} ${metadata.title}`,
    `Summary: ${metadata.summary}`,
    `Labels: ${metadata.labels.join(", ") || "(none)"}`,
    `Referenced files: ${metadata.referencedFileCount}`,
    `Extensions: ${metadata.extensions.join(", ") || "(none)"}`,
    `Scopes: ${metadata.scopePaths.join(", ") || "(none)"}`,
    `Diff size estimate: ${metadata.diffSize}`,
    `Has tests signal: ${metadata.hasTests ? "yes" : "no"}`,
    `Risk keywords: ${metadata.riskKeywords.join(", ") || "(none)"}`,
    `Body chars: ${metadata.bodyChars}`,
  ].join("\n");
}

function deterministicTaskClass(metadata: IssueClassificationMetadata): TaskClass {
  const searchable = `${metadata.title}\n${metadata.summary}\n${metadata.labels.join("\n")}`;
  if (THINK_KEYWORDS.test(searchable)) return "think";
  if (metadata.labels.some((label) => SPEC_FAMILY_LABEL.test(label.trim()))) return "complex";
  if (metadata.riskKeywords.length > 0) return "complex";
  if (metadata.scopePaths.length >= 3 || metadata.referencedFileCount >= 6 || metadata.diffSize === "large") {
    return "complex";
  }
  if (isTrivialDocOrValidation(metadata)) return "validate";
  return "simple";
}

function isTrivialDocOrValidation(metadata: IssueClassificationMetadata): boolean {
  const searchable = `${metadata.title}\n${metadata.summary}\n${metadata.labels.join("\n")}`;
  if (metadata.riskKeywords.length > 0) return false;
  const hasOnlyDocFiles = metadata.extensions.length > 0 && metadata.extensions.every((ext) => DOC_EXTENSIONS.has(ext));
  const noCodePaths = metadata.referencedFileCount === 0;
  return hasOnlyDocFiles || (noCodePaths && (DOC_WORDS.test(searchable) || VALIDATION_WORDS.test(searchable)));
}

function parseTaskClass(raw: unknown): TaskClass | undefined {
  if (typeof raw === "object" && raw !== null && "tier" in raw) {
    const tier = (raw as { tier?: unknown }).tier;
    return typeof tier === "string" ? parseTaskClass(tier) : undefined;
  }
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as { tier?: unknown };
    if (typeof parsed.tier === "string") return parseTaskClass(parsed.tier);
  } catch {
    // fall through to permissive text matching
  }
  const match = /\b(validate|simple|complex|think)\b/i.exec(raw);
  if (!match) return undefined;
  const tier = match[1]!.toLowerCase();
  return (TASK_CLASSES as readonly string[]).includes(tier) ? (tier as TaskClass) : undefined;
}

function maxTier(a: TaskClass, b: TaskClass): TaskClass {
  return RANK[a] >= RANK[b] ? a : b;
}

function minTier(a: TaskClass, b: TaskClass): TaskClass {
  return RANK[a] <= RANK[b] ? a : b;
}

function extractReferencedPaths(text: string): string[] {
  const paths = new Set<string>();
  const re = /(?:^|[\s("'`])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9][A-Za-z0-9+.-]{0,12})(?=$|[\s)"'`,:;])/g;
  for (const match of text.matchAll(re)) {
    const path = match[1]!.replace(/[.,;:)]+$/, "");
    if (/^https?:/i.test(path)) continue;
    paths.add(path.replace(/^\.\//, ""));
  }
  return [...paths].sort();
}

function extensionOf(path: string): string | undefined {
  const leaf = path.split("/").pop() ?? "";
  const idx = leaf.lastIndexOf(".");
  if (idx <= 0 || idx === leaf.length - 1) return undefined;
  return leaf.slice(idx + 1).toLowerCase();
}

function scopeOf(path: string): string | undefined {
  const parts = path.replace(/^\.\.\//, "").split("/").filter(Boolean);
  if (parts.length <= 1) return undefined;
  return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

function hasTestSignal(text: string, paths: readonly string[]): boolean {
  if (/\b(test|tests|testing|spec|vitest|jest|playwright)\b/i.test(text)) return true;
  return paths.some((path) => /(^|\/)(__tests__|tests?|spec)(\/|$)|[.-](test|spec)\.[^.]+$/i.test(path));
}

function estimateDiffSize(fileCount: number, bodyChars: number): IssueClassificationMetadata["diffSize"] {
  if (fileCount >= 6 || bodyChars >= 5000) return "large";
  if (fileCount >= 3 || bodyChars >= 1800) return "medium";
  return "small";
}

function oneParagraphSummary(title: string, body: string): string {
  const stripped = body.replace(/```[\s\S]*?```/g, " ");
  const para =
    stripped
      .split(/\n\s*\n/)
      .map((p) =>
        p
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#"))
          .join(" "),
      )
      .find((p) => p.trim() !== "") ?? "";
  const summary = para ? `${title}: ${para}` : title;
  return summary.length > 600 ? `${summary.slice(0, 597)}...` : summary;
}
