import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import matter from "gray-matter";
import { contentHash } from "./hash.js";
import type { EdgeLabel, MemoryDoc, MemoryNode } from "./schema.js";

/** A markdown file's extracted graph fragment: the doc chunk, nodes, edges. */
export interface MarkdownExtraction {
  doc: MemoryDoc;
  nodes: MemoryNode[];
  /** Edges as (fromHash, toLabel, label) — the indexer resolves rids after upsert. */
  edges: Array<{ fromHash: string; toLabel: string; label: EdgeLabel }>;
}

const WIKILINK_RE = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/gm;

/**
 * Markdown extraction (the deterministic `EXTRACTED` path).
 *
 * Ported from red-memory `packages/extractor/src/markdown.ts`. Pure structural
 * parse, no LLM calls:
 *   - one root `concept` node for the file, plus one per h1–h3 heading
 *   - the underlying doc chunk (body + frontmatter) for later FTS/ASK
 *   - a `REFERENCES` edge per `[[wiki-link]]`, keyed by the source file's hash
 */
export async function extractMarkdown(path: string): Promise<MarkdownExtraction> {
  const raw = await readFile(path, "utf8");
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content;
  const hash = contentHash(path, raw);
  const updated_at = Date.now();

  const title = (fm.title as string | undefined) ?? deriveTitle(body) ?? basename(path);
  const tags = ((fm.tags as string[] | undefined) ?? []).map(String);

  const doc: MemoryDoc = { path, title, body, frontmatter: fm, hash, updated_at };

  const nodes: MemoryNode[] = [];
  const seenHeadings = new Set<string>();

  // Root concept node for the file.
  nodes.push({
    label: `md:${path}`,
    node_type: "concept",
    properties: {
      title,
      summary: deriveSummary(body),
      tags,
      source: path,
      confidence: "EXTRACTED",
      hash,
    },
  });

  for (const match of body.matchAll(HEADING_RE)) {
    const level = match[1]?.length ?? 1;
    const text = match[2]?.trim();
    if (!text || level > 3) continue;
    const slug = slugify(text);
    if (seenHeadings.has(slug)) continue;
    seenHeadings.add(slug);
    nodes.push({
      label: `md:${path}#${slug}`,
      node_type: "concept",
      properties: {
        title: text,
        source: `${path}#${slug}`,
        confidence: "EXTRACTED",
        hash: contentHash(path, slug, text),
      },
    });
  }

  const edges: MarkdownExtraction["edges"] = [];
  for (const link of body.matchAll(WIKILINK_RE)) {
    const target = link[1]?.trim();
    if (!target) continue;
    edges.push({ fromHash: hash, toLabel: target, label: "REFERENCES" });
  }

  return { doc, nodes, edges };
}

function deriveTitle(body: string): string | undefined {
  const m = body.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim();
}

function deriveSummary(body: string): string | undefined {
  const stripped = body.replace(/^#.*$/gm, "").trim();
  const firstPara = stripped.split(/\n\s*\n/)[0];
  return firstPara?.slice(0, 280);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
}
