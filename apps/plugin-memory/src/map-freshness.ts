import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { EXTRACTION_SCHEMA_VERSION } from "./extraction-schema.js";
import { toEdge } from "./export.js";
import {
  buildGraphContract,
  GRAPH_CONTRACT_VERSION,
  type EdgeKind,
} from "./graph-contract.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";
import { readFileManifestEntry, readIndexHash } from "./ingest.js";
import type { Confidence, MemoryDoc } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface MemoryMapFreshnessReport {
  schema_version: "memory.map_freshness.v1";
  read_only: true;
  root: string;
  generated_at: string;
  status: "use-map" | "refresh-map" | "fallback-to-source";
  freshness_identity: {
    source_revision: string | null;
    source_revision_short: string | null;
    working_tree_dirty: boolean | null;
    graph_contract_version: string;
    extraction_schema_version: string;
    extractor_versions: Record<string, string>;
  };
  source_inputs: {
    total: number;
    fresh: number;
    changed: number;
    stale: number;
    unknown: number;
    changed_files: string[];
    stale_files: string[];
    unknown_files: string[];
  };
  extraction_coverage: {
    nodes: number;
    edges: number;
    docs: number;
    by_language: Record<string, number>;
    by_source_kind: Record<string, number>;
    extractor_writers: Record<string, number>;
  };
  relationships: {
    by_contract_kind: Record<EdgeKind, number>;
    by_label: Record<string, number>;
    missing_contract_kinds: EdgeKind[];
    low_confidence_edges: Record<string, number>;
    low_confidence_nodes: Record<Confidence, number>;
  };
  recommended_next_actions: string[];
  markdown: string;
}

interface SourceInput {
  absPath: string;
  displayPath: string;
}

export async function buildMemoryMapFreshnessReport(
  store: MemoryStore,
  rootDir: string,
  opts: { now?: number } = {},
): Promise<MemoryMapFreshnessReport> {
  const root = resolve(rootDir);
  const [nodes, rawEdges, docs, revision] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    store.listDocs(),
    gitRevision(root),
  ]);
  const edges = rawEdges.map(toEdge);
  const contract = buildGraphContract({ nodes, edges });
  const sources = collectSourceInputs(root, nodes, docs);
  const sourceInputs = await summarizeSourceInputs(store, sources);
  const extractionCoverage = summarizeExtractionCoverage(nodes, edges, docs);
  const relationships = summarizeRelationships(nodes, edges, contract.stats.edge_kinds);
  const status = decideStatus(nodes.length, sourceInputs);
  const recommended = recommendedActions(status, sourceInputs, relationships);
  const reportWithoutMarkdown = {
    schema_version: "memory.map_freshness.v1" as const,
    read_only: true as const,
    root,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    status,
    freshness_identity: {
      source_revision: revision.revision,
      source_revision_short: revision.revision?.slice(0, 12) ?? null,
      working_tree_dirty: revision.dirty,
      graph_contract_version: GRAPH_CONTRACT_VERSION,
      extraction_schema_version: EXTRACTION_SCHEMA_VERSION,
      extractor_versions: deterministicExtractorVersions(),
    },
    source_inputs: sourceInputs,
    extraction_coverage: extractionCoverage,
    relationships,
    recommended_next_actions: recommended,
  };

  return {
    ...reportWithoutMarkdown,
    markdown: renderMemoryMapFreshnessMarkdown(reportWithoutMarkdown),
  };
}

function collectSourceInputs(
  root: string,
  nodes: StoredNode[],
  docs: Array<MemoryDoc & { rid: number }>,
): SourceInput[] {
  const inputs = new Map<string, SourceInput>();
  const add = (candidate: unknown) => {
    const normalized = normalizeSourcePath(root, candidate);
    if (!normalized) return;
    inputs.set(normalized.absPath, normalized);
  };

  for (const doc of docs) add(doc.path);
  for (const node of nodes) {
    if (node.node_type === "file" && node.label.startsWith("file:")) add(node.label.slice(5));
    add(node.properties.source);
    const provenance = node.properties.provenance;
    if (provenance && typeof provenance === "object" && Array.isArray(provenance.evidence)) {
      for (const item of provenance.evidence) add(item);
    }
  }

  return [...inputs.values()].sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

function normalizeSourcePath(root: string, value: unknown): SourceInput | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text || text === "manual" || text.startsWith("memory_")) return null;
  text = text.replace(/#.*$/, "");
  text = text.replace(/:\d+(?::\d+)?$/, "");
  if (!looksLikePath(text)) return null;
  const absPath = isAbsolute(text) ? resolve(text) : resolve(root, text);
  const rel = relative(root, absPath);
  const displayPath = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absPath;
  return { absPath, displayPath };
}

function looksLikePath(value: string): boolean {
  return (
    value.includes("/") ||
    value.includes("\\") ||
    value.startsWith(".") ||
    extname(value).length > 0
  );
}

async function summarizeSourceInputs(
  store: MemoryStore,
  sources: SourceInput[],
): Promise<MemoryMapFreshnessReport["source_inputs"]> {
  const summary: MemoryMapFreshnessReport["source_inputs"] = {
    total: sources.length,
    fresh: 0,
    changed: 0,
    stale: 0,
    unknown: 0,
    changed_files: [],
    stale_files: [],
    unknown_files: [],
  };

  for (const source of sources) {
    const manifest = await readFileManifestEntry(store, source.absPath);
    const exists = await fileExists(source.absPath);
    if (!exists) {
      summary.stale += 1;
      summary.stale_files.push(source.displayPath);
      continue;
    }
    if (!manifest) {
      summary.unknown += 1;
      summary.unknown_files.push(source.displayPath);
      continue;
    }
    const currentHash = await readIndexHash(source.absPath);
    if (manifest.hash === currentHash) {
      summary.fresh += 1;
    } else {
      summary.changed += 1;
      summary.changed_files.push(source.displayPath);
    }
  }

  summary.changed_files = summary.changed_files.slice(0, 20);
  summary.stale_files = summary.stale_files.slice(0, 20);
  summary.unknown_files = summary.unknown_files.slice(0, 20);
  return summary;
}

function summarizeExtractionCoverage(
  nodes: StoredNode[],
  edges: Array<{ properties: Record<string, unknown> }>,
  docs: Array<MemoryDoc & { rid: number }>,
): MemoryMapFreshnessReport["extraction_coverage"] {
  const byLanguage: Record<string, number> = {};
  const bySourceKind: Record<string, number> = {};
  const extractorWriters: Record<string, number> = {};

  for (const doc of docs) increment(byLanguage, languageForPath(doc.path));
  for (const node of nodes) {
    const language =
      typeof node.properties.language === "string"
        ? node.properties.language
        : languageForPath(String(node.properties.source ?? node.label));
    increment(byLanguage, language || "unknown");
    const provenance = node.properties.provenance;
    if (provenance && typeof provenance === "object") {
      increment(bySourceKind, String(provenance.source_kind ?? "unknown"));
      increment(extractorWriters, String(provenance.writer ?? "unknown"));
    } else {
      increment(bySourceKind, String(node.properties.source ?? "unknown"));
      increment(extractorWriters, "unknown");
    }
  }
  for (const edge of edges) {
    const provenance = edge.properties?.provenance;
    if (provenance && typeof provenance === "object") {
      increment(
        bySourceKind,
        String((provenance as Record<string, unknown>).source_kind ?? "unknown"),
      );
    }
  }

  return {
    nodes: nodes.length,
    edges: edges.length,
    docs: docs.length,
    by_language: sortCounts(byLanguage),
    by_source_kind: sortCounts(bySourceKind),
    extractor_writers: sortCounts(extractorWriters),
  };
}

function summarizeRelationships(
  nodes: StoredNode[],
  edges: Array<{ label: string; properties: Record<string, unknown> }>,
  byContractKind: Record<EdgeKind, number>,
): MemoryMapFreshnessReport["relationships"] {
  const byLabel: Record<string, number> = {};
  const lowConfidenceEdges: Record<string, number> = {};
  const lowConfidenceNodes: Record<Confidence, number> = {
    EXTRACTED: 0,
    INFERRED: 0,
    AMBIGUOUS: 0,
  };

  for (const edge of edges) {
    increment(byLabel, edge.label);
    const confidence = edge.properties?.confidence;
    if (confidence === "AMBIGUOUS" || confidence === "INFERRED") {
      increment(lowConfidenceEdges, edge.label);
    }
  }
  for (const node of nodes) {
    const confidence = node.properties.confidence;
    if (confidence === "EXTRACTED" || confidence === "INFERRED" || confidence === "AMBIGUOUS") {
      lowConfidenceNodes[confidence] += 1;
    }
  }

  return {
    by_contract_kind: byContractKind,
    by_label: sortCounts(byLabel),
    missing_contract_kinds: (["imports", "defines", "references"] as EdgeKind[]).filter(
      (kind) => byContractKind[kind] === 0,
    ),
    low_confidence_edges: sortCounts(lowConfidenceEdges),
    low_confidence_nodes: lowConfidenceNodes,
  };
}

function decideStatus(
  nodes: number,
  sourceInputs: MemoryMapFreshnessReport["source_inputs"],
): MemoryMapFreshnessReport["status"] {
  if (nodes === 0 || sourceInputs.total === 0) return "fallback-to-source";
  if (sourceInputs.changed > 0 || sourceInputs.stale > 0) return "refresh-map";
  return "use-map";
}

function recommendedActions(
  status: MemoryMapFreshnessReport["status"],
  sources: MemoryMapFreshnessReport["source_inputs"],
  relationships: MemoryMapFreshnessReport["relationships"],
): string[] {
  const actions: string[] = [];
  if (status === "fallback-to-source") {
    actions.push("fall back to direct source inspection; the map has no source-backed graph evidence");
    actions.push("run `memory ingest . --root <repo>` or refresh edited files after initializing graph mode");
  }
  if (sources.changed > 0 || sources.stale > 0) {
    const files = [...sources.changed_files, ...sources.stale_files].slice(0, 5).join(" ");
    actions.push(
      files
        ? `run \`memory refresh --root <repo> ${files}\` before trusting affected map edges`
        : "run `memory refresh --changed --root <repo>` before trusting affected map edges",
    );
    actions.push("inspect changed or missing source files directly until refresh completes");
  }
  if (sources.unknown > 0) {
    actions.push("treat files without manifest evidence as unverified and prefer direct source checks for them");
  }
  if (relationships.missing_contract_kinds.length > 0) {
    actions.push(
      `relationship coverage missing: ${relationships.missing_contract_kinds.join(", ")}; avoid relying on those edge classes`,
    );
  }
  if (
    Object.keys(relationships.low_confidence_edges).length > 0 ||
    relationships.low_confidence_nodes.AMBIGUOUS > 0
  ) {
    actions.push("review AMBIGUOUS/INFERRED evidence before using map relationships for edits");
  }
  if (actions.length === 0) {
    actions.push("use the Memory map for orientation, then verify critical edit targets in source");
  }
  return [...new Set(actions)].slice(0, 6);
}

function renderMemoryMapFreshnessMarkdown(
  report: Omit<MemoryMapFreshnessReport, "markdown">,
): string {
  const lines = [
    "# Memory map freshness",
    "",
    `Status: ${report.status}`,
    `Source revision: ${report.freshness_identity.source_revision_short ?? "unavailable"}`,
    `Working tree: ${
      report.freshness_identity.working_tree_dirty == null
        ? "unknown"
        : report.freshness_identity.working_tree_dirty
          ? "dirty"
          : "clean"
    }`,
    `Extractor identity: graph-contract ${report.freshness_identity.graph_contract_version}, extraction-schema ${report.freshness_identity.extraction_schema_version}`,
    `Extractor versions: ${formatCountsAsStrings(report.freshness_identity.extractor_versions)}`,
    "",
    "## Source inputs",
    `- total=${report.source_inputs.total} fresh=${report.source_inputs.fresh} changed=${report.source_inputs.changed} stale=${report.source_inputs.stale} unknown=${report.source_inputs.unknown}`,
    ...prefixedList("changed", report.source_inputs.changed_files),
    ...prefixedList("stale", report.source_inputs.stale_files),
    ...prefixedList("unknown", report.source_inputs.unknown_files),
    "",
    "## Extraction coverage",
    `- nodes=${report.extraction_coverage.nodes} edges=${report.extraction_coverage.edges} docs=${report.extraction_coverage.docs}`,
    `- languages: ${formatCounts(report.extraction_coverage.by_language)}`,
    `- source kinds: ${formatCounts(report.extraction_coverage.by_source_kind)}`,
    `- extractor writers: ${formatCounts(report.extraction_coverage.extractor_writers)}`,
    "",
    "## Relationships",
    `- contract kinds: ${formatCounts(report.relationships.by_contract_kind)}`,
    `- missing: ${report.relationships.missing_contract_kinds.join(", ") || "none"}`,
    `- low-confidence edges: ${formatCounts(report.relationships.low_confidence_edges)}`,
    `- low-confidence nodes: INFERRED=${report.relationships.low_confidence_nodes.INFERRED} AMBIGUOUS=${report.relationships.low_confidence_nodes.AMBIGUOUS}`,
    "",
    "## Next actions",
    ...report.recommended_next_actions.map((action) => `- ${action}`),
    "",
  ];
  return lines.join("\n");
}

function prefixedList(prefix: string, values: string[]): string[] {
  return values.length === 0 ? [] : values.map((value) => `- ${prefix}: ${value}`);
}

function languageForPath(path: string): string {
  switch (extname(path.replace(/:\d+(?::\d+)?$/, "")).toLowerCase()) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".sql":
      return "sql";
    case ".md":
      return "markdown";
    default:
      return "unknown";
  }
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortCounts<T extends string>(record: Record<T, number>): Record<T, number> {
  return Object.fromEntries(
    Object.entries(record).sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0])),
  ) as Record<T, number>;
}

function formatCounts(record: Record<string, number>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function formatCountsAsStrings(record: Record<string, string>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "none";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

function deterministicExtractorVersions(): Record<string, string> {
  return {
    "extract-code": EXTRACTION_SCHEMA_VERSION,
    "extract-markdown": EXTRACTION_SCHEMA_VERSION,
    "extract-sql": EXTRACTION_SCHEMA_VERSION,
    "extract-dev-artifact": EXTRACTION_SCHEMA_VERSION,
    "extract-asset": EXTRACTION_SCHEMA_VERSION,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function gitRevision(
  root: string,
): Promise<{ revision: string | null; dirty: boolean | null }> {
  try {
    const [{ stdout: revisionOut }, { stdout: statusOut }] = await Promise.all([
      execFileAsync("git", ["-C", root, "rev-parse", "HEAD"]),
      execFileAsync("git", ["-C", root, "status", "--porcelain"]),
    ]);
    const revision = revisionOut.trim() || null;
    return { revision, dirty: statusOut.trim().length > 0 };
  } catch {
    return { revision: null, dirty: null };
  }
}
