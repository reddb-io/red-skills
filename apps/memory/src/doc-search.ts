import type { MemoryStore } from "./graph-store.js";
import type { MemoryDoc } from "./schema.js";

export interface DocSearchHit {
  rid: number;
  path: string;
  title: string | null;
  score: number;
  excerpt: string;
  matched_fields: Array<"path" | "title" | "frontmatter" | "body">;
  body_length: number;
  updated_at: number;
}

export interface DocSearchReport {
  query: string;
  total_docs: number;
  hits: DocSearchHit[];
}

export interface DocReadInput {
  path?: string;
  rid?: number;
  max_bytes?: number;
}

export interface DocReadResult {
  found: boolean;
  matched_by: "path" | "rid" | null;
  rid: number | null;
  path: string | null;
  title: string | null;
  body: string;
  body_length: number;
  body_bytes: number;
  returned_bytes: number;
  truncated: boolean;
  frontmatter: Record<string, unknown> | null;
  hash: string | null;
  updated_at: number | null;
}

type StoredDoc = MemoryDoc & { rid: number };
const DEFAULT_DOC_READ_MAX_BYTES = 20_000;

export async function searchDocs(
  store: MemoryStore,
  query: string,
  opts: { limit?: number } = {},
): Promise<DocSearchReport> {
  const terms = tokenize(query);
  const docs = await store.listDocs();
  if (terms.length === 0) return { query, total_docs: docs.length, hits: [] };

  const hits = docs
    .map((doc) => scoreDoc(doc, terms))
    .filter((hit): hit is DocSearchHit => hit != null)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, opts.limit ?? 10);

  return { query, total_docs: docs.length, hits };
}

export async function readDoc(
  store: MemoryStore,
  input: DocReadInput,
): Promise<DocReadResult> {
  const docs = await store.listDocs();
  const byRid =
    input.rid != null ? docs.find((doc) => doc.rid === input.rid) : undefined;
  const byPath =
    byRid == null && input.path ? docs.find((doc) => doc.path === input.path) : undefined;
  const doc = byRid ?? byPath;
  if (!doc) {
    return {
      found: false,
      matched_by: null,
      rid: input.rid ?? null,
      path: input.path ?? null,
      title: null,
      body: "",
      body_length: 0,
      body_bytes: 0,
      returned_bytes: 0,
      truncated: false,
      frontmatter: null,
      hash: null,
      updated_at: null,
    };
  }

  const maxBytes = input.max_bytes ?? DEFAULT_DOC_READ_MAX_BYTES;
  const body = truncateUtf8(doc.body, maxBytes);
  return {
    found: true,
    matched_by: byRid ? "rid" : "path",
    rid: doc.rid,
    path: doc.path,
    title: doc.title ?? null,
    body,
    body_length: doc.body.length,
    body_bytes: Buffer.byteLength(doc.body, "utf8"),
    returned_bytes: Buffer.byteLength(body, "utf8"),
    truncated: body.length !== doc.body.length,
    frontmatter: doc.frontmatter ?? null,
    hash: doc.hash,
    updated_at: doc.updated_at,
  };
}

function scoreDoc(doc: StoredDoc, terms: string[]): DocSearchHit | null {
  const fields = {
    path: doc.path,
    title: doc.title ?? "",
    frontmatter: JSON.stringify(doc.frontmatter ?? {}),
    body: doc.body,
  };
  const matched_fields: DocSearchHit["matched_fields"] = [];
  let score = 0;

  for (const [field, value] of Object.entries(fields) as Array<
    [DocSearchHit["matched_fields"][number], string]
  >) {
    const tokens = tokenize(value);
    let fieldScore = 0;
    for (const token of tokens) {
      if (terms.includes(token)) fieldScore += 1;
    }
    if (fieldScore > 0) {
      matched_fields.push(field);
      score += fieldScore * fieldWeight(field);
    }
  }

  if (score === 0) return null;
  return {
    rid: doc.rid,
    path: doc.path,
    title: doc.title ?? null,
    score,
    excerpt: excerpt(doc, terms),
    matched_fields,
    body_length: doc.body.length,
    updated_at: doc.updated_at,
  };
}

function fieldWeight(field: DocSearchHit["matched_fields"][number]): number {
  switch (field) {
    case "title":
      return 4;
    case "path":
      return 3;
    case "frontmatter":
      return 2;
    case "body":
      return 1;
  }
}

function excerpt(doc: StoredDoc, terms: string[]): string {
  const haystack = doc.body.replace(/\s+/g, " ").trim();
  if (!haystack) return doc.title ?? doc.path;
  const lower = haystack.toLowerCase();
  const first = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (first ?? 0) - 80);
  const end = Math.min(haystack.length, start + 240);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < haystack.length ? "..." : "";
  return `${prefix}${haystack.slice(start, end)}${suffix}`;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_:/.-]+/g) ?? []).filter(Boolean);
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const next = bytes + Buffer.byteLength(char, "utf8");
    if (next > maxBytes) break;
    bytes = next;
    end += char.length;
  }
  return text.slice(0, end);
}
