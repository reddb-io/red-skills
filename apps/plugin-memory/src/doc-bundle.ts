import {
  buildDocEvidencePack,
  type DocEvidencePack,
} from "./doc-evidence-pack.js";
import { searchDocs, type DocSearchHit } from "./doc-search.js";
import type { MemoryStore } from "./graph-store.js";

export interface DocBundleInput {
  query: string;
  limit?: number;
  max_bytes?: number;
}

export interface DocBundle {
  schema_version: "memory.doc_bundle.v1";
  read_only: true;
  query: string;
  total_docs: number;
  hits: DocSearchHit[];
  packs: DocEvidencePack[];
  markdown: string;
  warnings: string[];
}

const DEFAULT_DOC_BUNDLE_LIMIT = 3;
const MAX_DOC_BUNDLE_LIMIT = 10;

export async function buildDocBundle(
  store: MemoryStore,
  input: DocBundleInput,
): Promise<DocBundle> {
  const limit = Math.min(
    MAX_DOC_BUNDLE_LIMIT,
    Math.max(1, Math.floor(input.limit ?? DEFAULT_DOC_BUNDLE_LIMIT)),
  );
  const search = await searchDocs(store, input.query, { limit });
  const packs = await Promise.all(
    search.hits.map((hit) =>
      buildDocEvidencePack(store, {
        rid: hit.rid,
        max_bytes: input.max_bytes,
      }),
    ),
  );
  const warnings = [
    ...(search.hits.length === 0 ? ["no indexed docs matched the query"] : []),
    ...packs.flatMap((pack) => pack.warnings.map((warning) => `${pack.doc.path ?? pack.doc.rid}: ${warning}`)),
  ];
  const bundle: Omit<DocBundle, "markdown"> = {
    schema_version: "memory.doc_bundle.v1",
    read_only: true,
    query: input.query,
    total_docs: search.total_docs,
    hits: search.hits,
    packs,
    warnings,
  };
  return {
    ...bundle,
    markdown: renderMarkdown(bundle),
  };
}

function renderMarkdown(bundle: Omit<DocBundle, "markdown">): string {
  const lines: string[] = [];
  lines.push("# Memory Docs Bundle");
  lines.push("");
  lines.push(`- Query: ${bundle.query}`);
  lines.push(`- Hits: ${bundle.hits.length}/${bundle.total_docs}`);
  for (const warning of bundle.warnings) lines.push(`- Warning: ${warning}`);

  if (bundle.hits.length > 0) {
    lines.push("");
    lines.push("## Search Hits");
    for (const hit of bundle.hits) {
      lines.push(`- [${hit.score}] ${hit.path}${hit.title ? ` - ${hit.title}` : ""}`);
    }
  }

  for (const pack of bundle.packs) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(pack.markdown.trimEnd());
  }

  return `${lines.join("\n")}\n`;
}
