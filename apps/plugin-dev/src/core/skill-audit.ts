// core/skill-audit.ts — the pure half of the read-only skill-quality auditor
// (`dev audit-skills`, issue #1167). Mirrors core/review.ts: the same
// `standardSchema<T>()` / `StandardSchemaLike<T>` adapter and the same
// injected-seam discipline, so the semantic sub-score (an LLM judge) composes
// with the mechanical sub-score without either half importing the heavy
// sandcastle package.
//
// Two sub-scores, one composite:
//   1. MECHANICAL — objective, pure facts ported from the report-only lint
//      (scripts/lint-skill-body.sh + lint-skill-first-line.sh): description
//      budget, the 1024-char hard cap, literal "Use when", <what-to-do> on long
//      bodies (standalone and outside fenced code), bold-imperative first line,
//      name: frontmatter, English-only, orphaned bundled files. Each is a
//      pass/warn/fail FACT, never a gate.
//   2. SEMANTIC — the LLM judge scores the nine sentence-level techniques from
//      writing-for-agents plus trigger clarity, deletion-test bloat, and
//      <what-to-do>/<supporting-info> placement. Its shape + validator live
//      here; core/skill-audit-extract.ts drives sandcastle to fill it.
//
// The command overlays best-effort memory telemetry on top to rank worst-first.
// This module is PURE and deterministic: same input → same output, no IO, no
// clock, no model.

// ---------------------------------------------------------------------------
// Standard Schema adapter (mirrors core/review.ts verbatim — see its rationale).
// ---------------------------------------------------------------------------

export interface StandardSchemaLike<Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<{ readonly message: string }> };
  };
}

function standardSchema<T>(validate: (value: unknown) => T): StandardSchemaLike<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "red-dev-skill-audit",
      validate: (value: unknown) => {
        try {
          return { value: validate(value) };
        } catch (error) {
          return {
            issues: [{ message: error instanceof Error ? error.message : "Validation failed" }],
          };
        }
      },
    },
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Skill document + frontmatter parsing (ports the awk frontmatter parse from
// scripts/lint-skill-body.sh).
// ---------------------------------------------------------------------------

/** One enumerated SKILL.md: its repo-relative path and raw file content. */
export interface SkillDoc {
  readonly path: string;
  readonly content: string;
}

export interface ParsedSkill {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly disableModelInvocation: boolean;
  /** Everything after the closing frontmatter delimiter; whole file if none. */
  readonly body: string;
  readonly bodyLineCount: number;
}

/**
 * Parse a SKILL.md into frontmatter fields + body. Frontmatter is the block
 * between the first two `---` delimiters (only when line 1 is `---`, matching
 * the lint's awk). A file without leading frontmatter is treated as all body.
 */
export function parseSkill(content: string): ParsedSkill {
  const lines = content.split("\n");
  let name: string | undefined;
  let description: string | undefined;
  let disableModelInvocation = false;
  let bodyStart = 0;

  if (lines[0] === "---") {
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i] === "---") {
        end = i;
        break;
      }
    }
    if (end !== -1) {
      for (let i = 1; i < end; i += 1) {
        const line = lines[i]!;
        const nameMatch = line.match(/^name:\s*(.+?)\s*$/);
        if (nameMatch && name === undefined) name = nameMatch[1];
        const descMatch = line.match(/^description:\s*(.+?)\s*$/);
        if (descMatch && description === undefined) description = descMatch[1];
        if (/^disable-model-invocation:\s*true\s*$/.test(line)) disableModelInvocation = true;
      }
      bodyStart = end + 1;
    }
  }

  const body = lines.slice(bodyStart).join("\n");
  const bodyLineCount = lines.length - bodyStart;
  return { name, description, disableModelInvocation, body, bodyLineCount };
}

/** The first content line (after frontmatter, headings, and blanks), or "". */
export function firstContentLine(parsed: ParsedSkill): string {
  for (const line of parsed.body.split("\n")) {
    if (line.trim() === "") continue;
    if (line.startsWith("#")) continue;
    return line;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Mechanical sub-score (objective facts; never a blocking gate).
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail";

export interface MechanicalCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

/** Description soft budget (lint default) and the hard cap the picker enforces. */
export const DESC_SOFT_BUDGET = 500;
export const DESC_HARD_CAP = 1024;
/** Bodies longer than this must carry a `<what-to-do>` tag (lint default). */
export const BODY_LINE_THRESHOLD = 100;

/** Portuguese giveaway words — a light English-only heuristic (warn, not fail). */
const NON_ENGLISH_MARKERS = [
  "não",
  "você",
  "está",
  "então",
  "também",
  "porque",
  "obrigado",
  "arquivo",
  "usuário",
  "não é",
];

/** True when `tag` appears as a standalone structural line outside code fences. */
export function hasStructuralTag(body: string, tag: string): boolean {
  let fenced = false;
  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (line.trim() === tag) return true;
  }
  return false;
}

export interface MechanicalContext {
  /** Bundled non-README markdown files under this skill folder not referenced
   * by any SKILL.md in the plugin (computed by the fs enumeration layer). */
  readonly orphanedFiles?: readonly string[];
}

/**
 * Run every objective check against one skill. Returns a fact per check; a
 * `fail` marks a hard house-style violation, a `warn` a soft one. The caller
 * composes these into a score — this function never gates.
 */
export function runMechanicalChecks(doc: SkillDoc, ctx: MechanicalContext = {}): MechanicalCheck[] {
  const parsed = parseSkill(doc.content);
  const checks: MechanicalCheck[] = [];

  // 1. name: frontmatter presence.
  checks.push(
    parsed.name
      ? { id: "name-present", status: "pass", detail: `name: ${parsed.name}` }
      : { id: "name-present", status: "fail", detail: "no name: in frontmatter" },
  );

  // 2. Description discipline — model-invocable skills only. A skill that opts
  //    out of model invocation never spends description context, so it is exempt.
  if (parsed.disableModelInvocation) {
    checks.push({
      id: "description-budget",
      status: "pass",
      detail: "exempt (disable-model-invocation: true)",
    });
  } else if (!parsed.description) {
    checks.push({ id: "description-budget", status: "fail", detail: "no description in frontmatter" });
  } else {
    const len = parsed.description.length;
    const hasUseWhen = parsed.description.includes("Use when");
    if (len > DESC_HARD_CAP) {
      checks.push({
        id: "description-budget",
        status: "fail",
        detail: `over hard cap (${len} > ${DESC_HARD_CAP})`,
      });
    } else if (!hasUseWhen && len > DESC_SOFT_BUDGET) {
      checks.push({
        id: "description-budget",
        status: "fail",
        detail: `missing "Use when"; over budget (${len} > ${DESC_SOFT_BUDGET})`,
      });
    } else if (!hasUseWhen) {
      checks.push({ id: "description-budget", status: "warn", detail: 'missing "Use when"' });
    } else if (len > DESC_SOFT_BUDGET) {
      checks.push({
        id: "description-budget",
        status: "warn",
        detail: `over soft budget (${len} > ${DESC_SOFT_BUDGET})`,
      });
    } else {
      checks.push({ id: "description-budget", status: "pass", detail: `${len} chars, has "Use when"` });
    }
  }

  // 3. House tags: bodies over the threshold need a structural <what-to-do>.
  const hasWhatToDo = hasStructuralTag(parsed.body, "<what-to-do>");
  if (parsed.bodyLineCount > BODY_LINE_THRESHOLD && !hasWhatToDo) {
    checks.push({
      id: "what-to-do-tag",
      status: "fail",
      detail: `${parsed.bodyLineCount}-line body has no <what-to-do> tag`,
    });
  } else {
    checks.push({
      id: "what-to-do-tag",
      status: "pass",
      detail:
        parsed.bodyLineCount > BODY_LINE_THRESHOLD
          ? `${parsed.bodyLineCount}-line body carries <what-to-do>`
          : `short body (${parsed.bodyLineCount} lines)`,
    });
  }

  // 4. Bold-imperative first content line.
  const first = firstContentLine(parsed);
  checks.push(
    first.startsWith("**")
      ? { id: "bold-first-line", status: "pass", detail: "bold imperative lead-in" }
      : {
          id: "bold-first-line",
          status: "warn",
          detail: `first content line is not bold: ${first.slice(0, 60)}`,
        },
  );

  // 5. English-only (heuristic warn).
  const lower = doc.content.toLowerCase();
  const hits = NON_ENGLISH_MARKERS.filter((m) => new RegExp(`(^|[^\\p{L}])${m}([^\\p{L}]|$)`, "u").test(lower));
  checks.push(
    hits.length > 0
      ? { id: "english-only", status: "warn", detail: `possible non-English text: ${hits.join(", ")}` }
      : { id: "english-only", status: "pass", detail: "no non-English markers" },
  );

  // 6. Orphaned bundled files (computed by the enumeration layer).
  const orphans = ctx.orphanedFiles ?? [];
  checks.push(
    orphans.length > 0
      ? { id: "orphaned-files", status: "fail", detail: `unreferenced: ${orphans.join(", ")}` }
      : { id: "orphaned-files", status: "pass", detail: "no orphaned bundled files" },
  );

  return checks;
}

/** Objective 0-100 score from the mechanical facts: each fail costs 20, each warn 5. */
export function mechanicalScore(checks: readonly MechanicalCheck[]): number {
  let penalty = 0;
  for (const c of checks) {
    if (c.status === "fail") penalty += 20;
    else if (c.status === "warn") penalty += 5;
  }
  return Math.max(0, 100 - penalty);
}

// ---------------------------------------------------------------------------
// Semantic sub-score (the LLM judge). Shape + validator; extract module fills it.
// ---------------------------------------------------------------------------

/** The scored dimensions: the nine writing-for-agents techniques + three structural
 * dimensions. Every value is 0 (absent/broken) … 10 (exemplary). */
export const AUDIT_DIMENSIONS = [
  "boldLeadIn",
  "maximCompression",
  "prohibitionReason",
  "literalPhrasing",
  "vocabularyHygiene",
  "numberedTaxonomy",
  "selfDemonstrating",
  "preconditionHeaders",
  "leadingWords",
  "triggerClarity",
  "deletionTestBloat",
  "sectionPlacement",
] as const;

export type AuditDimension = (typeof AUDIT_DIMENSIONS)[number];

export type SkillAuditDimensions = Record<AuditDimension, number>;

export interface SkillAuditFindings {
  readonly dimensions: SkillAuditDimensions;
  readonly summary: string;
  readonly suggestions: string[];
}

function clampScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return Math.max(0, Math.min(10, value));
}

/** Standard Schema validator for {@link SkillAuditFindings}, used by `Output.object`. */
export const skillAuditSchema = standardSchema<SkillAuditFindings>((value) => {
  const record = asRecord(value, "skill audit output");
  const rawDims = asRecord(record.dimensions, "dimensions");
  const dimensions = {} as SkillAuditDimensions;
  for (const dim of AUDIT_DIMENSIONS) {
    dimensions[dim] = clampScore(rawDims[dim], `dimensions.${dim}`);
  }
  const rawSuggestions = record.suggestions ?? [];
  if (!Array.isArray(rawSuggestions)) throw new Error("suggestions must be an array");
  return {
    dimensions,
    summary: asString(record.summary, "summary"),
    suggestions: rawSuggestions.map((s, i) => asString(s, `suggestions[${i}]`)),
  };
});

/** The judge's 0-100 semantic score: the mean dimension score scaled ×10. */
export function semanticScore(findings: SkillAuditFindings): number {
  const values = AUDIT_DIMENSIONS.map((d) => findings.dimensions[d]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(mean * 10);
}

// ---------------------------------------------------------------------------
// Composite scoring + ranking (telemetry overlay is best-effort).
// ---------------------------------------------------------------------------

/** Behavioral telemetry tag from the memory curator, when the store is reachable. */
export type TelemetryTag = "abandoned" | "frequently-failing" | undefined;

export interface SkillScore {
  readonly path: string;
  readonly name: string;
  /** Composite 0-100 score (worst = lowest). */
  readonly composite: number;
  readonly glyph: CheckStatus;
  readonly mechanical: number;
  /** null when the judge did not run (semantic-absent path). */
  readonly semantic: number | null;
  readonly checks: MechanicalCheck[];
  readonly findings: SkillAuditFindings | null;
  readonly telemetry: TelemetryTag;
  /** The single most actionable observation, worst-first. */
  readonly topFinding: string;
}

/** Weighted composite: 60% semantic + 40% mechanical when the judge ran; the
 * mechanical score alone otherwise (semantic-absent degrade). */
export function compositeScore(mechanical: number, semantic: number | null): number {
  if (semantic === null) return mechanical;
  return Math.round(0.6 * semantic + 0.4 * mechanical);
}

function glyphFor(composite: number, checks: readonly MechanicalCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "fail") || composite < 50) return "fail";
  if (checks.some((c) => c.status === "warn") || composite < 75) return "warn";
  return "pass";
}

function topFindingFor(checks: readonly MechanicalCheck[], findings: SkillAuditFindings | null): string {
  const fail = checks.find((c) => c.status === "fail");
  if (fail) return `${fail.id}: ${fail.detail}`;
  if (findings) {
    // Lowest-scoring semantic dimension.
    let worst: AuditDimension = AUDIT_DIMENSIONS[0];
    for (const dim of AUDIT_DIMENSIONS) {
      if (findings.dimensions[dim] < findings.dimensions[worst]) worst = dim;
    }
    return `${worst}: ${findings.dimensions[worst]}/10`;
  }
  const warn = checks.find((c) => c.status === "warn");
  return warn ? `${warn.id}: ${warn.detail}` : "no findings";
}

export interface ScoreInput {
  readonly doc: SkillDoc;
  readonly checks: MechanicalCheck[];
  readonly findings: SkillAuditFindings | null;
  readonly telemetry?: TelemetryTag;
}

/** Compose one skill's mechanical + semantic + telemetry inputs into a score row. */
export function scoreSkill(input: ScoreInput): SkillScore {
  const parsed = parseSkill(input.doc.content);
  const mechanical = mechanicalScore(input.checks);
  const semantic = input.findings ? semanticScore(input.findings) : null;
  const composite = compositeScore(mechanical, semantic);
  return {
    path: input.doc.path,
    name: parsed.name ?? input.doc.path,
    composite,
    glyph: glyphFor(composite, input.checks),
    mechanical,
    semantic,
    checks: input.checks,
    findings: input.findings,
    telemetry: input.telemetry,
    topFinding: topFindingFor(input.checks, input.findings),
  };
}

/** Telemetry penalty applied to the effective ranking key — a measurable
 * writing failure (never invoked / frequently failing) outranks a merely
 * low-scoring skill. */
const TELEMETRY_PENALTY: Record<Exclude<TelemetryTag, undefined>, number> = {
  "frequently-failing": 20,
  abandoned: 15,
};

/**
 * Rank skills worst-first. The primary key is the composite score minus a
 * telemetry penalty (measurable writing failures rise), then the raw composite,
 * then the name — deterministic and stable when the store is absent (no penalty).
 */
export function rankSkills(scores: readonly SkillScore[]): SkillScore[] {
  const effective = (s: SkillScore): number =>
    s.composite - (s.telemetry ? TELEMETRY_PENALTY[s.telemetry] : 0);
  return [...scores].sort(
    (a, b) => effective(a) - effective(b) || a.composite - b.composite || a.name.localeCompare(b.name),
  );
}
