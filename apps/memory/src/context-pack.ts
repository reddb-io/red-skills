import {
  recall,
  TRUST_WEIGHT,
  type RecallOptions,
  type RecallStore,
  type RecalledNode,
} from "./engine.js";
import type { Confidence, MemoryProvenance } from "./schema.js";
import {
  buildSkillRecommendationsFromEvidence,
  renderSkillRecommendationsSection,
  type SkillRecommendationReport,
} from "./skill-recommendations.js";
import type { SkillRollup } from "./skill-events.js";
import {
  compressContent,
  type CompressedContent,
  type CompressedContentKind,
} from "./context-compress.js";

/**
 * Compresses one recalled node's content for the pack (issue #827). Injectable
 * so tests can force a compression error (exercising the safety fallback) or
 * compare against an uncompressed baseline.
 */
export type ContentCompressor = (node: RecalledNode) => CompressedContent;

/** Expand-handle prefix; the full node is one `memory:recall <rid>` away. */
export const EXPAND_HANDLE_PREFIX = "memory:recall ";

/** Build the expand handle that round-trips an entry back to its full node. */
export function expandHandleFor(rid: number): string {
  return `${EXPAND_HANDLE_PREFIX}${rid}`;
}

/** Recover the rid from an expand handle, or null when it is not one. */
export function parseExpandHandle(handle: string): number | null {
  if (!handle.startsWith(EXPAND_HANDLE_PREFIX)) return null;
  const rid = Number.parseInt(handle.slice(EXPAND_HANDLE_PREFIX.length).trim(), 10);
  return Number.isInteger(rid) ? rid : null;
}

function defaultCompressor(node: RecalledNode): CompressedContent {
  const raw =
    node.properties.content ?? node.properties.summary ?? node.properties.title ?? node.excerpt;
  return compressContent(raw ?? "", {
    nodeType: node.node_type,
    language: typeof node.properties.language === "string" ? node.properties.language : null,
  });
}

export type ContextPackStore = RecallStore;

export type ContextPackStatus = "ok" | "insufficient-context";

export type ContextPackSection =
  | "hard_constraints"
  | "prior_decisions"
  | "known_pitfalls"
  | "similar_past_work"
  | "do_not_do";

export interface ContextPackCitation {
  marker: string;
  urn: string;
  rid: number;
  source: string | null;
}

export interface ContextPackEntry {
  section: ContextPackSection;
  title: string;
  nodeType: string;
  importance: number;
  confidence: Confidence;
  trust: number;
  provenance: MemoryProvenance | null;
  citation: ContextPackCitation;
  reason: string;
  excerpt: string;
  score: number;
  /** Composed confidence in [0, 1] (issue #167). */
  confidence_score?: number;
  /** `memory:recall <rid>` handle that round-trips back to the full node (#827). */
  expandHandle: string;
  /** True when `excerpt` is a compression of larger content (the handle matters). */
  compressed: boolean;
  /** Which content-type strategy produced `excerpt`, when compressed. */
  compressedKind?: CompressedContentKind;
}

export interface ContextPackWarning {
  kind: "superseded" | "contradiction" | "budget";
  message: string;
  rids: number[];
}

export interface ContextPack {
  goal: string;
  status: ContextPackStatus;
  budgetChars: number;
  usedChars: number;
  markdown: string;
  /** Pinned Memory nodes (`importance >= 0.8`) that passed governed recall and budget. */
  coreContext: ContextPackEntry[];
  /** Combined included context in render order. Kept for existing consumers. */
  entries: ContextPackEntry[];
  skillRecommendations: SkillRecommendationReport;
  warnings: ContextPackWarning[];
  omittedEntries: number;
}

export interface ContextPackOptions extends Pick<RecallOptions, "scope" | "now"> {
  budgetChars?: number;
  limit?: number;
  depth?: number;
  skillRollups?: SkillRollup[];
  /** Override the per-entry content compressor (tests, baselines). */
  compressor?: ContentCompressor;
}

const DEFAULT_BUDGET_CHARS = 4_000;
const DEFAULT_LIMIT = 12;
const PINNED_IMPORTANCE_THRESHOLD = 0.8;
const SECTION_ORDER: ContextPackSection[] = [
  "hard_constraints",
  "prior_decisions",
  "known_pitfalls",
  "similar_past_work",
  "do_not_do",
];

const SECTION_TITLES: Record<ContextPackSection, string> = {
  hard_constraints: "Hard constraints",
  prior_decisions: "Prior decisions",
  known_pitfalls: "Known pitfalls",
  similar_past_work: "Similar past work",
  do_not_do: "Do-not-do guidance",
};

export async function buildContextPack(
  store: ContextPackStore,
  goal: string,
  opts: ContextPackOptions = {},
): Promise<ContextPack> {
  const budgetChars = Math.max(0, opts.budgetChars ?? DEFAULT_BUDGET_CHARS);
  const recalled = await recall(store, goal, {
    k: opts.limit ?? DEFAULT_LIMIT,
    depth: opts.depth ?? 1,
    includeSuperseded: true,
    scope: opts.scope,
    now: opts.now,
  });
  const superseded = await store.supersededByMany(recalled.nodes.map((node) => node.rid));
  const warnings = await buildWarnings(store, recalled.nodes, superseded);
  const activeNodes = recalled.nodes.filter((node) => !superseded.has(node.rid));

  if (activeNodes.length === 0) {
    const skillRecommendations = buildSkillRecommendationsFromEvidence(
      goal,
      [],
      opts.skillRollups ?? [],
    );
    const baseMarkdown = [
      `# Memory context pack: ${goal}`,
      "",
      "Status: insufficient-context",
      "",
      "_No strong Memory evidence matched this goal._",
      "",
    ].join("\n");
    const skillMarkdown =
      skillRecommendations.recommendations.length > 0
        ? `\n${renderSkillRecommendationsSection(skillRecommendations)}`
        : "";
    const markdown = fitToBudget(
      `${baseMarkdown}${baseMarkdown.length + skillMarkdown.length <= budgetChars ? skillMarkdown : ""}`,
      budgetChars,
    );
    return {
      goal,
      status: "insufficient-context",
      budgetChars,
      usedChars: markdown.length,
      markdown,
      coreContext: [],
      entries: [],
      skillRecommendations,
      warnings,
      omittedEntries: 0,
    };
  }

  const compressor = opts.compressor ?? defaultCompressor;
  const entries = activeNodes.map((node, index) => toEntry(node, index + 1, goal, compressor));
  const skillRecommendations = buildSkillRecommendationsFromEvidence(
    goal,
    activeNodes,
    opts.skillRollups ?? [],
  );
  const rendered = renderPack(goal, entries, warnings, budgetChars, skillRecommendations);
  return {
    goal,
    status: rendered.included.length > 0 ? "ok" : "insufficient-context",
    budgetChars,
    usedChars: rendered.markdown.length,
    markdown: rendered.markdown,
    coreContext: rendered.coreContext,
    entries: rendered.included,
    skillRecommendations,
    warnings: rendered.warnings,
    omittedEntries: entries.length - rendered.included.length,
  };
}

async function buildWarnings(
  store: ContextPackStore,
  nodes: RecalledNode[],
  superseded: Map<number, number>,
): Promise<ContextPackWarning[]> {
  const recalledRids = new Set(nodes.map((node) => node.rid));
  const warnings: ContextPackWarning[] = [];

  for (const [from, to] of [...superseded.entries()].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (!recalledRids.has(from)) continue;
    warnings.push({
      kind: "superseded",
      message: `memory_nodes:${from} is superseded by memory_nodes:${to}; it is excluded from sections.`,
      rids: [from, to],
    });
  }

  for (const edge of await store.listEdges()) {
    if (edgeLabel(edge) !== "CONTRADICTS") continue;
    const from = edgeEndpoint(edge, "from");
    const to = edgeEndpoint(edge, "to");
    if (!recalledRids.has(from) && !recalledRids.has(to)) continue;
    warnings.push({
      kind: "contradiction",
      message: `memory_nodes:${from} contradicts memory_nodes:${to}${edgeReason(edge)}`,
      rids: [from, to],
    });
  }

  const order: Record<ContextPackWarning["kind"], number> = {
    superseded: 0,
    contradiction: 1,
    budget: 2,
  };
  return warnings.sort((a, b) => order[a.kind] - order[b.kind] || a.rids[0] - b.rids[0]);
}

function toEntry(
  node: RecalledNode,
  marker: number,
  goal: string,
  compressor: ContentCompressor,
): ContextPackEntry {
  const section = classifySection(node);
  const title = node.properties.title ?? node.label;
  const source = typeof node.properties.source === "string" ? node.properties.source : null;
  const confidence = node.properties.confidence ?? "AMBIGUOUS";
  // Safety fallback (#827): any compression error emits the original entry
  // unchanged — the legacy normalized excerpt, no handle, nothing lost.
  let excerpt = normalizeWhitespace(node.excerpt);
  let compressed = false;
  let compressedKind: CompressedContentKind | undefined;
  try {
    const result = compressor(node);
    if (result.text.length > 0) {
      excerpt = normalizeWhitespace(result.text);
      compressed = result.lossy;
      if (result.lossy) compressedKind = result.kind;
    }
  } catch {
    excerpt = normalizeWhitespace(node.excerpt);
    compressed = false;
    compressedKind = undefined;
  }
  return {
    section,
    title,
    nodeType: node.node_type,
    importance: node.properties.importance ?? 0.5,
    confidence,
    trust: TRUST_WEIGHT[confidence],
    provenance: node.properties.provenance ?? null,
    citation: {
      marker: `[M${marker}]`,
      urn: `memory_nodes:${node.rid}`,
      rid: node.rid,
      source,
    },
    reason: inclusionReason(node, section, goal),
    excerpt,
    score: node.score,
    expandHandle: expandHandleFor(node.rid),
    compressed,
    ...(compressedKind != null ? { compressedKind } : {}),
    ...(node.confidence != null ? { confidence_score: node.confidence } : {}),
  };
}

function classifySection(node: RecalledNode): ContextPackSection {
  const text = `${node.properties.title ?? ""} ${node.properties.summary ?? ""} ${node.properties.content ?? ""} ${(node.properties.tags ?? []).join(" ")}`.toLowerCase();
  if (/\b(do not|don't|avoid|never|must not|deprecated|banned)\b/.test(text)) return "do_not_do";
  if (/\b(must|required|requires|constraint|invariant|policy|rule)\b/.test(text)) {
    return "hard_constraints";
  }
  if (node.node_type === "decision" || /\b(decision|decided|choose|chose|chosen)\b/.test(text)) {
    return "prior_decisions";
  }
  if (
    node.node_type === "problem" ||
    /\b(pitfall|failure|bug|risk|regression|error|incident|gotcha)\b/.test(text)
  ) {
    return "known_pitfalls";
  }
  return "similar_past_work";
}

function inclusionReason(
  node: RecalledNode,
  section: ContextPackSection,
  goal: string,
): string {
  const reasonBySection: Record<ContextPackSection, string> = {
    hard_constraints: "constraint-like evidence matched the goal",
    prior_decisions: "decision evidence matched the goal",
    known_pitfalls: "pitfall or failure evidence matched the goal",
    similar_past_work: "prior work evidence matched the goal",
    do_not_do: "negative guidance matched the goal",
  };
  return `${reasonBySection[section]} "${goal}" with recall score ${node.score.toFixed(4)}.`;
}

function renderPack(
  goal: string,
  entries: ContextPackEntry[],
  warnings: ContextPackWarning[],
  budgetChars: number,
  skillRecommendations: SkillRecommendationReport,
): {
  markdown: string;
  coreContext: ContextPackEntry[];
  included: ContextPackEntry[];
  warnings: ContextPackWarning[];
} {
  const coreCandidates = entries
    .filter((entry) => entry.importance >= PINNED_IMPORTANCE_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.citation.rid - b.citation.rid);
  const ordinaryEntries = entries.filter((entry) => entry.importance < PINNED_IMPORTANCE_THRESHOLD);
  const coreContext: ContextPackEntry[] = [];
  const included: ContextPackEntry[] = [];
  const renderedWarnings = [...warnings];
  let markdown = header(goal, "ok", renderedWarnings);

  if (coreCandidates.length > 0) {
    let nextMarkdown = `${markdown}## Core context\n`;
    const acceptedCore: ContextPackEntry[] = [];
    for (const entry of coreCandidates) {
      const candidate = `${nextMarkdown}${renderEntry(entry)}\n`;
      if (candidate.length > budgetChars) break;
      nextMarkdown = candidate;
      acceptedCore.push(entry);
    }
    if (acceptedCore.length > 0) {
      markdown = `${nextMarkdown}\n`;
      coreContext.push(...acceptedCore);
      included.push(...acceptedCore);
    }
  }

  for (const section of SECTION_ORDER) {
    const sectionEntries = ordinaryEntries
      .filter((entry) => entry.section === section)
      .sort((a, b) => b.score - a.score || a.citation.rid - b.citation.rid);
    if (sectionEntries.length === 0) continue;

    let nextMarkdown = `${markdown}## ${SECTION_TITLES[section]}\n`;
    const acceptedInSection: ContextPackEntry[] = [];
    for (const entry of sectionEntries) {
      const candidate = `${nextMarkdown}${renderEntry(entry)}\n`;
      if (candidate.length > budgetChars) break;
      nextMarkdown = candidate;
      acceptedInSection.push(entry);
    }
    if (acceptedInSection.length > 0) {
      markdown = `${nextMarkdown}\n`;
      included.push(...acceptedInSection);
    }
  }

  if (included.length < entries.length) {
    const includedRids = new Set(included.map((entry) => entry.citation.rid));
    renderedWarnings.push({
      kind: "budget",
      message: `${entries.length - included.length} recalled item(s) omitted to stay within budget.`,
      rids: entries
        .filter((entry) => !includedRids.has(entry.citation.rid))
        .map((entry) => entry.citation.rid),
    });
    const status = included.length > 0 ? "ok" : "insufficient-context";
    const rerendered = `${header(goal, status, renderedWarnings)}${renderBody(coreContext, included.filter((entry) => entry.importance < PINNED_IMPORTANCE_THRESHOLD))}`;
    if (rerendered.length <= budgetChars) {
      markdown = rerendered;
    } else if (included.length === 0) {
      markdown = header(goal, "insufficient-context", renderedWarnings);
    }
  }

  if (skillRecommendations.recommendations.length > 0) {
    const skillMarkdown = `\n${renderSkillRecommendationsSection(skillRecommendations)}`;
    const candidate = `${markdown}${skillMarkdown}`;
    if (candidate.length <= budgetChars) markdown = candidate;
  }

  return { markdown: fitToBudget(markdown, budgetChars), coreContext, included, warnings: renderedWarnings };
}

function header(
  goal: string,
  status: ContextPackStatus,
  warnings: ContextPackWarning[],
): string {
  const lines = [`# Memory context pack: ${goal}`, "", `Status: ${status}`, ""];
  if (warnings.length > 0) {
    lines.push("## Warnings");
    for (const warning of warnings) lines.push(`- ${warning.kind}: ${warning.message}`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderBody(
  coreContext: ContextPackEntry[],
  ordinaryEntries: ContextPackEntry[],
): string {
  const lines: string[] = [];
  if (coreContext.length > 0) {
    lines.push("## Core context");
    for (const entry of coreContext) lines.push(renderEntry(entry));
    lines.push("");
  }
  lines.push(renderSections(ordinaryEntries));
  return lines.join("\n");
}

function renderSections(entries: ContextPackEntry[]): string {
  const lines: string[] = [];
  for (const section of SECTION_ORDER) {
    const sectionEntries = entries.filter((entry) => entry.section === section);
    if (sectionEntries.length === 0) continue;
    lines.push(`## ${SECTION_TITLES[section]}`);
    for (const entry of sectionEntries) lines.push(renderEntry(entry));
    lines.push("");
  }
  return lines.join("\n");
}

function renderEntry(entry: ContextPackEntry): string {
  const source = entry.citation.source ? `; source: ${entry.citation.source}` : "";
  const provenance = entry.provenance
    ? `; provenance: ${entry.provenance.source_kind}${entry.provenance.writer ? `/${entry.provenance.writer}` : ""}`
    : "";
  const lines = [
    `- ${entry.citation.marker} ${entry.title} (${entry.nodeType}, ${entry.confidence}; trust: ${entry.trust.toFixed(2)}; importance: ${entry.importance.toFixed(2)}; urn: ${entry.citation.urn}${source}${provenance})`,
    `  Reason: ${entry.reason}`,
    `  Evidence: ${entry.excerpt}`,
  ];
  if (entry.compressed) {
    const kind = entry.compressedKind ? `${entry.compressedKind}-compressed; ` : "";
    lines.push(`  Expand: ${kind}\`${entry.expandHandle}\``);
  }
  return lines.join("\n");
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

function edgeEndpoint(edge: Record<string, unknown>, side: "from" | "to"): number {
  if (side === "from") {
    return Number(edge.from_rid ?? edge.from ?? edge.from_id ?? edge.source ?? edge.source_id ?? 0);
  }
  return Number(edge.to_rid ?? edge.to ?? edge.to_id ?? edge.target ?? edge.target_id ?? 0);
}

function edgeReason(edge: Record<string, unknown>): string {
  const props = edge.properties;
  if (!props || typeof props !== "object" || !("reason" in props)) return "";
  const reason = (props as { reason?: unknown }).reason;
  return reason == null ? "" : ` (${String(reason)})`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function fitToBudget(markdown: string, budgetChars: number): string {
  if (markdown.length <= budgetChars) return markdown;
  if (budgetChars <= 0) return "";
  return markdown.slice(0, budgetChars);
}
