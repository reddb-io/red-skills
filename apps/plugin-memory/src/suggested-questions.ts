import { graphStateHash } from "./communities.js";
import {
  type AiProviderConfig,
  type Egress,
  type ProviderClient,
  type ProviderMode,
  resolveProvider,
} from "./extract-conversation.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";
import { redDbProviderClient } from "./provider-client.js";

export type SuggestedQuestionSignalType =
  | "hub"
  | "bridge"
  | "weak_community"
  | "inferred_edge";

export interface SuggestedQuestionReference {
  kind: "node" | "edge" | "community";
  rid?: number;
  label?: string;
  title?: string;
  from_rid?: number;
  to_rid?: number;
  community_id?: string;
}

export interface SuggestedQuestionSignal {
  signal_id: string;
  signal_type: SuggestedQuestionSignalType;
  title: string;
  rationale: string;
  score: number;
  references: SuggestedQuestionReference[];
}

export interface SuggestedQuestion {
  id: string;
  signal_id: string;
  signal_type: SuggestedQuestionSignalType;
  question: string;
  rationale: string;
  references: SuggestedQuestionReference[];
}

export interface SuggestedQuestionsProviderStatus {
  status: "available" | "unavailable";
  mode: ProviderMode | null;
  model: string | null;
  egress: Egress | null;
  error?: string;
}

export interface SuggestedQuestionsReport {
  schema_version: "memory.suggested-questions.v1";
  read_only: true;
  graph_hash: string;
  generated_at: string;
  provider: SuggestedQuestionsProviderStatus;
  summary: {
    status: "empty_graph" | "no_notable_signals" | "provider_unavailable" | "ready";
    nodes: number;
    edges: number;
    signals: number;
    questions: number;
    next: string[];
  };
  signals: SuggestedQuestionSignal[];
  questions: SuggestedQuestion[];
}

export interface SuggestedQuestionsOptions {
  limit?: number;
  now?: Date;
  providerConfig?: AiProviderConfig;
  providerClient?: ProviderClient;
}

interface NormalizedEdge {
  from: number;
  to: number;
  label: string;
  seal: string;
  weight: number;
  confidence: number | null;
}

interface DegreeStats {
  total: number;
  in: number;
  out: number;
}

interface CommunityStats {
  community_id: string;
  members: StoredNode[];
  internal_weight: number;
  external_weight: number;
  cohesion: number;
}

const DEFAULT_LIMIT = 12;
const NEXT_STEPS = [
  "memory hub-report --json",
  "memory communities --json",
  "memory path-explain <from> <to>",
];

export async function buildSuggestedQuestions(
  store: MemoryStore,
  opts: SuggestedQuestionsOptions = {},
): Promise<SuggestedQuestionsReport> {
  const limit = clampLimit(opts.limit);
  const provider = resolveProviderStatus(opts.providerConfig);
  const [nodes, rawEdges, assignments] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    store.communities(),
  ]);
  const edges = rawEdges.map(normalizeEdge).filter((edge): edge is NormalizedEdge => edge != null);
  const graphHash = graphStateHash(nodes, rawEdges);
  const signals = selectSignals(nodes, edges, assignments).slice(0, limit);
  let finalProvider = provider;
  let questions: SuggestedQuestion[] = [];

  if (signals.length > 0 && provider.status === "available" && opts.providerConfig) {
    const client = opts.providerClient ?? redDbProviderClient(store, opts.providerConfig);
    const phrased = await phraseQuestions(client, signals);
    if (phrased.error) {
      finalProvider = { ...provider, status: "unavailable", error: phrased.error };
    } else {
      questions = phrased.questions.slice(0, limit);
    }
  }

  return {
    schema_version: "memory.suggested-questions.v1",
    read_only: true,
    graph_hash: graphHash,
    generated_at: (opts.now ?? new Date()).toISOString(),
    provider: finalProvider,
    summary: {
      status: summaryStatus(nodes.length, signals.length, finalProvider, questions.length),
      nodes: nodes.length,
      edges: rawEdges.length,
      signals: signals.length,
      questions: questions.length,
      next: NEXT_STEPS,
    },
    signals,
    questions,
  };
}

function selectSignals(
  nodes: StoredNode[],
  edges: NormalizedEdge[],
  assignments: Map<number, string>,
): SuggestedQuestionSignal[] {
  const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
  const degreeByRid = degreeStats(nodes, edges);
  const signals: SuggestedQuestionSignal[] = [
    ...hubSignals(nodes, degreeByRid, assignments),
    ...bridgeSignals(edges, nodeByRid, assignments),
    ...weakCommunitySignals(nodes, edges, assignments),
    ...inferredEdgeSignals(edges, nodeByRid, assignments),
  ];
  return signals.sort(compareSignals);
}

function hubSignals(
  nodes: StoredNode[],
  degreeByRid: Map<number, DegreeStats>,
  assignments: Map<number, string>,
): SuggestedQuestionSignal[] {
  return nodes
    .map((node) => ({ node, stats: degreeByRid.get(node.rid) ?? { total: 0, in: 0, out: 0 } }))
    .filter(({ stats }) => stats.total >= 3)
    .map(({ node, stats }) => ({
      signal_id: `hub:${node.rid}`,
      signal_type: "hub" as const,
      title: nodeTitle(node),
      rationale: `${node.label} is connected to ${stats.total} graph edge(s).`,
      score: stats.total,
      references: [
        nodeRef(node),
        ...(assignments.has(node.rid)
          ? [{ kind: "community" as const, community_id: assignments.get(node.rid) }]
          : []),
      ],
    }));
}

function bridgeSignals(
  edges: NormalizedEdge[],
  nodeByRid: Map<number, StoredNode>,
  assignments: Map<number, string>,
): SuggestedQuestionSignal[] {
  return edges
    .map<SuggestedQuestionSignal | null>((edge) => {
      const fromCommunity = assignments.get(edge.from);
      const toCommunity = assignments.get(edge.to);
      if (!fromCommunity || !toCommunity || fromCommunity === toCommunity) return null;
      const from = nodeByRid.get(edge.from);
      const to = nodeByRid.get(edge.to);
      if (!from || !to) return null;
      return {
        signal_id: `bridge:${edge.from}->${edge.to}:${edge.label}`,
        signal_type: "bridge" as const,
        title: `${from.label} -> ${to.label}`,
        rationale: `${edge.label} links community ${fromCommunity} to ${toCommunity}.`,
        score: edge.weight,
        references: [
          edgeRef(edge),
          nodeRef(from),
          nodeRef(to),
          { kind: "community" as const, community_id: fromCommunity },
          { kind: "community" as const, community_id: toCommunity },
        ],
      };
    })
    .filter((signal): signal is SuggestedQuestionSignal => signal != null);
}

function weakCommunitySignals(
  nodes: StoredNode[],
  edges: NormalizedEdge[],
  assignments: Map<number, string>,
): SuggestedQuestionSignal[] {
  return communityStats(nodes, edges, assignments)
    .filter((community) => {
      const total = community.internal_weight + community.external_weight;
      return community.members.length >= 2 && total > 0 && community.cohesion < 0.5;
    })
    .map((community) => ({
      signal_id: `weak-community:${community.community_id}`,
      signal_type: "weak_community" as const,
      title: community.community_id,
      rationale: `Community ${community.community_id} has cohesion ${round3(community.cohesion)} with ${community.external_weight} external edge weight.`,
      score: 1 - community.cohesion,
      references: [
        { kind: "community" as const, community_id: community.community_id },
        ...community.members.slice(0, 5).map(nodeRef),
      ],
    }));
}

function inferredEdgeSignals(
  edges: NormalizedEdge[],
  nodeByRid: Map<number, StoredNode>,
  assignments: Map<number, string>,
): SuggestedQuestionSignal[] {
  return edges
    .filter((edge) => edge.seal === "INFERRED" && (edge.confidence == null || edge.confidence >= 0.75))
    .map<SuggestedQuestionSignal | null>((edge) => {
      const from = nodeByRid.get(edge.from);
      const to = nodeByRid.get(edge.to);
      if (!from || !to) return null;
      return {
        signal_id: `inferred-edge:${edge.from}->${edge.to}:${edge.label}`,
        signal_type: "inferred_edge" as const,
        title: `${from.label} -> ${to.label}`,
        rationale: `${edge.label} is marked INFERRED${edge.confidence == null ? "" : ` with confidence ${edge.confidence}`}.`,
        score: edge.confidence ?? 0.75,
        references: [
          edgeRef(edge),
          nodeRef(from),
          nodeRef(to),
          ...(assignments.has(edge.from)
            ? [{ kind: "community" as const, community_id: assignments.get(edge.from) }]
            : []),
          ...(assignments.has(edge.to)
            ? [{ kind: "community" as const, community_id: assignments.get(edge.to) }]
            : []),
        ],
      };
    })
    .filter((signal): signal is SuggestedQuestionSignal => signal != null);
}

async function phraseQuestions(
  client: ProviderClient,
  signals: SuggestedQuestionSignal[],
): Promise<{ questions: SuggestedQuestion[]; error?: undefined } | { questions: []; error: string }> {
  try {
    const raw = await client.complete({
      system: [
        "You write concise questions for an engineering agent exploring a Memory graph.",
        "Return ONLY JSON of the form:",
        '{ "questions": [ { "signal_id": string, "question": string } ] }',
        "Use the supplied graph references. Do not invent new evidence.",
      ].join("\n"),
      user: JSON.stringify({
        task: "suggested-questions",
        signals: signals.map((signal) => ({
          signal_id: signal.signal_id,
          signal_type: signal.signal_type,
          title: signal.title,
          rationale: signal.rationale,
          references: signal.references,
        })),
      }),
    });
    return { questions: applyProviderQuestions(raw, signals) };
  } catch (err) {
    return { questions: [], error: `question phrasing failed: ${errorMessage(err)}` };
  }
}

function applyProviderQuestions(raw: string, signals: SuggestedQuestionSignal[]): SuggestedQuestion[] {
  const parsed = parseJson(raw);
  if (!parsed || !Array.isArray(parsed.questions)) return [];
  const signalById = new Map(signals.map((signal) => [signal.signal_id, signal]));
  const seen = new Set<string>();
  const questions: SuggestedQuestion[] = [];
  for (const item of parsed.questions) {
    if (!item || typeof item !== "object") continue;
    const signalId = stringValue((item as Record<string, unknown>).signal_id);
    const question = sanitizeQuestion(stringValue((item as Record<string, unknown>).question));
    const signal = signalId ? signalById.get(signalId) : undefined;
    if (!signal || !question || seen.has(signal.signal_id)) continue;
    seen.add(signal.signal_id);
    questions.push({
      id: `question:${signal.signal_id}`,
      signal_id: signal.signal_id,
      signal_type: signal.signal_type,
      question,
      rationale: signal.rationale,
      references: signal.references,
    });
  }
  return questions;
}

function degreeStats(nodes: StoredNode[], edges: NormalizedEdge[]): Map<number, DegreeStats> {
  const map = new Map<number, DegreeStats>();
  for (const node of nodes) {
    map.set(node.rid, { total: 0, in: 0, out: 0 });
  }
  for (const edge of edges) {
    const from = map.get(edge.from);
    const to = map.get(edge.to);
    if (!from || !to) continue;
    from.total += 1;
    from.out += 1;
    to.total += 1;
    to.in += 1;
  }
  return map;
}

function communityStats(
  nodes: StoredNode[],
  edges: NormalizedEdge[],
  assignments: Map<number, string>,
): CommunityStats[] {
  const groups = new Map<string, StoredNode[]>();
  for (const node of nodes) {
    const communityId = assignments.get(node.rid);
    if (!communityId) continue;
    const group = groups.get(communityId) ?? [];
    group.push(node);
    groups.set(communityId, group);
  }
  const weights = new Map<string, { internal: number; external: number }>();
  for (const communityId of groups.keys()) {
    weights.set(communityId, { internal: 0, external: 0 });
  }
  for (const edge of edges) {
    const fromCommunity = assignments.get(edge.from);
    const toCommunity = assignments.get(edge.to);
    if (!fromCommunity || !toCommunity) continue;
    if (fromCommunity === toCommunity) {
      const current = weights.get(fromCommunity);
      if (current) current.internal += edge.weight;
    } else {
      const from = weights.get(fromCommunity);
      const to = weights.get(toCommunity);
      if (from) from.external += edge.weight;
      if (to) to.external += edge.weight;
    }
  }
  return [...groups.entries()]
    .map(([community_id, members]) => {
      const weight = weights.get(community_id) ?? { internal: 0, external: 0 };
      const total = weight.internal + weight.external;
      return {
        community_id,
        members: members.slice().sort((a, b) => a.label.localeCompare(b.label)),
        internal_weight: round3(weight.internal),
        external_weight: round3(weight.external),
        cohesion: total === 0 ? 0 : round3(weight.internal / total),
      };
    })
    .sort(
      (a, b) =>
        a.cohesion - b.cohesion ||
        b.external_weight - a.external_weight ||
        a.community_id.localeCompare(b.community_id),
    );
}

function normalizeEdge(edge: Record<string, unknown>): NormalizedEdge | null {
  const from = edgeEndpoint(edge, "from");
  const to = edgeEndpoint(edge, "to");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return null;
  return {
    from,
    to,
    label: String(edge.label ?? edge.LABEL ?? ""),
    seal: edgeSeal(edge),
    weight: edgeWeight(edge),
    confidence: numberValue(propertyValue(edge, "confidence_score") ?? propertyValue(edge, "score")),
  };
}

function edgeEndpoint(edge: Record<string, unknown>, side: "from" | "to"): number {
  const value =
    side === "from"
      ? edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM
      : edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO;
  return Number(value ?? 0);
}

function edgeWeight(edge: Record<string, unknown>): number {
  const weight = Number(edge.weight ?? edge.WEIGHT ?? propertyValue(edge, "weight") ?? 1);
  return Number.isFinite(weight) && weight > 0 ? weight : 1;
}

function edgeSeal(edge: Record<string, unknown>): string {
  const value =
    edge.seal ??
    edge.audit_seal ??
    edge.confidence ??
    propertyValue(edge, "seal") ??
    propertyValue(edge, "audit_seal") ??
    propertyValue(edge, "confidence") ??
    edge.label ??
    edge.LABEL;
  return String(value ?? "unsealed").toUpperCase();
}

function propertyValue(edge: Record<string, unknown>, key: string): unknown {
  const properties = isRecord(edge.properties)
    ? edge.properties
    : isRecord(edge.PROPERTIES)
      ? edge.PROPERTIES
      : {};
  return properties[key];
}

function nodeRef(node: StoredNode): SuggestedQuestionReference {
  return {
    kind: "node",
    rid: node.rid,
    label: node.label,
    title: nodeTitle(node),
  };
}

function edgeRef(edge: NormalizedEdge): SuggestedQuestionReference {
  return {
    kind: "edge",
    label: edge.label,
    from_rid: edge.from,
    to_rid: edge.to,
  };
}

function nodeTitle(node: StoredNode): string {
  return node.properties.title ?? node.label;
}

function compareSignals(a: SuggestedQuestionSignal, b: SuggestedQuestionSignal): number {
  return (
    signalRank(a.signal_type) - signalRank(b.signal_type) ||
    b.score - a.score ||
    a.title.localeCompare(b.title) ||
    a.signal_id.localeCompare(b.signal_id)
  );
}

function signalRank(type: SuggestedQuestionSignalType): number {
  switch (type) {
    case "hub":
      return 0;
    case "bridge":
      return 1;
    case "weak_community":
      return 2;
    case "inferred_edge":
      return 3;
  }
}

function resolveProviderStatus(config: AiProviderConfig | undefined): SuggestedQuestionsProviderStatus {
  if (!config) {
    return {
      status: "unavailable",
      mode: null,
      model: null,
      egress: null,
      error: "no AI provider configured for suggested questions",
    };
  }
  try {
    const provider = resolveProvider(config);
    return {
      status: "available",
      mode: provider.mode,
      model: provider.model,
      egress: provider.egress,
    };
  } catch (err) {
    return {
      status: "unavailable",
      mode: null,
      model: null,
      egress: null,
      error: errorMessage(err),
    };
  }
}

function summaryStatus(
  nodeCount: number,
  signalCount: number,
  provider: SuggestedQuestionsProviderStatus,
  questionCount: number,
): SuggestedQuestionsReport["summary"]["status"] {
  if (nodeCount === 0) return "empty_graph";
  if (signalCount === 0) return "no_notable_signals";
  if (provider.status !== "available" || questionCount === 0) return "provider_unavailable";
  return "ready";
}

function sanitizeQuestion(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.endsWith("?") ? trimmed : `${trimmed}?`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(50, Math.trunc(limit)));
}

function round3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
