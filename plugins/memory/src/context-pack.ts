import { recall, type RecallOptions, type RecallStore, type RecalledNode } from "./engine.js";
import type { Confidence } from "./schema.js";

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
  confidence: Confidence;
  citation: ContextPackCitation;
  reason: string;
  excerpt: string;
  score: number;
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
  entries: ContextPackEntry[];
  warnings: ContextPackWarning[];
  omittedEntries: number;
}

export interface ContextPackOptions extends Pick<RecallOptions, "scope" | "now"> {
  budgetChars?: number;
  limit?: number;
  depth?: number;
}

const DEFAULT_BUDGET_CHARS = 4_000;
const DEFAULT_LIMIT = 12;
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
    const markdown = fitToBudget(
      [`# Memory context pack: ${goal}`, "", "Status: insufficient-context", "", "_No strong Memory evidence matched this goal._", ""].join(
        "\n",
      ),
      budgetChars,
    );
    return {
      goal,
      status: "insufficient-context",
      budgetChars,
      usedChars: markdown.length,
      markdown,
      entries: [],
      warnings,
      omittedEntries: 0,
    };
  }

  const entries = activeNodes.map((node, index) => toEntry(node, index + 1, goal));
  const rendered = renderPack(goal, entries, warnings, budgetChars);
  return {
    goal,
    status: rendered.included.length > 0 ? "ok" : "insufficient-context",
    budgetChars,
    usedChars: rendered.markdown.length,
    markdown: rendered.markdown,
    entries: rendered.included,
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

function toEntry(node: RecalledNode, marker: number, goal: string): ContextPackEntry {
  const section = classifySection(node);
  const title = node.properties.title ?? node.label;
  const source = typeof node.properties.source === "string" ? node.properties.source : null;
  return {
    section,
    title,
    nodeType: node.node_type,
    confidence: node.properties.confidence ?? "AMBIGUOUS",
    citation: {
      marker: `[M${marker}]`,
      urn: `memory_nodes:${node.rid}`,
      rid: node.rid,
      source,
    },
    reason: inclusionReason(node, section, goal),
    excerpt: normalizeWhitespace(node.excerpt),
    score: node.score,
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
): { markdown: string; included: ContextPackEntry[]; warnings: ContextPackWarning[] } {
  const included: ContextPackEntry[] = [];
  const renderedWarnings = [...warnings];
  let markdown = header(goal, "ok", renderedWarnings);

  for (const section of SECTION_ORDER) {
    const sectionEntries = entries
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
    renderedWarnings.push({
      kind: "budget",
      message: `${entries.length - included.length} recalled item(s) omitted to stay within budget.`,
      rids: entries
        .filter((entry) => !included.includes(entry))
        .map((entry) => entry.citation.rid),
    });
    const status = included.length > 0 ? "ok" : "insufficient-context";
    const rerendered = `${header(goal, status, renderedWarnings)}${renderSections(included)}`;
    if (rerendered.length <= budgetChars) {
      markdown = rerendered;
    } else if (included.length === 0) {
      markdown = header(goal, "insufficient-context", renderedWarnings);
    }
  }

  return { markdown: fitToBudget(markdown, budgetChars), included, warnings: renderedWarnings };
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
  return [
    `- ${entry.citation.marker} ${entry.title} (${entry.nodeType}, ${entry.confidence}; urn: ${entry.citation.urn}${source})`,
    `  Reason: ${entry.reason}`,
    `  Evidence: ${entry.excerpt}`,
  ].join("\n");
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
