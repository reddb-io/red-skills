import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import fg from "fast-glob";
import { extractCode } from "./extract-code.js";
import { extractMarkdown } from "./extract-markdown.js";
import { contentHash } from "./hash.js";
import type { MemoryStore } from "./graph-store.js";
import type { EdgeLabel, MemoryDoc, MemoryNode } from "./schema.js";

export interface IngestOptions {
  /** Root directory to walk. */
  cwd: string;
  patterns?: string[];
  ignore?: string[];
  /** Hard cap on files indexed in one pass. Protects against huge monorepos. */
  maxFiles?: number;
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
  durationMs: number;
}

const DEFAULT_PATTERNS = ["**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs}", "**/*.md"];
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
 * extractors (`extractCode` + `extractMarkdown`). Idempotent — every node, edge,
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
  const files = await fg(opts.patterns ?? DEFAULT_PATTERNS, {
    cwd: opts.cwd,
    ignore: [...DEFAULT_IGNORE, ...(opts.ignore ?? [])],
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

  return {
    files: slice.length,
    ...totals,
    added: 0,
    updated: 0,
    skipped: 0,
    stale: 0,
    durationMs: Date.now() - start,
  };
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
    | { fromLabel: string; toLabel: string; label: EdgeLabel }
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
        await store.upsertEdge({ from_rid: rootRid, to_rid: toRid, label: e.label });
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
        await store.upsertEdge({ from_rid: fromRid, to_rid: toRid, label: e.label });
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

interface FileManifestEntry {
  hash: string;
  elements: string[];
}

type FileManifest = Record<string, FileManifestEntry>;

const FILE_MANIFEST_KEY = "ingest:file-manifest:v1";

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
  const manifest = await readFileManifest(store);
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
    const previous = manifest[path];
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch {
      if (previous) {
        totals.stale += previous.elements.length;
        delete manifest[path];
      }
      continue;
    }

    const hash = contentHash(path, source);
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
    const currentElements = new Set(report.elements);
    totals.stale += previous?.elements.filter((element) => !currentElements.has(element)).length ?? 0;
    if (previous) {
      totals.updated += report.elements.length;
    } else {
      totals.added += report.elements.length;
    }
    manifest[path] = { hash, elements: report.elements };
  }

  await writeFileManifest(store, manifest);
  return { ...totals, durationMs: Date.now() - start };
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
  ".md",
]);

async function readFileManifest(store: MemoryStore): Promise<FileManifest> {
  const raw = await store.kvGet<FileManifest | string>(FILE_MANIFEST_KEY);
  if (raw == null) return {};
  return typeof raw === "string" ? (JSON.parse(raw) as FileManifest) : raw;
}

async function writeFileManifest(store: MemoryStore, manifest: FileManifest): Promise<void> {
  await store.kvPut(FILE_MANIFEST_KEY, manifest);
}
