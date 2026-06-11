import type { EdgeLabel, MemoryEdge, MemoryNode } from "./schema.js";

export interface StructuralImpactTarget {
  file?: string;
  symbol?: string;
}

export type StructuralImpactNode = MemoryNode & { rid: number };

export type StructuralImpactEdge = MemoryEdge & {
  from: StructuralImpactNode;
  to: StructuralImpactNode;
};

export interface StructuralImpact {
  imports: StructuralImpactEdge[];
  importedBy: StructuralImpactEdge[];
  calls: StructuralImpactEdge[];
  calledBy: StructuralImpactEdge[];
  usesTypes: StructuralImpactEdge[];
  usedByTypes: StructuralImpactEdge[];
  references: StructuralImpactEdge[];
  referencedBy: StructuralImpactEdge[];
  defines: StructuralImpactNode[];
  definedIn: StructuralImpactNode | null;
}

export interface StructuralImpactStore {
  listNodes(): Promise<StructuralImpactNode[]>;
  listEdges(): Promise<Array<MemoryEdge | Record<string, unknown>>>;
}

export type StructuralImpactReader = (target: StructuralImpactTarget) => Promise<StructuralImpact>;

const EMPTY: StructuralImpact = {
  imports: [],
  importedBy: [],
  calls: [],
  calledBy: [],
  usesTypes: [],
  usedByTypes: [],
  references: [],
  referencedBy: [],
  defines: [],
  definedIn: null,
};

export function structuralImpactReader(store: StructuralImpactStore): StructuralImpactReader {
  return (target) => readStructuralImpact(store, target);
}

/**
 * Read structural impact from the versioned memory graph. This is deliberately
 * snapshot-only: callers decide how to interpret and verify the evidence before
 * presenting it in `/zoom-out`.
 */
export async function readStructuralImpact(
  store: StructuralImpactStore,
  target: StructuralImpactTarget,
): Promise<StructuralImpact> {
  const nodes = await store.listNodes();
  const nodeByRid = new Map(nodes.map((n) => [n.rid, n]));
  const edges = (await store.listEdges())
    .map(normalizeEdge)
    .filter((e): e is MemoryEdge => e != null);

  const fileNode = target.file ? findFile(nodes, target.file) : null;
  const symbolNode = target.symbol
    ? findSymbol(nodes, edges, nodeByRid, target.symbol, fileNode)
    : null;
  const definedIn = symbolNode ? definedInFile(symbolNode, edges, nodeByRid) : null;
  const anchorFile = fileNode ?? definedIn;
  if (anchorFile == null && symbolNode == null) return { ...EMPTY };

  const defines = anchorFile
    ? edges
        .filter((e) => e.label === "DEFINED_IN" && e.to_rid === anchorFile.rid)
        .map((e) => nodeByRid.get(e.from_rid))
        .filter((n): n is StructuralImpactNode => n?.node_type === "symbol")
    : [];

  const imports = anchorFile
    ? materializeEdges(
        edges.filter((e) => e.label === "IMPORTS" && e.from_rid === anchorFile.rid),
        nodeByRid,
      )
    : [];

  const importedBy = anchorFile
    ? materializeEdges(
        edges.filter((e) => {
          if (e.label !== "IMPORTS") return false;
          const imported = nodeByRid.get(e.to_rid);
          return imported?.node_type === "import" && importTargetsFile(imported, anchorFile);
        }),
        nodeByRid,
      )
    : [];

  const callAnchors = new Set(
    symbolNode ? [symbolNode.rid] : defines.map((node) => node.rid),
  );
  const calls =
    callAnchors.size > 0
      ? materializeEdges(
          edges.filter((e) => e.label === "CALLS" && callAnchors.has(e.from_rid)),
          nodeByRid,
        )
      : [];
  const calledBy =
    callAnchors.size > 0
      ? materializeEdges(
          edges.filter((e) => e.label === "CALLS" && callAnchors.has(e.to_rid)),
          nodeByRid,
        )
      : [];
  const usesTypes =
    callAnchors.size > 0
      ? materializeEdges(
          edges.filter((e) => e.label === "USES_TYPE" && callAnchors.has(e.from_rid)),
          nodeByRid,
        )
      : [];
  const usedByTypes =
    callAnchors.size > 0
      ? materializeEdges(
          edges.filter((e) => e.label === "USES_TYPE" && callAnchors.has(e.to_rid)),
          nodeByRid,
        )
      : [];
  const referenceAnchors = callAnchors;
  const references =
    referenceAnchors.size > 0
      ? materializeEdges(
          edges.filter((e) => e.label === "REFERENCES" && referenceAnchors.has(e.from_rid)),
          nodeByRid,
        )
      : [];
  const referencedBy =
    referenceAnchors.size > 0
      ? materializeEdges(
          edges.filter((e) => e.label === "REFERENCES" && referenceAnchors.has(e.to_rid)),
          nodeByRid,
        )
      : [];

  return {
    imports,
    importedBy,
    calls,
    calledBy,
    usesTypes,
    usedByTypes,
    references,
    referencedBy,
    defines,
    definedIn,
  };
}

function findFile(nodes: StructuralImpactNode[], targetFile: string): StructuralImpactNode | null {
  return (
    nodes.find(
      (n) => n.node_type === "file" && pathCandidates(n).some((path) => pathMatches(path, targetFile)),
    ) ?? null
  );
}

function findSymbol(
  nodes: StructuralImpactNode[],
  edges: MemoryEdge[],
  nodeByRid: Map<number, StructuralImpactNode>,
  symbol: string,
  fileNode: StructuralImpactNode | null,
): StructuralImpactNode | null {
  const symbols = nodes.filter((n) => n.node_type === "symbol" && symbolMatches(n, symbol));
  if (fileNode == null) return symbols[0] ?? null;
  return (
    symbols.find((n) =>
      edges.some((e) => e.label === "DEFINED_IN" && e.from_rid === n.rid && e.to_rid === fileNode.rid),
    ) ??
    symbols.find((n) => definedInFile(n, edges, nodeByRid)?.rid === fileNode.rid) ??
    null
  );
}

function definedInFile(
  symbol: StructuralImpactNode,
  edges: MemoryEdge[],
  nodeByRid: Map<number, StructuralImpactNode>,
): StructuralImpactNode | null {
  const edge = edges.find((e) => e.label === "DEFINED_IN" && e.from_rid === symbol.rid);
  const node = edge ? nodeByRid.get(edge.to_rid) : undefined;
  return node?.node_type === "file" ? node : null;
}

function materializeEdges(
  edges: MemoryEdge[],
  nodeByRid: Map<number, StructuralImpactNode>,
): StructuralImpactEdge[] {
  return edges.flatMap((e) => {
    const from = nodeByRid.get(e.from_rid);
    const to = nodeByRid.get(e.to_rid);
    return from && to ? [{ ...e, from, to }] : [];
  });
}

function importTargetsFile(importNode: StructuralImpactNode, fileNode: StructuralImpactNode): boolean {
  const resolved = importNode.properties.resolved_path;
  if (typeof resolved === "string" && pathCandidates(fileNode).some((path) => pathMatches(resolved, path))) {
    return true;
  }
  const title = importNode.properties.title;
  return typeof title === "string" && pathCandidates(fileNode).some((path) => pathMatches(title, path));
}

function normalizeEdge(row: MemoryEdge | Record<string, unknown>): MemoryEdge | null {
  const r = row as Record<string, unknown>;
  const label = r.label ?? r.LABEL;
  const from = r.from ?? r.from_id ?? r.from_rid ?? r.source ?? r.FROM;
  const to = r.to ?? r.to_id ?? r.to_rid ?? r.target ?? r.TO;
  const fromRid = Number(from);
  const toRid = Number(to);
  if (typeof label !== "string" || !Number.isFinite(fromRid) || !Number.isFinite(toRid)) {
    return null;
  }
  return {
    rid: numberOrUndefined(r.rid ?? r.red_entity_id),
    label: label as EdgeLabel,
    from_rid: fromRid,
    to_rid: toRid,
    weight: numberOrUndefined(r.weight ?? r.WEIGHT),
    properties: (r.properties ?? r.PROPERTIES) as MemoryEdge["properties"],
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function pathCandidates(node: StructuralImpactNode): string[] {
  return [stripPrefix(node.label, "file:"), node.properties.title, node.properties.source]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map(normalizePath);
}

function symbolMatches(node: StructuralImpactNode, symbol: string): boolean {
  const target = symbol.trim();
  return (
    node.properties.title === target ||
    node.label.endsWith(`#${target}`) ||
    node.label === target
  );
}

function pathMatches(candidate: string, target: string): boolean {
  const left = normalizePath(candidate);
  const right = normalizePath(target);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function normalizePath(path: string): string {
  return stripPrefix(path, "file:").replace(/\\/g, "/").replace(/\/+$/, "");
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
