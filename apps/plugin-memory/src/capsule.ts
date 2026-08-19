import {
  buildContextPack,
  type ContextPack,
  type ContextPackOptions,
  type ContextPackStore,
} from "./context-pack.js";
import { buildMemoryHandoff, type MemoryHandoffReport } from "./handoff.js";
import type { MemoryStore } from "./graph-store.js";
import type { SkillRollup } from "./skill-events.js";

export type MemoryCapsuleSourceKind = "context-pack" | "handoff";

export interface MemoryCapsuleCitation {
  marker: string | null;
  urn: string;
  rid: number;
  source: string | null;
}

export interface MemoryCapsuleSource {
  kind: MemoryCapsuleSourceKind;
  schema_version: "memory.context_pack.v1" | "memory.handoff.v1";
  status: string;
}

export interface MemoryCapsule {
  schema_version: "memory.capsule.v1";
  read_only: true;
  source_read_only: true;
  goal: string;
  source: MemoryCapsuleSource;
  budget_chars: number;
  used_chars: number;
  status: "ready" | "insufficient-context" | "empty";
  citations: MemoryCapsuleCitation[];
  markdown: string;
}

export interface MemoryCapsuleOptions {
  source?: MemoryCapsuleSourceKind;
  budgetChars?: number;
  limit?: number;
  depth?: number;
  scope?: ContextPackOptions["scope"];
  skillRollups?: SkillRollup[];
}

const DEFAULT_BUDGET_CHARS = 4_000;

export async function buildMemoryCapsule(
  store: MemoryStore & ContextPackStore,
  goal: string,
  options: MemoryCapsuleOptions = {},
): Promise<MemoryCapsule> {
  const normalizedGoal = goal.trim();
  if (!normalizedGoal) throw new Error("nothing to package — pass a goal: memory capsule <goal>");
  const budgetChars = Math.max(0, options.budgetChars ?? DEFAULT_BUDGET_CHARS);
  const sourceKind = options.source ?? "context-pack";
  if (sourceKind === "handoff") {
    const handoff = await buildMemoryHandoff(store, {
      focus: normalizedGoal,
      limit: options.limit,
    });
    return capsuleFromHandoff(normalizedGoal, handoff, budgetChars);
  }

  const pack = await buildContextPack(store, normalizedGoal, {
    budgetChars,
    limit: options.limit,
    depth: options.depth,
    scope: options.scope,
    skillRollups: options.skillRollups,
  });
  return capsuleFromContextPack(normalizedGoal, pack, budgetChars);
}

function capsuleFromContextPack(
  goal: string,
  pack: ContextPack,
  budgetChars: number,
): MemoryCapsule {
  const citations = pack.entries.map((entry) => ({
    marker: entry.citation.marker,
    urn: entry.citation.urn,
    rid: entry.citation.rid,
    source: entry.citation.source,
  }));
  const status = pack.status === "ok" ? "ready" : "insufficient-context";
  const markdown = renderCapsuleMarkdown({
    goal,
    sourceLabel: "Memory context pack",
    sourceStatus: pack.status,
    sourceMarkdown: pack.markdown,
    citations,
    budgetChars,
  });
  return {
    schema_version: "memory.capsule.v1",
    read_only: true,
    source_read_only: true,
    goal,
    source: {
      kind: "context-pack",
      schema_version: "memory.context_pack.v1",
      status: pack.status,
    },
    budget_chars: budgetChars,
    used_chars: markdown.length,
    status,
    citations,
    markdown,
  };
}

function capsuleFromHandoff(
  goal: string,
  handoff: MemoryHandoffReport,
  budgetChars: number,
): MemoryCapsule {
  const citations = handoff.sections.flatMap((section) =>
    section.items.map((item) => ({
      marker: null,
      urn: item.citation,
      rid: item.rid,
      source: item.source,
    })),
  );
  const markdown = renderCapsuleMarkdown({
    goal,
    sourceLabel: "Memory handoff",
    sourceStatus: handoff.status,
    sourceMarkdown: handoff.markdown,
    citations,
    budgetChars,
  });
  return {
    schema_version: "memory.capsule.v1",
    read_only: true,
    source_read_only: handoff.read_only,
    goal,
    source: {
      kind: "handoff",
      schema_version: handoff.schema_version,
      status: handoff.status,
    },
    budget_chars: budgetChars,
    used_chars: markdown.length,
    status: handoff.status === "ready" ? "ready" : "empty",
    citations,
    markdown,
  };
}

function renderCapsuleMarkdown(input: {
  goal: string;
  sourceLabel: string;
  sourceStatus: string;
  sourceMarkdown: string;
  citations: MemoryCapsuleCitation[];
  budgetChars: number;
}): string {
  const citationSummary =
    input.citations.length === 0
      ? "Citations: none"
      : `Citations: ${input.citations.map((citation) => citation.marker ?? citation.urn).join(", ")}`;
  const prefix = [
    `# Memory capsule: ${input.goal}`,
    "",
    "Ready-to-inject context.",
    `Source: ${input.sourceLabel}`,
    `Source status: ${input.sourceStatus}`,
    "Storage: none; this capsule packages read-only Memory evidence.",
    citationSummary,
    "",
    "## Packaged evidence",
    "",
  ].join("\n");
  const suffix = input.citations.length > 0 ? `\n\n## Provenance\n\n${renderCitations(input.citations)}` : "";
  return fitToBudget(`${prefix}${input.sourceMarkdown}${suffix}`, input.budgetChars);
}

function renderCitations(citations: MemoryCapsuleCitation[]): string {
  return citations
    .map((citation) => {
      const marker = citation.marker ? `${citation.marker} ` : "";
      const source = citation.source ? `; source: ${citation.source}` : "";
      return `- ${marker}${citation.urn}${source}`;
    })
    .join("\n");
}

function fitToBudget(markdown: string, budgetChars: number): string {
  if (markdown.length <= budgetChars) return markdown;
  if (budgetChars <= 0) return "";
  const marker = "\n\n[...capsule truncated to fit budget...]";
  if (budgetChars <= marker.length) return marker.slice(0, budgetChars);
  return `${markdown.slice(0, budgetChars - marker.length).trimEnd()}${marker}`;
}
