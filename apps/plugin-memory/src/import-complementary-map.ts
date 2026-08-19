import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { contentHash } from "./hash.js";
import type { MemoryStore } from "./graph-store.js";
import type { Confidence, EdgeLabel, MemoryEdge, MemoryNode, NodeType } from "./schema.js";

export type ComplementaryMapSourceKind = "graphify" | "scip" | "lsp" | "static-analysis";

export interface ComplementaryMapImportOptions {
  rootDir: string;
  sourceKind?: ComplementaryMapSourceKind;
  command?: string;
  now?: number;
}

export interface ComplementaryMapImportReport {
  schema_version: "memory.complementary_map_import.v1";
  destination: "RedDB";
  source_kind: ComplementaryMapSourceKind;
  artifact_path: string;
  nodes: {
    input: number;
    imported: number;
    overlapped: number;
    skipped: number;
  };
  edges: {
    input: number;
    imported: number;
    overlapped: number;
    skipped: number;
  };
  warnings: string[];
}

interface RawComplementaryMap {
  source_kind?: unknown;
  kind?: unknown;
  tool?: unknown;
  generated_at?: unknown;
  nodes?: unknown;
  edges?: unknown;
}

interface RawMapNode {
  id?: unknown;
  kind?: unknown;
  type?: unknown;
  label?: unknown;
  name?: unknown;
  path?: unknown;
  confidence?: unknown;
  freshness?: unknown;
  generated_at?: unknown;
  updated_at?: unknown;
  properties?: unknown;
}

interface RawMapEdge {
  from?: unknown;
  source?: unknown;
  to?: unknown;
  target?: unknown;
  kind?: unknown;
  type?: unknown;
  label?: unknown;
  weight?: unknown;
  salience?: unknown;
  confidence?: unknown;
  freshness?: unknown;
  generated_at?: unknown;
  updated_at?: unknown;
  properties?: unknown;
}

interface NormalizedNode {
  sourceId: string;
  node: MemoryNode;
}

interface NormalizedEdge {
  fromSourceId: string;
  toSourceId: string;
  edge: Omit<MemoryEdge, "from_rid" | "to_rid">;
}

const NODE_KIND_MAP: Record<string, NodeType> = {
  file: "file",
  module: "file",
  symbol: "symbol",
  function: "symbol",
  method: "symbol",
  class: "symbol",
  interface: "symbol",
  type: "symbol",
  struct: "symbol",
  import: "import",
  dependency: "import",
  community: "concept",
  concept: "concept",
};

const SYMBOL_KINDS = new Set(["symbol", "function", "method", "class", "interface", "type", "struct"]);

const EDGE_KIND_MAP: Record<string, { label: EdgeLabel; reverse?: boolean; baseWeight: number }> = {
  CALLS: { label: "CALLS", baseWeight: 0.85 },
  CALL: { label: "CALLS", baseWeight: 0.85 },
  USES_TYPE: { label: "USES_TYPE", baseWeight: 0.8 },
  USES: { label: "USES_TYPE", baseWeight: 0.65 },
  IMPORTS: { label: "IMPORTS", baseWeight: 0.8 },
  IMPORT: { label: "IMPORTS", baseWeight: 0.8 },
  DEFINES: { label: "DEFINED_IN", reverse: true, baseWeight: 0.9 },
  DEFINED_IN: { label: "DEFINED_IN", baseWeight: 0.9 },
  IMPLEMENTS: { label: "IMPLEMENTS", baseWeight: 0.75 },
  EXTENDS: { label: "EXTENDS", baseWeight: 0.75 },
  REFERENCES: { label: "REFERENCES", baseWeight: 0.6 },
  REFERENCE: { label: "REFERENCES", baseWeight: 0.6 },
  MENTIONS: { label: "MENTIONS", baseWeight: 0.5 },
  GROUPS: { label: "CONTAINS", baseWeight: 0.55 },
  CONTAINS: { label: "CONTAINS", baseWeight: 0.7 },
  DEPENDS_ON: { label: "REFERENCES", baseWeight: 0.6 },
};

export async function importComplementaryMapFile(
  store: MemoryStore,
  artifactPath: string,
  opts: ComplementaryMapImportOptions,
): Promise<ComplementaryMapImportReport> {
  const resolved = isAbsolute(artifactPath) ? artifactPath : resolve(opts.rootDir, artifactPath);
  const raw = parseComplementaryMap(await readFile(resolved, "utf8"));
  const sourceKind = normalizeSourceKind(opts.sourceKind ?? stringValue(raw.source_kind) ?? stringValue(raw.kind) ?? stringValue(raw.tool));
  return importComplementaryMap(store, raw, resolved, {
    ...opts,
    sourceKind,
  });
}

export async function importComplementaryMap(
  store: MemoryStore,
  raw: RawComplementaryMap,
  artifactPath: string,
  opts: ComplementaryMapImportOptions,
): Promise<ComplementaryMapImportReport> {
  const now = opts.now ?? Date.now();
  const sourceKind = normalizeSourceKind(opts.sourceKind ?? stringValue(raw.source_kind));
  const artifactFreshness = await artifactFreshnessMs(artifactPath, raw.generated_at);
  const rawNodes = arrayOfRecords(raw.nodes);
  const rawEdges = arrayOfRecords(raw.edges);
  const warnings: string[] = [];
  const sourceIdToRid = new Map<string, number>();
  const nodeReport = { input: rawNodes.length, imported: 0, overlapped: 0, skipped: 0 };
  const edgeReport = { input: rawEdges.length, imported: 0, overlapped: 0, skipped: 0 };

  for (const rawNode of rawNodes) {
    const normalized = normalizeNode(rawNode, {
      artifactPath,
      rootDir: opts.rootDir,
      sourceKind,
      now,
      artifactFreshness,
      command: opts.command,
    });
    if (!normalized) {
      nodeReport.skipped += 1;
      continue;
    }
    const existing = await store.findNodeByLabel(normalized.node.label, normalized.node.node_type);
    const before = await store.findNodeByHash(String(normalized.node.properties.hash ?? ""));
    const rid = existing ?? (await store.upsertNode(normalized.node));
    sourceIdToRid.set(normalized.sourceId, rid);
    if (existing != null || before != null) nodeReport.overlapped += 1;
    else nodeReport.imported += 1;
  }

  for (const rawEdge of rawEdges) {
    const normalized = normalizeEdge(rawEdge, {
      artifactPath,
      sourceKind,
      now,
      artifactFreshness,
      command: opts.command,
    });
    if (!normalized) {
      edgeReport.skipped += 1;
      continue;
    }
    const fromRid = sourceIdToRid.get(normalized.fromSourceId);
    const toRid = sourceIdToRid.get(normalized.toSourceId);
    if (fromRid == null || toRid == null) {
      edgeReport.skipped += 1;
      warnings.push(
        `skipped edge ${normalized.fromSourceId} -> ${normalized.toSourceId}: endpoint missing`,
      );
      continue;
    }
    const existing = await store.findEdge(fromRid, toRid, normalized.edge.label);
    await store.upsertEdge({
      ...normalized.edge,
      from_rid: fromRid,
      to_rid: toRid,
    });
    if (existing != null) edgeReport.overlapped += 1;
    else edgeReport.imported += 1;
  }

  return {
    schema_version: "memory.complementary_map_import.v1",
    destination: "RedDB",
    source_kind: sourceKind,
    artifact_path: artifactPath,
    nodes: nodeReport,
    edges: edgeReport,
    warnings,
  };
}

function parseComplementaryMap(raw: string): RawComplementaryMap {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("complementary map import expects a JSON object");
  if (!Array.isArray(parsed.nodes)) throw new Error("complementary map import expects nodes[]");
  if (!Array.isArray(parsed.edges)) throw new Error("complementary map import expects edges[]");
  return parsed as RawComplementaryMap;
}

function normalizeNode(
  raw: Record<string, unknown>,
  context: {
    artifactPath: string;
    rootDir: string;
    sourceKind: ComplementaryMapSourceKind;
    now: number;
    artifactFreshness: number | undefined;
    command: string | undefined;
  },
): NormalizedNode | null {
  const sourceId = stringValue(raw.id);
  if (!sourceId) return null;
  const kind = lowerKind(raw.kind ?? raw.type);
  const nodeType = NODE_KIND_MAP[kind] ?? "concept";
  const title = stringValue(raw.name) ?? stringValue(raw.label) ?? sourceId;
  const rawPath = stringValue(raw.path) ?? pathFromSourceId(sourceId);
  const path = rawPath && !isAbsolute(rawPath) ? resolve(context.rootDir, rawPath) : rawPath;
  const label = canonicalNodeLabel({ sourceId, kind, nodeType, title, path });
  const sourceConfidence = normalizeConfidenceScore(raw.confidence);
  const freshness = normalizeFreshness(raw.freshness ?? raw.updated_at ?? raw.generated_at, context.artifactFreshness);
  const rawProps = isRecord(raw.properties) ? raw.properties : {};
  const confidence: Confidence = "EXTRACTED";
  const symbolKind = SYMBOL_KINDS.has(kind) ? symbolKindForHash(kind) : undefined;
  return {
    sourceId,
    node: {
      label,
      node_type: nodeType,
      properties: {
        ...rawProps,
        title,
        summary: kind || undefined,
        source: context.artifactPath,
        confidence,
        provenance: {
          source_kind: "external-map",
          writer: "import-complementary-map",
          command: context.command,
          confidence,
          evidence: [`${context.artifactPath}#node:${sourceId}`],
          created_at: context.now,
          updated_at: context.now,
          map_source_kind: context.sourceKind,
          freshness,
        },
        map_source_kind: context.sourceKind,
        map_source_id: sourceId,
        map_node_kind: kind || undefined,
        map_confidence: sourceConfidence,
        map_freshness: freshness,
        path,
        hash: canonicalNodeHash({
          label,
          nodeType,
          title,
          path,
          sourceId,
          sourceKind: context.sourceKind,
          symbolKind,
        }),
      },
    },
  };
}

function normalizeEdge(
  raw: Record<string, unknown>,
  context: {
    artifactPath: string;
    sourceKind: ComplementaryMapSourceKind;
    now: number;
    artifactFreshness: number | undefined;
    command: string | undefined;
  },
): NormalizedEdge | null {
  const sourceFrom = stringValue(raw.from) ?? stringValue(raw.source);
  const sourceTo = stringValue(raw.to) ?? stringValue(raw.target);
  if (!sourceFrom || !sourceTo) return null;
  const originalKind = upperKind(raw.kind ?? raw.type ?? raw.label);
  const mapped = EDGE_KIND_MAP[originalKind] ?? { label: "REFERENCES" as const, baseWeight: 0.45 };
  const sourceConfidence = normalizeConfidenceScore(raw.confidence);
  const sourceSalience = normalizeConfidenceScore(raw.salience);
  const weight = normalizeWeight(raw.weight, sourceSalience, sourceConfidence, mapped.baseWeight);
  const freshness = normalizeFreshness(raw.freshness ?? raw.updated_at ?? raw.generated_at, context.artifactFreshness);
  const rawProps = isRecord(raw.properties) ? raw.properties : {};
  return {
    fromSourceId: mapped.reverse ? sourceTo : sourceFrom,
    toSourceId: mapped.reverse ? sourceFrom : sourceTo,
    edge: {
      label: mapped.label,
      weight,
      properties: {
        ...rawProps,
        confidence: "EXTRACTED",
        source: context.artifactPath,
        weight,
        original_edge_kind: originalKind || undefined,
        map_source_kind: context.sourceKind,
        map_confidence: sourceConfidence,
        map_salience: sourceSalience,
        map_weight_normalized: weight,
        map_freshness: freshness,
        provenance: {
          source_kind: "external-map",
          writer: "import-complementary-map",
          command: context.command,
          confidence: "EXTRACTED",
          evidence: [`${context.artifactPath}#edge:${sourceFrom}->${sourceTo}:${originalKind}`],
          created_at: context.now,
          updated_at: context.now,
          map_source_kind: context.sourceKind,
          freshness,
        },
      },
    },
  };
}

function canonicalNodeLabel(input: {
  sourceId: string;
  kind: string;
  nodeType: NodeType;
  title: string;
  path?: string;
}): string {
  if (input.nodeType === "file") {
    return `file:${input.path ?? input.title}`;
  }
  if (input.nodeType === "symbol") {
    if (input.path) return `sym:${input.path}#${input.title}`;
    if (input.sourceId.startsWith("sym:")) return input.sourceId;
    return `sym:${input.title}`;
  }
  if (input.nodeType === "import") {
    if (input.path) return `import:${input.path}#${input.title}`;
    return input.sourceId.startsWith("import:") ? input.sourceId : `import:${input.title}`;
  }
  if (input.sourceId.startsWith("concept:")) return input.sourceId;
  return input.kind === "community" ? `concept:${input.title}` : `map:${input.sourceId}`;
}

function canonicalNodeHash(input: {
  label: string;
  nodeType: NodeType;
  title: string;
  path?: string;
  sourceId: string;
  sourceKind: ComplementaryMapSourceKind;
  symbolKind?: string;
}): string {
  if (input.nodeType === "symbol" && input.path && input.symbolKind) {
    return contentHash(input.path, input.title, input.symbolKind);
  }
  return contentHash("complementary-map", input.sourceKind, input.nodeType, input.label, input.sourceId);
}

function symbolKindForHash(kind: string): string {
  if (kind === "method") return "function";
  return kind === "symbol" ? "function" : kind;
}

function normalizeWeight(
  rawWeight: unknown,
  salience: number | undefined,
  confidence: number | undefined,
  baseWeight: number,
): number {
  const explicit = normalizeConfidenceScore(rawWeight);
  const weighted =
    explicit ??
    (salience != null && confidence != null
      ? salience * 0.6 + confidence * 0.4
      : salience ?? confidence ?? baseWeight);
  return round3(Math.min(1, Math.max(0.1, weighted)));
}

function normalizeConfidenceScore(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1 ? round3(Math.min(1, value / 100)) : round3(Math.max(0, Math.min(1, value)));
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (trimmed === "high") return 0.85;
  if (trimmed === "medium") return 0.6;
  if (trimmed === "low") return 0.35;
  const parsed = Number(trimmed.replace(/%$/, ""));
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 1 ? round3(Math.min(1, parsed / 100)) : round3(Math.max(0, Math.min(1, parsed)));
}

function normalizeFreshness(raw: unknown, artifactFreshness: number | undefined): Record<string, unknown> {
  const sourceUpdatedAt = millisValue(raw) ?? artifactFreshness;
  return {
    ...(sourceUpdatedAt != null ? { source_updated_at: sourceUpdatedAt } : {}),
  };
}

async function artifactFreshnessMs(path: string, generatedAt: unknown): Promise<number | undefined> {
  const generated = millisValue(generatedAt);
  if (generated != null) return generated;
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

function pathFromSourceId(id: string): string | undefined {
  if (id.startsWith("file:")) return id.slice("file:".length);
  const match = /^symbol:([^#]+)#(.+)$/.exec(id) ?? /^sym:([^#]+)#(.+)$/.exec(id);
  return match?.[1];
}

function normalizeSourceKind(value: string | undefined): ComplementaryMapSourceKind {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "graphify") return "graphify";
  if (normalized === "scip") return "scip";
  if (normalized === "lsp") return "lsp";
  return "static-analysis";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function lowerKind(value: unknown): string {
  return stringValue(value)?.toLowerCase().replace(/[\s-]+/g, "_") ?? "";
}

function upperKind(value: unknown): string {
  return stringValue(value)?.toUpperCase().replace(/[\s-]+/g, "_") ?? "";
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function millisValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (isRecord(value)) {
    return millisValue(value.updated_at ?? value.generated_at ?? value.source_updated_at);
  }
  return undefined;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
