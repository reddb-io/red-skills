import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import fg from "fast-glob";
import { extractAsset, isAssetFile } from "./extract-asset.js";
import { extractCode } from "./extract-code.js";
import {
  buildExtractionPrompt,
  factsToGraph,
  parseExtraction,
  type ProviderClient,
  type ProviderRequest,
} from "./extract-conversation.js";
import { extractDevArtifact, isDevArtifact } from "./extract-dev-artifact.js";
import { extractMarkdown } from "./extract-markdown.js";
import { extractSql } from "./extract-sql.js";
import { contentHash } from "./hash.js";
import { readMemoryIgnore } from "./scope.js";
import { countCl100kTokens } from "./token-count.js";
import { renderToonOutput } from "./toon-output.js";
import type { MemoryStore } from "./graph-store.js";
import type { EdgeLabel, MemoryDoc, MemoryEdgeProps, MemoryNode } from "./schema.js";

type IngestToonRow = {
  files: number;
  nodes: number;
  edges: number;
  docs: number;
  semantic_nodes: number;
  semantic_edges: number;
  semantic_token_input?: number;
  semantic_token_output?: number;
  duration_ms: number;
};

export interface IngestOptions {
  /** Root directory to walk. */
  cwd: string;
  patterns?: string[];
  ignore?: string[];
  /** Hard cap on files indexed in one pass. Protects against huge monorepos. */
  maxFiles?: number;
  semantic?: SemanticIngestOptions;
}

export interface IngestReport {
  files: number;
  nodes: number;
  edges: number;
  docs: number;
  added: number;
  updated: number;
  skipped: number;
  stale: number;
  semantic: SemanticIngestReport;
  durationMs: number;
}

export interface SemanticIngestOptions {
  enabled: boolean;
  client?: ProviderClient;
  source?: string;
}

export interface SemanticTokenCost {
  input: number;
  output: number;
}

export interface SemanticIngestReport {
  enabled: boolean;
  nodes: number;
  edges: number;
  token_cost: SemanticTokenCost;
}

const DEFAULT_PATTERNS = [
  "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,sql,sh,bash}",
  "**/*.md",
  "**/package.json",
  "**/Dockerfile",
  "**/*.dockerfile",
  "**/.github/workflows/*.{yml,yaml}",
  "**/*.{pdf,png,jpg,jpeg,gif,webp,svg,mp3,wav,m4a,flac,ogg,mp4,mov,webm,mkv,doc,docx,ppt,pptx,xls,xlsx}",
];
const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/.red/**",
  "**/coverage/**",
  "**/*.min.js",
];

/**
 * Walk a project tree and populate the graph store from the deterministic
 * extractors (`extractCode`, `extractSql`, and `extractMarkdown`). Idempotent — every node, edge,
 * and doc dedupes by content hash, so re-ingesting an unchanged tree is a no-op.
 *
 * Ported from red-memory `packages/extractor/src/indexer.ts`. Conversation/git
 * (INFERRED) ingestion is out of this slice (#53).
 */
export async function ingestProject(
  store: MemoryStore,
  opts: IngestOptions,
): Promise<IngestReport> {
  const start = Date.now();
  // Honour the committed `.memoryignore` so subsequent runs respect the team's
  // scope choice without re-prompting (#235, AC4).
  const memoryIgnore = await readMemoryIgnore(opts.cwd);
  const files = await fg(opts.patterns ?? DEFAULT_PATTERNS, {
    cwd: opts.cwd,
    ignore: [...DEFAULT_IGNORE, ...memoryIgnore, ...(opts.ignore ?? [])],
    absolute: true,
    onlyFiles: true,
    dot: false,
  });
  const slice = opts.maxFiles ? files.slice(0, opts.maxFiles) : files;

  const totals = { nodes: 0, edges: 0, docs: 0 };
  for (const path of slice) {
    const r = await indexFile(store, path);
    totals.nodes += r.nodes;
    totals.edges += r.edges;
    totals.docs += r.docs;
  }
  const semantic = await runSemanticIngest(store, slice, opts);

  return {
    files: slice.length,
    ...totals,
    added: 0,
    updated: 0,
    skipped: 0,
    stale: 0,
    semantic,
    durationMs: Date.now() - start,
  };
}

/**
 * List the candidate files an ingest would walk, as repo-relative paths. The
 * pre-ingest scope wizard (#235) counts and scopes this list before any graph
 * write happens. Applies the same default patterns/ignores as
 * {@link ingestProject}; `opts.ignore` layers on top (e.g. a scope preset).
 * The committed `.memoryignore` is *not* applied here — callers layer it via
 * `planScope` so the report can show the count both before and after scoping.
 */
export async function collectCandidates(opts: IngestOptions): Promise<string[]> {
  return fg(opts.patterns ?? DEFAULT_PATTERNS, {
    cwd: opts.cwd,
    ignore: [...DEFAULT_IGNORE, ...(opts.ignore ?? [])],
    absolute: false,
    onlyFiles: true,
    dot: false,
  });
}

/** Per-file node/edge/doc counts from a single {@link indexFile} pass. */
export interface FileIndexReport {
  nodes: number;
  edges: number;
  docs: number;
  elements: string[];
}

interface FileExtraction {
  doc?: MemoryDoc;
  nodes: MemoryNode[];
  edges: Array<
    | {
        fromLabel: string;
        toLabel: string;
        label: EdgeLabel;
        weight?: number;
        properties?: MemoryEdgeProps;
      }
    | { fromHash: string; toLabel: string; label: EdgeLabel }
  >;
  elements: string[];
}

/**
 * Index one file into the graph store, dispatching on extension to the markdown
 * or code extractor. The shared unit behind {@link ingestProject} (full walk)
 * and {@link reindexFiles} (the PostToolUse incremental re-index). Idempotent —
 * every node/edge/doc dedupes by content hash.
 */
export async function indexFile(store: MemoryStore, path: string): Promise<FileIndexReport> {
  const extraction = await extractFile(path);
  return writeExtraction(store, extraction);
}

async function runSemanticIngest(
  store: MemoryStore,
  files: string[],
  opts: IngestOptions,
): Promise<SemanticIngestReport> {
  if (!opts.semantic?.enabled || !opts.semantic.client) return emptySemanticReport(false);
  const corpus = await buildSemanticCorpus(opts.cwd, files);
  if (!corpus.trim()) return emptySemanticReport(true);
  const req = buildExtractionPrompt(corpus);
  let raw: string;
  try {
    raw = await opts.semantic.client.complete(req);
  } catch {
    return {
      ...emptySemanticReport(true),
      token_cost: { input: countProviderRequestTokens(req), output: 0 },
    };
  }
  const extraction = factsToGraph(parseExtraction(raw), opts.semantic.source ?? "corpus-ingest");
  const report = await writeExtraction(store, {
    nodes: extraction.nodes,
    edges: extraction.edges,
    elements: graphElements(opts.semantic.source ?? "corpus-ingest", extraction.nodes, false),
  });
  return {
    enabled: true,
    nodes: report.nodes,
    edges: report.edges,
    token_cost: {
      input: countProviderRequestTokens(req),
      output: countTokens(raw),
    },
  };
}

async function buildSemanticCorpus(cwd: string, files: string[]): Promise<string> {
  const chunks: string[] = [];
  for (const file of files) {
    if (isAssetFile(file)) continue;
    try {
      const body = await readFile(file, "utf8");
      chunks.push(`File: ${relative(cwd, file)}\n\n${body}`);
    } catch {
      /* Binary or unreadable text-like file: structural indexing already handled it. */
    }
  }
  return chunks.join("\n\n---\n\n");
}

function emptySemanticReport(enabled: boolean): SemanticIngestReport {
  return { enabled, nodes: 0, edges: 0, token_cost: { input: 0, output: 0 } };
}

function countProviderRequestTokens(req: ProviderRequest): number {
  return countTokens(`${req.system}\n\n${req.user}`);
}

function countTokens(text: string): number {
  return countCl100kTokens(text);
}

export function renderIngestReportToon(
  report: IngestReport,
  opts: { includeSemanticCost: boolean },
): string {
  const semanticCostFields: readonly (keyof IngestToonRow & string)[] = opts.includeSemanticCost
    ? ["semantic_token_input", "semantic_token_output"]
    : [];
  const fields: readonly (keyof IngestToonRow & string)[] = [
    "files",
    "nodes",
    "edges",
    "docs",
    "semantic_nodes",
    "semantic_edges",
    ...semanticCostFields,
    "duration_ms",
  ];
  const row: IngestToonRow = {
    files: report.files,
    nodes: report.nodes,
    edges: report.edges,
    docs: report.docs,
    semantic_nodes: report.semantic.nodes,
    semantic_edges: report.semantic.edges,
    ...(opts.includeSemanticCost
      ? {
          semantic_token_input: report.semantic.token_cost.input,
          semantic_token_output: report.semantic.token_cost.output,
        }
      : {}),
    duration_ms: report.durationMs,
  };
  return renderToonOutput({
    rowsKey: "ingest",
    rows: [row],
    fields,
    summary: {
      files: report.files,
      semantic_enabled: report.semantic.enabled,
      ...(opts.includeSemanticCost
        ? {
            semantic_token_input: report.semantic.token_cost.input,
            semantic_token_output: report.semantic.token_cost.output,
          }
        : {}),
    },
  });
}

async function extractFile(path: string): Promise<FileExtraction> {
  const ext = extname(path).toLowerCase();
  if (ext === ".md") {
    const m = await extractMarkdown(path);
    return {
      doc: m.doc,
      nodes: m.nodes,
      edges: m.edges,
      elements: graphElements(path, m.nodes, true),
    };
  }
  if (ext === ".sql") {
    const s = await extractSql(path);
    return {
      nodes: s.nodes,
      edges: s.edges,
      elements: graphElements(path, s.nodes, false),
    };
  }
  if (isDevArtifact(path)) {
    const d = await extractDevArtifact(path);
    return {
      nodes: d.nodes,
      edges: d.edges,
      elements: graphElements(path, d.nodes, false),
    };
  }
  if (isAssetFile(path)) {
    const a = await extractAsset(path);
    return {
      nodes: a.nodes,
      edges: a.edges,
      elements: graphElements(path, a.nodes, false),
    };
  }

  const c = await extractCode(path);
  return {
    nodes: c.nodes,
    edges: c.edges,
    elements: graphElements(path, c.nodes, false),
  };
}

function graphElements(path: string, nodes: MemoryNode[], hasDoc: boolean): string[] {
  return [
    ...new Set([
      ...(hasDoc ? [`doc:${path}`] : []),
      ...nodes.map((node) => `${node.node_type}:${node.label}`),
    ]),
  ];
}

async function writeExtraction(
  store: MemoryStore,
  extraction: FileExtraction,
): Promise<FileIndexReport> {
  const report: FileIndexReport = { nodes: 0, edges: 0, docs: 0, elements: extraction.elements };
  if (extraction.doc) {
    // The doc body is best-effort (it only feeds not-yet-enabled FTS/ASK; recall
    // reads nodes). `upsertDoc` already sizes the record to dodge the one engine
    // error that poisons the connection, so any remaining insert failure is safe
    // to swallow — skip the body, keep the file's nodes, never abort the ingest.
    try {
      await store.upsertDoc(extraction.doc);
      report.docs += 1;
    } catch {
      // Body rejected by the engine; the concept nodes below still index.
    }
    // The first node is the file's root concept; wiki-link edges hang off it.
    const labelToRid = new Map<string, number>();
    for (const node of extraction.nodes) {
      const rid = await store.upsertNode(node);
      labelToRid.set(node.label, rid);
      report.nodes += 1;
    }
    const rootRid = [...labelToRid.values()][0];
    for (const e of extraction.edges) {
      if (!("toLabel" in e)) continue;
      const toRid = await store.findNodeByLabel(e.toLabel);
      if (rootRid != null && toRid != null) {
        await store.upsertEdge({
          from_rid: rootRid,
          to_rid: toRid,
          label: e.label,
          ...("weight" in e && e.weight != null ? { weight: e.weight } : {}),
          ...("properties" in e && e.properties ? { properties: e.properties } : {}),
        });
        report.edges += 1;
      }
    }
  } else {
    const labelToRid = new Map<string, number>();
    for (const node of extraction.nodes) {
      const rid = await store.upsertNode(node);
      labelToRid.set(node.label, rid);
      report.nodes += 1;
    }
    for (const e of extraction.edges) {
      if (!("fromLabel" in e)) continue;
      const fromRid = labelToRid.get(e.fromLabel);
      const toRid = labelToRid.get(e.toLabel);
      if (fromRid != null && toRid != null) {
        await store.upsertEdge({
          from_rid: fromRid,
          to_rid: toRid,
          label: e.label,
          weight: e.weight,
          properties: e.properties,
        });
        report.edges += 1;
      }
    }
  }
  return report;
}

export interface RefreshOptions {
  /** Base directory for resolving relative changed paths. */
  rootDir?: string;
}

export interface FileManifestEntry {
  hash: string;
  format?: "element-hashes" | "element-hash-chunks";
  elements: string[];
  chunks?: number;
  element_count?: number;
}

type FileManifest = Record<string, FileManifestEntry>;

const LEGACY_FILE_MANIFEST_KEY = "ingest:file-manifest:v1";
const FILE_MANIFEST_KEY_PREFIX = "ingest:file-manifest:v2:";

/**
 * Incrementally refresh a specific set of changed files. It keeps a small
 * content-hash manifest in KV so unchanged files skip extraction entirely; when
 * a changed file no longer emits a previously-seen node/doc label, that label is
 * reported as stale but not deleted automatically.
 */
export async function refreshFiles(
  store: MemoryStore,
  paths: string[],
  opts: RefreshOptions = {},
): Promise<IngestReport> {
  const start = Date.now();
  const rootDir = opts.rootDir ?? process.cwd();
  const legacyManifest = await readLegacyFileManifest(store);
  const totals = {
    files: 0,
    nodes: 0,
    edges: 0,
    docs: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    stale: 0,
  };

  for (const rawPath of [...new Set(paths)]) {
    const path = isAbsolute(rawPath) ? rawPath : resolve(rootDir, rawPath);
    if (!INDEXABLE_EXT.has(extname(path).toLowerCase())) continue;
    const previous = await readFileManifestEntry(store, path, legacyManifest[path]);
    let hash: string;
    try {
      hash = await readIndexHash(path);
    } catch {
      if (previous) {
        totals.stale += previous.elements.length;
        await writeFileManifestEntry(store, path, { hash: "", elements: [] });
      }
      continue;
    }

    if (previous?.hash === hash) {
      totals.skipped += previous.elements.length;
      continue;
    }

    let report: FileIndexReport;
    try {
      const extraction = await extractFile(path);
      report = await writeExtraction(store, extraction);
    } catch {
      // A single transient/extractor/store failure must not abort a hook refresh.
      continue;
    }
    totals.files += 1;
    totals.nodes += report.nodes;
    totals.edges += report.edges;
    totals.docs += report.docs;
    const currentElements = new Set(compactElements(report.elements));
    totals.stale += previous?.elements.filter((element) => !currentElements.has(element)).length ?? 0;
    if (previous) {
      totals.updated += report.elements.length;
    } else {
      totals.added += report.elements.length;
    }
    await writeFileManifestEntry(store, path, { hash, elements: report.elements });
  }

  return { ...totals, semantic: emptySemanticReport(false), durationMs: Date.now() - start };
}

/**
 * Re-index a specific set of files — the PostToolUse hook's incremental path.
 * Only files matching the indexable extensions are touched; everything else
 * (lockfiles, configs, binaries the agent edited) is skipped silently. A file
 * the extractor can't read is skipped, never fatal — the hook must not break a
 * tool call. Returns the same report shape as a full ingest.
 */
export async function reindexFiles(
  store: MemoryStore,
  paths: string[],
): Promise<IngestReport> {
  return refreshFiles(store, paths);
}

/** Extensions {@link reindexFiles} will index — the leaves of DEFAULT_PATTERNS. */
const INDEXABLE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".sql",
  ".md",
  ".sh",
  ".bash",
  ".json",
  ".dockerfile",
  ".yml",
  ".yaml",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".mp3",
  ".wav",
  ".m4a",
  ".flac",
  ".ogg",
  ".mp4",
  ".mov",
  ".webm",
  ".mkv",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
]);

export async function readIndexHash(path: string): Promise<string> {
  if (isAssetFile(path)) {
    return contentHash(path, await readFile(path, "base64"));
  }
  return contentHash(path, await readFile(path, "utf8"));
}

async function readLegacyFileManifest(store: MemoryStore): Promise<FileManifest> {
  const raw = await store.kvGet<FileManifest | string>(LEGACY_FILE_MANIFEST_KEY);
  if (raw == null) return {};
  return typeof raw === "string" ? (JSON.parse(raw) as FileManifest) : raw;
}

export async function readFileManifestEntry(
  store: MemoryStore,
  path: string,
  legacyEntry?: FileManifestEntry,
): Promise<FileManifestEntry | undefined> {
  const raw = await store.kvGet<FileManifestEntry | string>(fileManifestEntryKey(path));
  if (raw == null) return legacyEntry ? normalizeManifestEntry(legacyEntry) : undefined;
  const entry = typeof raw === "string" ? (JSON.parse(raw) as FileManifestEntry) : raw;
  if (entry.format === "element-hash-chunks") {
    const elements: string[] = [];
    const chunks = Math.max(0, Math.trunc(entry.chunks ?? 0));
    for (let index = 0; index < chunks; index += 1) {
      const chunk = await store.kvGet<string[] | string>(fileManifestChunkKey(path, index));
      if (typeof chunk === "string") {
        elements.push(...(JSON.parse(chunk) as string[]));
      } else if (Array.isArray(chunk)) {
        elements.push(...chunk);
      }
    }
    return {
      hash: entry.hash,
      format: "element-hash-chunks",
      elements,
      chunks,
      element_count: entry.element_count ?? elements.length,
    };
  }
  return normalizeManifestEntry(entry);
}

async function writeFileManifestEntry(
  store: MemoryStore,
  path: string,
  entry: FileManifestEntry,
): Promise<void> {
  const elements = compactElements(entry.elements);
  const chunks = chunkArray(elements, 40);
  await store.kvPut(fileManifestEntryKey(path), {
    hash: entry.hash,
    format: "element-hash-chunks",
    elements: [],
    chunks: chunks.length,
    element_count: elements.length,
  });
  for (let index = 0; index < chunks.length; index += 1) {
    await store.kvPut(fileManifestChunkKey(path, index), chunks[index]);
  }
}

function normalizeManifestEntry(entry: FileManifestEntry): FileManifestEntry {
  if (entry.format === "element-hashes") return entry;
  return {
    hash: entry.hash,
    format: "element-hashes",
    elements: compactElements(entry.elements),
  };
}

function compactElements(elements: string[]): string[] {
  return [...new Set(elements.map((element) => contentHash("ingest-element", element)))];
}

function fileManifestEntryKey(path: string): string {
  return `${FILE_MANIFEST_KEY_PREFIX}${contentHash("path", path)}`;
}

function fileManifestChunkKey(path: string, index: number): string {
  return `${fileManifestEntryKey(path)}:${index}`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
