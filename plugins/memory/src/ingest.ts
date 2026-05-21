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

  let nodes = 0;
  let edges = 0;
  let docs = 0;

  for (const path of slice) {
    const ext = extname(path).toLowerCase();
    if (ext === ".md") {
      const m = await extractMarkdown(path);
      await store.upsertDoc(m.doc);
      docs += 1;
      // The first node is the file's root concept; wiki-link edges hang off it.
      const labelToRid = new Map<string, number>();
      for (const node of m.nodes) {
        const rid = await store.upsertNode(node);
        labelToRid.set(node.label, rid);
        nodes += 1;
      }
      const rootRid = [...labelToRid.values()][0];
      for (const e of m.edges) {
        const toRid = await store.findNodeByLabel(e.toLabel);
        if (rootRid != null && toRid != null) {
          await store.upsertEdge({ from_rid: rootRid, to_rid: toRid, label: e.label });
          edges += 1;
        }
      }
    } else {
      const c = await extractCode(path);
      const labelToRid = new Map<string, number>();
      for (const node of c.nodes) {
        const rid = await store.upsertNode(node);
        labelToRid.set(node.label, rid);
        nodes += 1;
      }
      for (const e of c.edges) {
        const fromRid = labelToRid.get(e.fromLabel);
        const toRid = labelToRid.get(e.toLabel);
        if (fromRid != null && toRid != null) {
          await store.upsertEdge({ from_rid: fromRid, to_rid: toRid, label: e.label });
          edges += 1;
        }
      }
    }
  }

  return { files: slice.length, nodes, edges, docs, durationMs: Date.now() - start };
}
