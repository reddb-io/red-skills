import type { StoredNode } from "./graph-store.js";
import type { Confidence, MemoryNodeProps, NodeType } from "./schema.js";

export interface MemoryMapContextStore {
  listNodes(now?: number): Promise<StoredNode[]>;
  listEdges(): Promise<Record<string, unknown>[]>;
  communities?(): Promise<Map<number, string>>;
  recordAccess?(rids: number[]): Promise<void>;
}

export interface MemoryMapContextOptions {
  mode?: "bfs" | "dfs";
  depth?: number;
  tokenBudget?: number;
  seedLimit?: number;
  contextFilters?: string[];
  now?: number;
}

export interface MemoryMapContextNode {
  rid: number;
  label: string;
  node_type: NodeType;
  source: string | null;
  source_location: string | null;
  community: string | null;
  depth: number;
  score: number;
  excerpt: string;
  confidence: Confidence | null;
}

export interface MemoryMapContextEdge {
  source_rid: number;
  target_rid: number;
  label: string;
  context: string;
  confidence: Confidence | null;
  weight: number;
  salience: number;
}

export interface MemoryMapContextSlice {
  schema_version: "memory.map_context.v1";
  query: string;
  traversal: {
    mode: "bfs" | "dfs";
    depth: number;
    context_filters: string[];
    context_source: "explicit" | "heuristic" | null;
    token_budget: number;
  };
  seeds: MemoryMapContextNode[];
  nodes: MemoryMapContextNode[];
  edges: MemoryMapContextEdge[];
  context_md: string;
  diagnostics: {
    candidates: number;
    selected_nodes: number;
    selected_edges: number;
    truncated: boolean;
    omitted_nodes: number;
    hub_threshold: number;
  };
}

interface EdgeRecord {
  source: number;
  target: number;
  label: string;
  context: string;
  confidence: Confidence | null;
  weight: number;
  salience: number;
}

const CONTEXT_HINTS: Array<[string, string[]]> = [
  ["call", ["call", "calls", "called", "caller", "callee", "invoke", "invokes", "invoked"]],
  ["import", ["import", "imports", "imported", "module", "modules", "dependency", "dependencies"]],
  ["type", ["type", "types", "interface", "interfaces", "generic", "generics"]],
  ["validation", ["test", "tests", "tested", "validation", "validations", "check", "checks"]],
  ["decision", ["decision", "decisions", "adr", "adrs", "why", "reason"]],
  ["work", ["issue", "issues", "prd", "prds", "attempt", "attempts", "task", "tasks"]],
  ["reference", ["reference", "references", "mention", "mentions", "doc", "docs"]],
];

const CONTEXT_ALIASES: Record<string, string> = {
  calls: "call",
  called: "call",
  caller: "call",
  callee: "call",
  invoke: "call",
  invocation: "call",
  imports: "import",
  imported: "import",
  dependency: "import",
  dependencies: "import",
  uses_type: "type",
  parameter_type: "type",
  return_type: "type",
  generic_arg: "type",
  tests: "validation",
  tested: "validation",
  validates: "validation",
  adr: "decision",
  adrs: "decision",
  decisions: "decision",
  issues: "work",
  prd: "work",
  prds: "work",
  attempts: "work",
  refs: "reference",
  references: "reference",
  mentions: "reference",
};

const EDGE_CONTEXT_BY_LABEL: Record<string, string> = {
  CALLS: "call",
  IMPORTS: "import",
  USES_TYPE: "type",
  IMPLEMENTS: "type",
  EXTENDS: "type",
  TESTED_BY: "validation",
  REVIEWED_BY: "validation",
  CONFIRMS: "validation",
  REFERENCES: "reference",
  MENTIONS: "reference",
  DESCRIBES: "reference",
  CONTAINS: "reference",
  DEFINED_IN: "reference",
  TOUCHED: "work",
  BLOCKS: "work",
  ENABLES: "work",
  PRECEDES: "work",
  TRIGGERS: "work",
  CAUSES: "decision",
  PREVENTS: "decision",
  SOLVES: "decision",
  FIXES: "decision",
  MITIGATES: "decision",
};

const TRUST_BY_CONFIDENCE: Record<Confidence, number> = {
  EXTRACTED: 1,
  INFERRED: 0.85,
  AMBIGUOUS: 0.6,
};

export async function buildMemoryMapContextSlice(
  store: MemoryMapContextStore,
  query: string,
  options: MemoryMapContextOptions = {},
): Promise<MemoryMapContextSlice> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("memory map-context needs a query");

  const [nodes, rawEdges, communities] = await Promise.all([
    store.listNodes(options.now),
    store.listEdges(),
    store.communities?.().catch(() => new Map<number, string>()) ?? Promise.resolve(new Map<number, string>()),
  ]);
  const edges = rawEdges.map(parseEdge).filter((edge): edge is EdgeRecord => edge != null);
  const degree = degreeMap(nodes, edges);
  const hubThreshold = hubThresholdFor(degree);
  const terms = queryTerms(trimmed);
  const scored = scoreNodes(nodes, terms);
  const seedRids = pickSeeds(scored, options.seedLimit ?? 3);
  const { filters, source } = resolveContextFilters(trimmed, options.contextFilters);
  const traversableEdges = filters.length === 0 ? edges : edges.filter((edge) => filters.includes(edge.context));
  const traversal = (options.mode ?? "bfs") === "dfs" ? traverseDfs : traverseBfs;
  const { depths, edgeKeys } = traversal(traversableEdges, seedRids, {
    depth: Math.max(0, Math.floor(options.depth ?? 2)),
    degree,
    hubThreshold,
  });
  const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
  const selectedRids = [...depths.keys()];
  const selectedEdges = traversableEdges.filter((edge) => edgeKeys.has(edgeKey(edge)));
  const scoreByRid = new Map(scored.map((item) => [item.rid, item.score]));
  const selectedNodes = selectedRids
    .map((rid) => nodeByRid.get(rid))
    .filter((node): node is StoredNode => node != null)
    .map((node) => toContextNode(node, {
      depth: depths.get(node.rid) ?? 0,
      score: scoreByRid.get(node.rid) ?? 0,
      community: communities.get(node.rid) ?? null,
    }))
    .sort((a, b) => a.depth - b.depth || b.score - a.score || b.rid - a.rid);
  const seedNodes = seedRids
    .map((rid) => selectedNodes.find((node) => node.rid === rid))
    .filter((node): node is MemoryMapContextNode => node != null);
  const contextEdges = selectedEdges.map(toContextEdge);
  const tokenBudget = Math.max(100, Math.floor(options.tokenBudget ?? 1800));
  const rendered = renderContextMarkdown(trimmed, {
    mode: options.mode ?? "bfs",
    depth: Math.max(0, Math.floor(options.depth ?? 2)),
    filters,
    source,
    tokenBudget,
    seeds: seedNodes,
    nodes: selectedNodes,
    edges: contextEdges,
  });
  await store.recordAccess?.(selectedNodes.map((node) => node.rid));
  return {
    schema_version: "memory.map_context.v1",
    query: trimmed,
    traversal: {
      mode: options.mode ?? "bfs",
      depth: Math.max(0, Math.floor(options.depth ?? 2)),
      context_filters: filters,
      context_source: source,
      token_budget: tokenBudget,
    },
    seeds: seedNodes,
    nodes: selectedNodes,
    edges: contextEdges,
    context_md: rendered.markdown,
    diagnostics: {
      candidates: scored.length,
      selected_nodes: selectedNodes.length,
      selected_edges: contextEdges.length,
      truncated: rendered.truncated,
      omitted_nodes: rendered.omittedNodes,
      hub_threshold: hubThreshold,
    },
  };
}

export function normalizeContextFilters(filters: string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of filters ?? []) {
    const key = CONTEXT_ALIASES[normalizeText(raw)] ?? normalizeText(raw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function resolveContextFilters(query: string, explicit: string[] | undefined): {
  filters: string[];
  source: "explicit" | "heuristic" | null;
} {
  const normalized = normalizeContextFilters(explicit);
  if (normalized.length > 0) return { filters: normalized, source: "explicit" };
  const terms = new Set(queryTerms(query));
  const inferred: string[] = [];
  for (const [context, hints] of CONTEXT_HINTS) {
    if (hints.some((hint) => terms.has(hint))) inferred.push(context);
  }
  return inferred.length > 0
    ? { filters: inferred, source: "heuristic" }
    : { filters: [], source: null };
}

function queryTerms(query: string): string[] {
  return normalizeText(query)
    .split(/[^a-z0-9_/-]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length > 2);
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function scoreNodes(nodes: StoredNode[], terms: string[]): Array<{ rid: number; score: number }> {
  if (terms.length === 0) return [];
  const idf = computeIdf(nodes, terms);
  const scored: Array<{ rid: number; score: number }> = [];
  for (const node of nodes) {
    const label = normalizeText(node.label);
    const bareLabel = label.replace(/^.*[#:/]/, "").replace(/\(\)$/, "");
    const source = normalizeText(node.properties.source ?? "");
    const title = normalizeText(node.properties.title ?? "");
    const summary = normalizeText(node.properties.summary ?? "");
    const content = normalizeText(node.properties.content ?? "");
    let score = 0;
    for (const term of terms) {
      const weight = idf.get(term) ?? 1;
      if (term === label || term === bareLabel || term === title) {
        score += 1000 * weight;
      } else if (label.startsWith(term) || bareLabel.startsWith(term) || title.startsWith(term)) {
        score += 100 * weight;
      } else if (label.includes(term) || title.includes(term)) {
        score += 5 * weight;
      } else if (summary.includes(term)) {
        score += 2 * weight;
      } else if (content.includes(term)) {
        score += 1 * weight;
      }
      if (source.includes(term)) score += 0.5 * weight;
    }
    if (score > 0) scored.push({ rid: node.rid, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.rid - a.rid);
}

function computeIdf(nodes: StoredNode[], terms: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const nodeTexts = nodes.map((node) => normalizeText(`${node.label} ${node.properties.title ?? ""}`));
  for (const term of terms) {
    const df = nodeTexts.filter((text) => text.includes(term)).length;
    out.set(term, Math.log(1 + nodes.length / (1 + df)));
  }
  return out;
}

function pickSeeds(scored: Array<{ rid: number; score: number }>, limit: number): number[] {
  const first = scored[0];
  if (!first) return [];
  const seeds: number[] = [];
  for (const item of scored.slice(0, Math.max(1, limit))) {
    if (seeds.length > 0 && item.score < first.score * 0.2) break;
    seeds.push(item.rid);
  }
  return seeds;
}

function parseEdge(edge: Record<string, unknown>): EdgeRecord | null {
  const source = numberFrom(edge.from_rid, edge.from, edge.FROM, edge.source, edge.source_id);
  const target = numberFrom(edge.to_rid, edge.to, edge.TO, edge.target, edge.target_id);
  if (!Number.isFinite(source) || !Number.isFinite(target)) return null;
  const label = String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "REFERENCES");
  const properties = (edge.properties ?? edge.PROPERTIES ?? {}) as Record<string, unknown>;
  const confidence = parseConfidence(properties.confidence ?? edge.confidence ?? edge.CONFIDENCE);
  const weight = numberFrom(edge.weight, edge.WEIGHT, properties.weight) || 1;
  const context = normalizeContextFilters([
    String(properties.context ?? edge.context ?? EDGE_CONTEXT_BY_LABEL[label] ?? "reference"),
  ])[0] ?? "reference";
  const salience = weight * (confidence ? TRUST_BY_CONFIDENCE[confidence] : 0.8);
  return { source, target, label, context, confidence, weight, salience };
}

function numberFrom(...values: unknown[]): number {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return Number.NaN;
}

function parseConfidence(value: unknown): Confidence | null {
  return value === "EXTRACTED" || value === "INFERRED" || value === "AMBIGUOUS"
    ? value
    : null;
}

function degreeMap(nodes: StoredNode[], edges: EdgeRecord[]): Map<number, number> {
  const degree = new Map(nodes.map((node) => [node.rid, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function hubThresholdFor(degree: Map<number, number>): number {
  const values = [...degree.values()].sort((a, b) => a - b);
  if (values.length === 0) return 50;
  const index = Math.min(values.length - 1, Math.floor(values.length * 0.99));
  return Math.max(50, values[index] ?? 50);
}

function traverseBfs(
  edges: EdgeRecord[],
  seeds: number[],
  opts: { depth: number; degree: Map<number, number>; hubThreshold: number },
): { depths: Map<number, number>; edgeKeys: Set<string> } {
  const adjacency = adjacencyMap(edges);
  const depths = new Map(seeds.map((seed) => [seed, 0]));
  const edgeKeys = new Set<string>();
  let frontier = new Set(seeds);
  const seedSet = new Set(seeds);
  for (let depth = 0; depth < opts.depth; depth++) {
    const next = new Set<number>();
    for (const rid of frontier) {
      if (!seedSet.has(rid) && (opts.degree.get(rid) ?? 0) >= opts.hubThreshold) continue;
      for (const item of adjacency.get(rid) ?? []) {
        edgeKeys.add(edgeKey(item.edge));
        if (!depths.has(item.neighbor)) {
          depths.set(item.neighbor, depth + 1);
          next.add(item.neighbor);
        }
      }
    }
    frontier = next;
  }
  return { depths, edgeKeys };
}

function traverseDfs(
  edges: EdgeRecord[],
  seeds: number[],
  opts: { depth: number; degree: Map<number, number>; hubThreshold: number },
): { depths: Map<number, number>; edgeKeys: Set<string> } {
  const adjacency = adjacencyMap(edges);
  const depths = new Map<number, number>();
  const edgeKeys = new Set<string>();
  const seedSet = new Set(seeds);
  const stack = seeds.map((rid) => ({ rid, depth: 0 })).reverse();
  while (stack.length > 0) {
    const item = stack.pop()!;
    const previous = depths.get(item.rid);
    if (previous != null && previous <= item.depth) continue;
    if (item.depth > opts.depth) continue;
    depths.set(item.rid, item.depth);
    if (!seedSet.has(item.rid) && (opts.degree.get(item.rid) ?? 0) >= opts.hubThreshold) continue;
    if (item.depth >= opts.depth) continue;
    for (const next of adjacency.get(item.rid) ?? []) {
      edgeKeys.add(edgeKey(next.edge));
      stack.push({ rid: next.neighbor, depth: item.depth + 1 });
    }
  }
  return { depths, edgeKeys };
}

function adjacencyMap(edges: EdgeRecord[]): Map<number, Array<{ neighbor: number; edge: EdgeRecord }>> {
  const adjacency = new Map<number, Array<{ neighbor: number; edge: EdgeRecord }>>();
  for (const edge of edges) {
    const from = adjacency.get(edge.source) ?? [];
    from.push({ neighbor: edge.target, edge });
    adjacency.set(edge.source, from);
    const to = adjacency.get(edge.target) ?? [];
    to.push({ neighbor: edge.source, edge });
    adjacency.set(edge.target, to);
  }
  return adjacency;
}

function edgeKey(edge: EdgeRecord): string {
  return `${edge.source}->${edge.target}:${edge.label}`;
}

function toContextNode(
  node: StoredNode,
  opts: { depth: number; score: number; community: string | null },
): MemoryMapContextNode {
  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    source: stringOrNull(node.properties.source),
    source_location: stringOrNull(node.properties.source_location ?? node.properties.location),
    community: opts.community,
    depth: opts.depth,
    score: Number(opts.score.toFixed(3)),
    excerpt: excerpt(node.properties),
    confidence: parseConfidence(node.properties.confidence),
  };
}

function toContextEdge(edge: EdgeRecord): MemoryMapContextEdge {
  return {
    source_rid: edge.source,
    target_rid: edge.target,
    label: edge.label,
    context: edge.context,
    confidence: edge.confidence,
    weight: edge.weight,
    salience: Number(edge.salience.toFixed(3)),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function excerpt(props: MemoryNodeProps): string {
  const text = String(props.summary ?? props.content ?? props.title ?? "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function renderContextMarkdown(
  query: string,
  input: {
    mode: "bfs" | "dfs";
    depth: number;
    filters: string[];
    source: "explicit" | "heuristic" | null;
    tokenBudget: number;
    seeds: MemoryMapContextNode[];
    nodes: MemoryMapContextNode[];
    edges: MemoryMapContextEdge[];
  },
): { markdown: string; truncated: boolean; omittedNodes: number } {
  const lines = [
    `Memory map context: ${query}`,
    `Traversal: ${input.mode.toUpperCase()} depth=${input.depth} | Start: ${input.seeds.map((s) => s.label).join(", ") || "none"}${input.filters.length ? ` | Context: ${input.filters.join(", ")} (${input.source})` : ""} | ${input.nodes.length} node(s)`,
    "",
  ];
  for (const node of input.nodes) {
    lines.push(
      `NODE ${node.rid} ${node.label} [type=${node.node_type} src=${node.source ?? "-"} loc=${node.source_location ?? "-"} community=${node.community ?? "-"} depth=${node.depth}]`,
    );
    if (node.excerpt) lines.push(`  ${node.excerpt}`);
  }
  for (const edge of input.edges) {
    lines.push(
      `EDGE ${edge.source_rid} --${edge.label} [${edge.confidence ?? "UNKNOWN"} context=${edge.context} weight=${edge.weight} salience=${edge.salience}]--> ${edge.target_rid}`,
    );
  }
  const charBudget = input.tokenBudget * 3;
  const output = lines.join("\n");
  if (output.length <= charBudget) return { markdown: output, truncated: false, omittedNodes: 0 };
  const cut = Math.max(0, output.slice(0, charBudget).lastIndexOf("\n"));
  const shown = output.slice(0, cut).split("\n").filter((line) => line.startsWith("NODE ")).length;
  const omitted = Math.max(0, input.nodes.length - shown);
  return {
    markdown: `${output.slice(0, cut)}\n... (truncated: ${omitted} node(s) omitted by ~${input.tokenBudget}-token budget; narrow with --context or --depth)`,
    truncated: true,
    omittedNodes: omitted,
  };
}
