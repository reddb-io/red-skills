import type { EdgeKind, GraphContract } from "./graph-contract.js";

/**
 * memory architecture-overview — one architecture-overview file, generated from
 * the graph contract (#234), for fast onboarding.
 *
 * This is the *orientation* read: a single page that summarises the graph's
 * layers and communities and how strongly they connect, so a newcomer can get
 * the shape of the system before exploring interactively. It complements — and
 * deliberately does not duplicate — the richer wiki: there are no per-entity or
 * C4 pages here, only aggregate structure.
 *
 * The only input is a {@link GraphContract} (the stable seam emitted at
 * `graph.json#contract`). It never reads the store or a bespoke shape, so the
 * overview stays consistent with anything else built from the same contract.
 */

export const ARCHITECTURE_OVERVIEW_SCHEMA_VERSION = "memory.architecture_overview.v1";

/** Bucket label for nodes whose contract `layer` is null. */
export const UNASSIGNED_LAYER = "unassigned";

export interface GroupSummary {
  /** Node count in the group. */
  nodes: number;
  /** Edges where both endpoints are in this group. */
  internalConnections: number;
  /** Edges with exactly one endpoint in this group (connections to other groups). */
  externalConnections: number;
  /** Node-type breakdown within the group, descending by count. */
  nodeTypes: Record<string, number>;
}

export interface LayerSummary extends GroupSummary {
  /** Physical layer (L1/L2/L3) or {@link UNASSIGNED_LAYER}. */
  layer: string;
}

export interface CommunitySummary extends GroupSummary {
  /** Community/cluster id from community detection. */
  community: string;
}

export interface ArchitectureOverview {
  schema_version: typeof ARCHITECTURE_OVERVIEW_SCHEMA_VERSION;
  read_only: true;
  generated_from: { contract_version: string };
  totals: {
    nodes: number;
    edges: number;
    communities: number;
    orphans: number;
    cross_layer_edges: number;
    edge_kinds: Record<EdgeKind, number>;
  };
  layers: LayerSummary[];
  communities: CommunitySummary[];
  markdown: string;
}

interface GroupAccumulator {
  nodes: number;
  internalConnections: number;
  externalConnections: number;
  nodeTypes: Map<string, number>;
}

function emptyGroup(): GroupAccumulator {
  return { nodes: 0, internalConnections: 0, externalConnections: 0, nodeTypes: new Map() };
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function sortedRecord(map: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    out[key] = value;
  }
  return out;
}

/**
 * Tally a group keyed by some node attribute (layer or community). `keyOf`
 * returns the group key for a node id, or null to drop the node from this axis
 * (e.g. nodes without a community are not counted in the community breakdown).
 */
function tallyGroups(
  contract: GraphContract,
  keyOf: (nodeId: number) => string | null,
): Map<string, GroupAccumulator> {
  const groups = new Map<string, GroupAccumulator>();
  const nodeKey = new Map<number, string | null>();

  for (const node of contract.nodes) {
    const key = keyOf(node.id);
    nodeKey.set(node.id, key);
    if (key == null) continue;
    const group = groups.get(key) ?? emptyGroup();
    group.nodes += 1;
    bump(group.nodeTypes, node.type);
    groups.set(key, group);
  }

  for (const edge of contract.edges) {
    const from = nodeKey.get(edge.source) ?? null;
    const to = nodeKey.get(edge.target) ?? null;
    if (from != null && from === to) {
      groups.get(from)!.internalConnections += 1;
      continue;
    }
    if (from != null) groups.get(from)!.externalConnections += 1;
    if (to != null) groups.get(to)!.externalConnections += 1;
  }

  return groups;
}

function crossLayerEdges(contract: GraphContract, layerOf: Map<number, string>): number {
  let count = 0;
  for (const edge of contract.edges) {
    if (layerOf.get(edge.source) !== layerOf.get(edge.target)) count += 1;
  }
  return count;
}

export function buildArchitectureOverview(contract: GraphContract): ArchitectureOverview {
  const layerOf = new Map<number, string>(
    contract.nodes.map((node) => [node.id, node.layer ?? UNASSIGNED_LAYER]),
  );
  const communityOf = new Map<number, string | null>(
    contract.nodes.map((node) => [node.id, node.community]),
  );

  const layerGroups = tallyGroups(contract, (id) => layerOf.get(id) ?? UNASSIGNED_LAYER);
  const communityGroups = tallyGroups(contract, (id) => communityOf.get(id) ?? null);

  // Layers: ascending by name, but the synthetic "unassigned" bucket always last.
  const layers: LayerSummary[] = [...layerGroups.entries()]
    .map(([layer, group]) => ({ layer, ...finalizeGroup(group) }))
    .sort((a, b) => {
      if (a.layer === UNASSIGNED_LAYER) return 1;
      if (b.layer === UNASSIGNED_LAYER) return -1;
      return a.layer.localeCompare(b.layer);
    });

  // Communities: largest first, ties broken by id for stable output.
  const communities: CommunitySummary[] = [...communityGroups.entries()]
    .map(([community, group]) => ({ community, ...finalizeGroup(group) }))
    .sort((a, b) => b.nodes - a.nodes || a.community.localeCompare(b.community));

  const totals = {
    nodes: contract.stats.node_count,
    edges: contract.stats.edge_count,
    communities: contract.stats.community_count,
    orphans: contract.stats.orphan_count,
    cross_layer_edges: crossLayerEdges(contract, layerOf),
    edge_kinds: contract.stats.edge_kinds,
  };

  const overview: Omit<ArchitectureOverview, "markdown"> = {
    schema_version: ARCHITECTURE_OVERVIEW_SCHEMA_VERSION,
    read_only: true,
    generated_from: { contract_version: contract.version },
    totals,
    layers,
    communities,
  };

  return { ...overview, markdown: renderMarkdown(overview) };
}

function finalizeGroup(group: GroupAccumulator): GroupSummary {
  return {
    nodes: group.nodes,
    internalConnections: group.internalConnections,
    externalConnections: group.externalConnections,
    nodeTypes: sortedRecord(group.nodeTypes),
  };
}

function topTypes(nodeTypes: Record<string, number>, limit = 3): string {
  const entries = Object.entries(nodeTypes);
  if (entries.length === 0) return "—";
  return entries
    .slice(0, limit)
    .map(([type, count]) => `${type} ${count}`)
    .join(", ");
}

function renderMarkdown(overview: Omit<ArchitectureOverview, "markdown">): string {
  const { totals, layers, communities, generated_from } = overview;
  const lines: string[] = [
    "# Architecture overview",
    "",
    `_Generated from the memory graph contract (v${generated_from.contract_version})._`,
    "",
    "A single-read orientation map of the codebase's layers and communities and how" +
      " strongly they connect. It complements — it does not replace — the wiki's richer" +
      " C4 and per-entity pages; read this first to get the shape, then explore the wiki.",
    "",
    "## Totals",
    "",
    `- Nodes: ${totals.nodes}`,
    `- Edges: ${totals.edges}`,
    `- Communities: ${totals.communities}`,
    `- Orphans (no inbound edges): ${totals.orphans}`,
    `- Cross-layer edges: ${totals.cross_layer_edges}`,
    `- Edge kinds: imports ${totals.edge_kinds.imports}, defines ${totals.edge_kinds.defines}, references ${totals.edge_kinds.references}`,
    "",
    "## Layers",
    "",
  ];

  if (layers.length === 0) {
    lines.push("_No nodes._", "");
  } else {
    lines.push(
      "| Layer | Nodes | Internal connections | External connections | Top types |",
      "| --- | ---: | ---: | ---: | --- |",
    );
    for (const layer of layers) {
      lines.push(
        `| ${layer.layer} | ${layer.nodes} | ${layer.internalConnections} | ${layer.externalConnections} | ${topTypes(layer.nodeTypes)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Communities", "");
  if (communities.length === 0) {
    lines.push("_No communities detected — re-run export with `--communities` to populate them._", "");
  } else {
    lines.push(
      "| Community | Nodes | Internal connections | External connections | Top types |",
      "| --- | ---: | ---: | ---: | --- |",
    );
    for (const community of communities) {
      lines.push(
        `| ${community.community} | ${community.nodes} | ${community.internalConnections} | ${community.externalConnections} | ${topTypes(community.nodeTypes)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
