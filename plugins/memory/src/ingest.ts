import { extname } from "node:path";
import fg from "fast-glob";
import { extractCode } from "./extract-code.js";
import { extractMarkdown } from "./extract-markdown.js";
import type { MemoryStore } from "./graph-store.js";

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

  return { files: slice.length, ...totals, durationMs: Date.now() - start };
}

/** Per-file node/edge/doc counts from a single {@link indexFile} pass. */
export interface FileIndexReport {
  nodes: number;
  edges: number;
  docs: number;
}

/**
 * Index one file into the graph store, dispatching on extension to the markdown
 * or code extractor. The shared unit behind {@link ingestProject} (full walk)
 * and {@link reindexFiles} (the PostToolUse incremental re-index). Idempotent —
 * every node/edge/doc dedupes by content hash.
 */
export async function indexFile(store: MemoryStore, path: string): Promise<FileIndexReport> {
  const report: FileIndexReport = { nodes: 0, edges: 0, docs: 0 };
  const ext = extname(path).toLowerCase();
  if (ext === ".md") {
    const m = await extractMarkdown(path);
    await store.upsertDoc(m.doc);
    report.docs += 1;
    // The first node is the file's root concept; wiki-link edges hang off it.
    const labelToRid = new Map<string, number>();
    for (const node of m.nodes) {
      const rid = await store.upsertNode(node);
      labelToRid.set(node.label, rid);
      report.nodes += 1;
    }
    const rootRid = [...labelToRid.values()][0];
    for (const e of m.edges) {
      const toRid = await store.findNodeByLabel(e.toLabel);
      if (rootRid != null && toRid != null) {
        await store.upsertEdge({ from_rid: rootRid, to_rid: toRid, label: e.label });
        report.edges += 1;
      }
    }
  } else {
    const c = await extractCode(path);
    const labelToRid = new Map<string, number>();
    for (const node of c.nodes) {
      const rid = await store.upsertNode(node);
      labelToRid.set(node.label, rid);
      report.nodes += 1;
    }
    for (const e of c.edges) {
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
  const start = Date.now();
  const indexable = paths.filter((p) => INDEXABLE_EXT.has(extname(p).toLowerCase()));
  const totals = { files: 0, nodes: 0, edges: 0, docs: 0 };
  for (const path of indexable) {
    try {
      const r = await indexFile(store, path);
      totals.files += 1;
      totals.nodes += r.nodes;
      totals.edges += r.edges;
      totals.docs += r.docs;
    } catch {
      // A single unreadable/transient file must not abort the re-index.
    }
  }
  return { ...totals, durationMs: Date.now() - start };
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
