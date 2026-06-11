import { buildDocRelatedReport, type DocRelatedReport } from "./doc-related.js";
import { readDoc, type DocReadResult } from "./doc-search.js";
import type { MemoryStore } from "./graph-store.js";

export interface DocEvidencePackInput {
  path?: string;
  rid?: number;
  max_bytes?: number;
}

export interface DocEvidencePack {
  schema_version: "memory.doc_evidence_pack.v1";
  read_only: true;
  found: boolean;
  matched_by: "path" | "rid" | null;
  doc: DocReadResult;
  related: DocRelatedReport;
  markdown: string;
  warnings: string[];
}

export async function buildDocEvidencePack(
  store: MemoryStore,
  input: DocEvidencePackInput,
): Promise<DocEvidencePack> {
  const [doc, related] = await Promise.all([
    readDoc(store, input),
    buildDocRelatedReport(store, { path: input.path, rid: input.rid }),
  ]);
  const warnings = [
    ...(!doc.found ? ["document body not found in memory_docs"] : []),
    ...related.warnings,
  ];
  const pack: Omit<DocEvidencePack, "markdown"> = {
    schema_version: "memory.doc_evidence_pack.v1",
    read_only: true,
    found: doc.found || related.found,
    matched_by: doc.matched_by ?? related.matched_by,
    doc,
    related,
    warnings,
  };
  return {
    ...pack,
    markdown: renderMarkdown(pack),
  };
}

function renderMarkdown(pack: Omit<DocEvidencePack, "markdown">): string {
  const lines: string[] = [];
  lines.push("# Memory Doc Evidence Pack");
  lines.push("");
  lines.push(`- Found: ${pack.found ? "yes" : "no"}`);
  lines.push(`- Matched by: ${pack.matched_by ?? "none"}`);
  if (pack.doc.path) lines.push(`- Path: ${pack.doc.path}`);
  if (pack.doc.rid != null) lines.push(`- Doc rid: ${pack.doc.rid}`);
  if (pack.doc.title) lines.push(`- Title: ${pack.doc.title}`);
  lines.push(`- References: ${pack.related.references.length}`);
  lines.push(`- Related docs: ${pack.related.related_docs.length}`);
  for (const warning of pack.warnings) lines.push(`- Warning: ${warning}`);

  if (pack.related.references.length > 0) {
    lines.push("");
    lines.push("## References");
    for (const ref of pack.related.references.slice(0, 20)) {
      lines.push(`- ${ref.title} (${ref.label}, rid ${ref.rid})`);
    }
  }

  if (pack.related.related_docs.length > 0) {
    lines.push("");
    lines.push("## Related Docs");
    for (const doc of pack.related.related_docs.slice(0, 12)) {
      lines.push(
        `- ${doc.path} (${doc.shared_references} shared reference(s), rid ${doc.rid})`,
      );
    }
  }

  if (pack.doc.body) {
    lines.push("");
    lines.push("## Indexed Body");
    lines.push("");
    lines.push("```markdown");
    lines.push(pack.doc.body);
    lines.push("```");
    if (pack.doc.truncated) {
      lines.push("");
      lines.push(
        `_Body truncated to ${pack.doc.returned_bytes}/${pack.doc.body_bytes} byte(s)._`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}
