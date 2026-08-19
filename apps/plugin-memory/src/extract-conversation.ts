import { z } from "zod";
import { EXTRACTION_PROFILES, STRUCTURAL_TYPES } from "./extraction-schema.js";
import { contentHash } from "./hash.js";
import {
  EDGE_LABELS,
  NODE_TYPES,
  type EdgeLabel,
  type MemoryEdgeProps,
  type MemoryNode,
  type NodeType,
} from "./schema.js";

/**
 * LLM conversation extraction — the `INFERRED` path.
 *
 * Turns a finished transcript into entity / relationship / decision facts via
 * an LLM, routed through RedDB's engine-side AI provider modes. This replaces a
 * Python ML stack (spaCy/GLiNER/GLiREL): extraction-quality parity comes from a
 * configured model — local or external — selected from user config (PRD #66,
 * issue #69).
 *
 * Two hard boundaries hold this module in place:
 *   1. It is INFERRED-only. The deterministic tree-sitter/markdown paths
 *      (`extractCode`, `extractMarkdown`) keep emitting EXTRACTED and never call
 *      an LLM. Nothing here touches them.
 *   2. It is write-path-only. Recall/search (`engine.ts`) never import this
 *      module — recall stays a zero-token path. Extraction fires only from the
 *      Stop hook and explicit `/memory:store`, never on read.
 *
 * The model call goes through a `ProviderClient` interface so the engine-side
 * provider is injected (and mocked deterministically in tests). Provider-mode
 * selection (`openai-compat` for local Ollama / any OpenAI-compatible endpoint,
 * `openai-native`, `anthropic-native`, `bedrock` for an AWS-account-hosted
 * model) is resolved from config by `resolveProvider` — which also reports
 * whether a configured endpoint keeps inference local (no external network
 * egress).
 */

/** RedDB engine-side AI provider modes the extractor can route through. */
export type ProviderMode =
  | "openai-compat"
  | "openai-native"
  | "anthropic-native"
  | "bedrock";

/** Whether resolved inference leaves the machine. `local` ⇒ no external egress. */
export type Egress = "local" | "external";

/** AI provider config, persisted under `MemoryConfig.provider`. */
export interface AiProviderConfig {
  mode: ProviderMode;
  /** Model identifier passed to the provider (e.g. `llama3.1`, `gpt-4o-mini`). */
  model: string;
  /**
   * Base URL for `openai-compat` — a local Ollama (`http://localhost:11434/v1`)
   * or any OpenAI-compatible endpoint. Ignored by the native modes, which use
   * the provider's own fixed endpoint. Optional for `bedrock` too: set it to a
   * VPC/PrivateLink interface endpoint (or an on-box proxy) to override the
   * region-derived `bedrock-runtime` host.
   */
  baseUrl?: string;
  /**
   * AWS region for `bedrock` (e.g. `us-east-1`). Required for `bedrock` unless
   * an explicit `baseUrl` is given; it picks the `bedrock-runtime.<region>`
   * endpoint and is exported so the engine signs requests for the right region.
   * Ignored by the other modes.
   */
  region?: string;
  /** Env var name holding the API key, when the endpoint needs one. */
  apiKeyEnv?: string;
}

/** A provider config resolved into the concrete shape extraction needs. */
export interface ResolvedProvider {
  mode: ProviderMode;
  model: string;
  /** Endpoint inference will hit, or null for a native provider's own default. */
  endpoint: string | null;
  /** `local` when inference stays on the machine, `external` otherwise. */
  egress: Egress;
  /** AWS region for `bedrock`, exported for request signing. Absent otherwise. */
  region?: string;
}

/** A model request: a system instruction and the transcript-bearing user turn. */
export interface ProviderRequest {
  system: string;
  user: string;
}

/**
 * The single seam between extraction and the engine-side AI provider. The
 * production client routes `complete` through RedDB's configured provider; tests
 * inject a deterministic stub. Extraction never constructs a client itself.
 */
export interface ProviderClient {
  complete(req: ProviderRequest): Promise<string>;
}

/**
 * One fact the LLM inferred from a transcript. Maps 1:1 to a graph node, with
 * optional relationships to other facts (resolved to edges by label). Every
 * materialized node/edge carries `confidence: "INFERRED"`.
 */
export interface ExtractedFact {
  /** Stable, slug-like graph node label. */
  label: string;
  /**
   * The kind the model *proposed* — a free string, not validated against the
   * structural vocabulary at parse (ADR 0035 strict-write: classification is
   * never rejected). `factsToGraph` resolves it to a valid structural home and
   * preserves the proposed kind as an open engineering code.
   */
  node_type: string;
  title: string;
  summary?: string;
  confidence_band?: "low" | "medium" | "high";
  tags?: string[];
  relations: Array<{ label: EdgeLabel; target: string }>;
}

export { EDGE_LABELS, NODE_TYPES };

// Loopback hosts that keep inference on the machine.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/**
 * Resolve a provider config into the concrete endpoint + egress classification.
 *
 * - `openai-compat`: uses `baseUrl`. Egress is `local` when the host is a
 *   loopback address (a local Ollama / on-box server), `external` otherwise.
 *   A missing `baseUrl` is a config error — the compat mode needs one.
 * - `bedrock`: hits an AWS-account-hosted model. The endpoint is the explicit
 *   `baseUrl` (a VPC/PrivateLink endpoint or on-box proxy) when given, else the
 *   region-derived `https://bedrock-runtime.<region>.amazonaws.com`. A config
 *   without either `region` or `baseUrl` is an error. Egress is `local` only
 *   when the endpoint host is a loopback address; the regional AWS host is
 *   `external` (it leaves the box, but stays inside your AWS account/region).
 * - `openai-native` / `anthropic-native`: hit the vendor's own endpoint, so
 *   egress is always `external` and `endpoint` is null (the provider decides).
 */
export function resolveProvider(config: AiProviderConfig): ResolvedProvider {
  if (config.mode === "openai-compat") {
    if (!config.baseUrl) {
      throw new Error("openai-compat provider requires a baseUrl");
    }
    let host: string;
    try {
      host = new URL(config.baseUrl).hostname;
    } catch {
      throw new Error(`invalid provider baseUrl: ${config.baseUrl}`);
    }
    return {
      mode: config.mode,
      model: config.model,
      endpoint: config.baseUrl,
      egress: LOCAL_HOSTS.has(host) ? "local" : "external",
    };
  }
  if (config.mode === "bedrock") {
    if (!config.region && !config.baseUrl) {
      throw new Error("bedrock provider requires a region (or an explicit baseUrl)");
    }
    const endpoint =
      config.baseUrl ?? `https://bedrock-runtime.${config.region}.amazonaws.com`;
    let host: string;
    try {
      host = new URL(endpoint).hostname;
    } catch {
      throw new Error(`invalid provider baseUrl: ${config.baseUrl}`);
    }
    return {
      mode: config.mode,
      model: config.model,
      endpoint,
      egress: LOCAL_HOSTS.has(host) ? "local" : "external",
      region: config.region,
    };
  }
  return { mode: config.mode, model: config.model, endpoint: null, egress: "external" };
}

const SYSTEM_PROMPT = [
  "You extract durable memory from a finished coding-session transcript.",
  "Return ONLY a JSON object — no prose, no markdown fence — of the form:",
  '{ "facts": [ { "label": string, "node_type": string, "title": string,',
  '  "summary"?: string, "tags"?: string[],',
  '  "relations"?: [ { "label": string, "target": string } ] } ] }',
  "",
  "Rules:",
  "- label is a short kebab-case slug, unique within the response; relations",
  "  reference other facts by their label.",
  `- node_type is one of: ${NODE_TYPES.join(", ")}.`,
  `- relation label is one of: ${EDGE_LABELS.join(", ")}.`,
  "- Extract decisions, problems, solutions, fixes, and the concepts/people they",
  "  involve. Skip transient chatter and anything already obvious from the code.",
  "- Do not extract Odysseus-style Personal facts, biographical details, identity",
  "  context, or long-lived human preferences; those belong in Brain, not Memory.",
  "- Prefer fewer, higher-signal facts. Return an empty array when nothing is",
  "  worth remembering.",
].join("\n");

/**
 * Build the deterministic extraction prompt for a transcript. The system turn
 * pins the output schema and the node-type / edge-label allowlists; the user
 * turn carries the transcript verbatim. Same input ⇒ same prompt — the property
 * the golden-file tests lock down.
 */
export function buildExtractionPrompt(transcript: string): ProviderRequest {
  return {
    system: SYSTEM_PROMPT,
    user: `Transcript:\n\n${transcript.trim()}`,
  };
}

const EDGE_LABEL_ENUM = [...EDGE_LABELS] as [EdgeLabel, ...EdgeLabel[]];

const RelationSchema = z.object({
  label: z.enum(EDGE_LABEL_ENUM),
  target: z.string().min(1),
});

const FactSchema = z.object({
  label: z.string().min(1),
  // The proposed kind is a free string. ADR 0035 strict-write: an out-of-vocab
  // classification is resolved (in `factsToGraph`), never rejected at parse — so
  // only structural malformation (a missing label/kind/title) drops a fact here.
  node_type: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  confidence_band: z.enum(["low", "medium", "high"]).optional(),
  tags: z.array(z.string()).optional(),
  relations: z.array(RelationSchema).optional(),
});

const ResponseSchema = z.object({ facts: z.array(z.unknown()) });

/** Strip a ```json fence if the model wrapped its JSON despite instructions. */
function unfence(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * Parse a provider response into validated `ExtractedFact[]`. Tolerant of a
 * stray ```json fence and of individual malformed facts (each is validated and
 * dropped on failure), but a response that is not JSON at all, or has no `facts`
 * array, yields an empty list rather than throwing — a bad extraction must never
 * crash the write path. Relations pointing at unknown labels are dropped so the
 * graph never grows a dangling edge.
 */
export function parseExtraction(raw: string): ExtractedFact[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(raw));
  } catch {
    return [];
  }
  const envelope = ResponseSchema.safeParse(parsed);
  if (!envelope.success) return [];

  const facts: ExtractedFact[] = [];
  const labels = new Set<string>();
  for (const candidate of envelope.data.facts) {
    const result = FactSchema.safeParse(candidate);
    if (!result.success) continue;
    const f = result.data;
    if (labels.has(f.label)) continue; // dedupe by label within one response
    labels.add(f.label);
    facts.push({
      label: f.label,
      node_type: f.node_type,
      title: f.title,
      summary: f.summary,
      tags: f.tags,
      relations: f.relations ?? [],
      ...(f.confidence_band ? { confidence_band: f.confidence_band } : {}),
    });
  }
  // Drop relations whose target is not itself an extracted fact.
  for (const fact of facts) {
    fact.relations = fact.relations.filter((r) => labels.has(r.target));
  }
  return facts;
}

/**
 * Extract `INFERRED` facts from a transcript via the injected provider client.
 * Builds the prompt, calls the engine-side provider, and parses the response.
 * A provider that errors yields an empty list — extraction is best-effort and
 * never fails the Stop hook or `/memory:store` it runs inside.
 */
export async function extractConversation(
  transcript: string,
  client: ProviderClient,
): Promise<ExtractedFact[]> {
  if (!transcript.trim()) return [];
  let raw: string;
  try {
    raw = await client.complete(buildExtractionPrompt(transcript));
  } catch {
    return [];
  }
  return parseExtraction(raw);
}

const STRUCTURED_FACT_PREFIXES: Array<{
  pattern: RegExp;
  nodeType: NodeType;
  titlePrefix: string;
  tags: string[];
}> = [
  {
    pattern: /^(?:decision|decided)\s*:\s*(.+)$/i,
    nodeType: "decision",
    titlePrefix: "Decision",
    tags: ["decision"],
  },
  {
    pattern: /^(?:problem|issue|bug)\s*:\s*(.+)$/i,
    nodeType: "problem",
    titlePrefix: "Problem",
    tags: ["problem"],
  },
  {
    pattern: /^(?:root cause|cause)\s*:\s*(.+)$/i,
    nodeType: "problem",
    titlePrefix: "Root cause",
    tags: ["root-cause"],
  },
  {
    pattern: /^(?:fix|fixed|solution)\s*:\s*(.+)$/i,
    nodeType: "fix",
    titlePrefix: "Fix",
    tags: ["fix"],
  },
  {
    pattern: /^(?:validation|verified|test|tests)\s*:\s*(.+)$/i,
    nodeType: "validation",
    titlePrefix: "Validation",
    tags: ["validation"],
  },
  {
    pattern: /^(?:workflow|process|runbook)\s*:\s*(.+)$/i,
    nodeType: "workflow",
    titlePrefix: "Workflow",
    tags: ["workflow"],
  },
];

/**
 * Provider-free extraction for structured engineering transcripts.
 *
 * This deliberately recognizes only explicit, line-oriented facts such as
 * `Decision: ...`, `Problem: ...`, `Fix: ...`, and `Validation: ...`. It is not
 * NER or free-form summarization; it gives local-dev sessions a useful zero
 * network fallback while keeping broad inference behind the configured provider.
 */
export function extractStructuredTranscript(transcript: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  for (const rawLine of transcript.split(/\r?\n/)) {
    const line = stripSpeakerPrefix(rawLine.trim().replace(/^[-*]\s+/, ""));
    if (!line) continue;
    const def = STRUCTURED_FACT_PREFIXES.find((candidate) => candidate.pattern.test(line));
    if (!def) continue;
    const match = line.match(def.pattern);
    const text = match?.[1]?.trim();
    if (!text) continue;
    const title = `${def.titlePrefix}: ${sentenceTitle(text)}`;
    facts.push({
      label: uniqueStructuredLabel(facts, title),
      node_type: def.nodeType,
      title,
      summary: text,
      tags: def.tags,
      relations: [],
    });
  }
  addStructuredRelations(facts);
  return facts;
}

/**
 * Every kind that is a legal {@link NodeType} field value — the runtime
 * allowlist plus the structural vocabulary (which carries `import`/`transcript`,
 * absent from {@link NODE_TYPES}). A proposed kind in this set is preserved on
 * `node_type` as-is; anything else falls back to its structural home so the
 * `NodeType` field is never an out-of-vocab string (ADR 0035 type-safety).
 */
const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set<string>([
  ...NODE_TYPES,
  ...STRUCTURAL_TYPES,
]);

/** A graph fragment ready for the ingest indexer: nodes + label-keyed edges. */
export interface InferredExtraction {
  nodes: MemoryNode[];
  edges: Array<{
    fromLabel: string;
    toLabel: string;
    label: EdgeLabel;
    properties?: MemoryEdgeProps;
  }>;
}

/**
 * Materialize extracted facts into graph nodes + edges, every one stamped
 * `confidence: "INFERRED"` and `source`. Edges are emitted by label; the
 * indexer resolves labels to rids after the nodes are upserted (same contract as
 * `extractCode`'s `CodeExtraction`).
 */
export function factsToGraph(facts: ExtractedFact[], source = "conversation"): InferredExtraction {
  const nodes: MemoryNode[] = facts.map((f) => {
    // Two-axis resolution (ADR 0035 strict-write). The structural axis is gated:
    // `structural_type` is always a valid structural home (in-vocab kinds map to
    // themselves; everything else to the base type), and the proposed kind is
    // preserved losslessly on the open `engineering_code` axis — never rejected,
    // never discarded. `node_type` keeps the proposed kind when it is itself a
    // legal NodeType (backward compat) and only falls back to the structural home
    // when the kind is out of vocabulary, so the typed field stays valid.
    const resolution = EXTRACTION_PROFILES.strictWrite.resolve(f.node_type);
    const node_type: NodeType = KNOWN_NODE_TYPES.has(f.node_type)
      ? (f.node_type as NodeType)
      : resolution.structuralType;
    return {
      label: f.label,
      node_type,
      properties: {
        title: f.title,
        summary: f.summary,
        tags: f.tags,
        source,
        confidence: "INFERRED" as const,
        confidence_band: f.confidence_band ?? "medium",
        provenance_tier: "proxy" as const,
        structural_type: resolution.structuralType,
        engineering_code: resolution.engineeringCode ?? f.node_type,
        hash: contentHash(f.label, f.node_type, f.title, f.summary ?? ""),
      },
    };
  });

  const edges: InferredExtraction["edges"] = [];
  for (const f of facts) {
    for (const rel of f.relations) {
      edges.push({
        fromLabel: f.label,
        toLabel: rel.target,
        label: rel.label,
        properties: {
          confidence: "INFERRED",
          confidence_band: "medium",
          source,
        },
      });
    }
  }
  return { nodes, edges };
}

function stripSpeakerPrefix(line: string): string {
  return line.replace(/^(?:user|assistant|agent|system|human|codex|claude)\s*:\s*/i, "");
}

function sentenceTitle(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.slice(0, 1).toUpperCase() + compact.slice(1, 120);
}

function uniqueStructuredLabel(facts: ExtractedFact[], title: string): string {
  const base = slug(title);
  let label = base;
  let suffix = 2;
  const existing = new Set(facts.map((fact) => fact.label));
  while (existing.has(label)) {
    label = `${base}-${suffix}`;
    suffix += 1;
  }
  return label;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "structured-transcript-fact"
  );
}

function addStructuredRelations(facts: ExtractedFact[]): void {
  const lastProblem = [...facts].reverse().find((fact) => fact.node_type === "problem");
  const lastFix = [...facts].reverse().find((fact) => fact.node_type === "fix");
  for (const fact of facts) {
    if (fact.node_type === "fix" && lastProblem && fact.label !== lastProblem.label) {
      fact.relations.push({ label: "FIXES", target: lastProblem.label });
    }
    if (fact.node_type === "validation" && lastFix && fact.label !== lastFix.label) {
      lastFix.relations.push({ label: "TESTED_BY", target: fact.label });
    }
  }
}
