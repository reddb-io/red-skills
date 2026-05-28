import { z } from "zod";
import { contentHash } from "./hash.js";
/** Runtime allowlist of node types (mirrors `NodeType` in schema.ts). */
export const NODE_TYPES = [
    "file",
    "symbol",
    "concept",
    "decision",
    "problem",
    "solution",
    "fix",
    "workflow",
    "person",
    "why_note",
    "session",
    "task",
    "goal",
    "attempt",
    "issue",
    "prd",
    "validation",
];
/** Runtime allowlist of edge labels (mirrors `EdgeLabel` in schema.ts). */
export const EDGE_LABELS = [
    "CAUSES",
    "PREVENTS",
    "BLOCKS",
    "ENABLES",
    "SOLVES",
    "FIXES",
    "MITIGATES",
    "SUPERSEDED_BY",
    "DEPRECATED_BY",
    "MENTIONS",
    "REFERENCES",
    "DESCRIBES",
    "CONTAINS",
    "DEFINED_IN",
    "CALLS",
    "IMPORTS",
    "IMPLEMENTS",
    "EXTENDS",
    "USES_TYPE",
    "LEARNED_FROM",
    "CONTRADICTS",
    "CONFIRMS",
    "EXAMPLE_OF",
    "PRECEDES",
    "TRIGGERS",
    "RUNS_AFTER",
    "TESTED_BY",
    "REVIEWED_BY",
    "OWNED_BY",
];
// Loopback hosts that keep inference on the machine.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
/**
 * Resolve a provider config into the concrete endpoint + egress classification.
 *
 * - `openai-compat`: uses `baseUrl`. Egress is `local` when the host is a
 *   loopback address (a local Ollama / on-box server), `external` otherwise.
 *   A missing `baseUrl` is a config error — the compat mode needs one.
 * - `openai-native` / `anthropic-native`: hit the vendor's own endpoint, so
 *   egress is always `external` and `endpoint` is null (the provider decides).
 */
export function resolveProvider(config) {
    if (config.mode === "openai-compat") {
        if (!config.baseUrl) {
            throw new Error("openai-compat provider requires a baseUrl");
        }
        let host;
        try {
            host = new URL(config.baseUrl).hostname;
        }
        catch {
            throw new Error(`invalid provider baseUrl: ${config.baseUrl}`);
        }
        return {
            mode: config.mode,
            model: config.model,
            endpoint: config.baseUrl,
            egress: LOCAL_HOSTS.has(host) ? "local" : "external",
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
    "- Prefer fewer, higher-signal facts. Return an empty array when nothing is",
    "  worth remembering.",
].join("\n");
/**
 * Build the deterministic extraction prompt for a transcript. The system turn
 * pins the output schema and the node-type / edge-label allowlists; the user
 * turn carries the transcript verbatim. Same input ⇒ same prompt — the property
 * the golden-file tests lock down.
 */
export function buildExtractionPrompt(transcript) {
    return {
        system: SYSTEM_PROMPT,
        user: `Transcript:\n\n${transcript.trim()}`,
    };
}
const RelationSchema = z.object({
    label: z.enum(EDGE_LABELS),
    target: z.string().min(1),
});
const FactSchema = z.object({
    label: z.string().min(1),
    node_type: z.enum(NODE_TYPES),
    title: z.string().min(1),
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    relations: z.array(RelationSchema).optional(),
});
const ResponseSchema = z.object({ facts: z.array(z.unknown()) });
/** Strip a ```json fence if the model wrapped its JSON despite instructions. */
function unfence(raw) {
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
export function parseExtraction(raw) {
    let parsed;
    try {
        parsed = JSON.parse(unfence(raw));
    }
    catch {
        return [];
    }
    const envelope = ResponseSchema.safeParse(parsed);
    if (!envelope.success)
        return [];
    const facts = [];
    const labels = new Set();
    for (const candidate of envelope.data.facts) {
        const result = FactSchema.safeParse(candidate);
        if (!result.success)
            continue;
        const f = result.data;
        if (labels.has(f.label))
            continue; // dedupe by label within one response
        labels.add(f.label);
        facts.push({
            label: f.label,
            node_type: f.node_type,
            title: f.title,
            summary: f.summary,
            tags: f.tags,
            relations: f.relations ?? [],
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
export async function extractConversation(transcript, client) {
    if (!transcript.trim())
        return [];
    let raw;
    try {
        raw = await client.complete(buildExtractionPrompt(transcript));
    }
    catch {
        return [];
    }
    return parseExtraction(raw);
}
const STRUCTURED_FACT_PREFIXES = [
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
export function extractStructuredTranscript(transcript) {
    const facts = [];
    for (const rawLine of transcript.split(/\r?\n/)) {
        const line = stripSpeakerPrefix(rawLine.trim().replace(/^[-*]\s+/, ""));
        if (!line)
            continue;
        const def = STRUCTURED_FACT_PREFIXES.find((candidate) => candidate.pattern.test(line));
        if (!def)
            continue;
        const match = line.match(def.pattern);
        const text = match?.[1]?.trim();
        if (!text)
            continue;
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
 * Materialize extracted facts into graph nodes + edges, every one stamped
 * `confidence: "INFERRED"` and `source`. Edges are emitted by label; the
 * indexer resolves labels to rids after the nodes are upserted (same contract as
 * `extractCode`'s `CodeExtraction`).
 */
export function factsToGraph(facts, source = "conversation") {
    const nodes = facts.map((f) => ({
        label: f.label,
        node_type: f.node_type,
        properties: {
            title: f.title,
            summary: f.summary,
            tags: f.tags,
            source,
            confidence: "INFERRED",
            hash: contentHash(f.label, f.node_type, f.title, f.summary ?? ""),
        },
    }));
    const edges = [];
    for (const f of facts) {
        for (const rel of f.relations) {
            edges.push({ fromLabel: f.label, toLabel: rel.target, label: rel.label });
        }
    }
    return { nodes, edges };
}
function stripSpeakerPrefix(line) {
    return line.replace(/^(?:user|assistant|agent|system|human|codex|claude)\s*:\s*/i, "");
}
function sentenceTitle(text) {
    const compact = text.replace(/\s+/g, " ").trim();
    return compact.slice(0, 1).toUpperCase() + compact.slice(1, 120);
}
function uniqueStructuredLabel(facts, title) {
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
function slug(value) {
    return (value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80) || "structured-transcript-fact");
}
function addStructuredRelations(facts) {
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
