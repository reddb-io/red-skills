import { buildDocBundle } from "./doc-bundle.js";
export async function buildDocBrief(store, input) {
    const bundle = await buildDocBundle(store, input);
    const citations = bundle.hits.map((hit, index) => {
        const pack = bundle.packs.find((candidate) => candidate.doc.rid === hit.rid);
        return {
            marker: `[D${index + 1}]`,
            rid: hit.rid,
            path: hit.path,
            title: hit.title ?? hit.path,
            score: hit.score,
            excerpt: hit.excerpt,
            matched_fields: hit.matched_fields,
            references: pack?.related.references.slice(0, 12).map((reference) => ({
                rid: reference.rid,
                label: reference.label,
                title: reference.title,
            })) ?? [],
            related_docs: pack?.related.related_docs.slice(0, 8).map((doc) => ({
                rid: doc.rid,
                path: doc.path,
                title: doc.title,
                shared_references: doc.shared_references,
            })) ?? [],
        };
    });
    const gaps = gapsFor(bundle, citations);
    const brief = {
        schema_version: "memory.doc_brief.v1",
        read_only: true,
        query: bundle.query,
        status: statusFor(citations, gaps),
        citations,
        gaps,
        next_actions: nextActionsFor(citations, gaps),
        source_bundle: {
            schema_version: bundle.schema_version,
            total_docs: bundle.total_docs,
            hits: bundle.hits.length,
            packs: bundle.packs.length,
            warnings: bundle.warnings.length,
        },
    };
    return {
        ...brief,
        markdown: renderMarkdown(brief),
    };
}
function gapsFor(bundle, citations) {
    const gaps = [];
    if (citations.length === 0)
        gaps.push("No indexed docs matched the query.");
    if (citations.length === 1)
        gaps.push("Only one doc citation supports this brief.");
    if (citations.length > 0 && citations.every((citation) => citation.references.length === 0)) {
        gaps.push("Matched docs have no extracted REFERENCES edges.");
    }
    for (const warning of bundle.warnings)
        gaps.push(`Bundle warning: ${warning}`);
    return [...new Set(gaps)];
}
function statusFor(citations, gaps) {
    if (citations.length === 0)
        return "missing";
    return gaps.length === 0 ? "grounded" : "partial";
}
function nextActionsFor(citations, gaps) {
    const actions = [];
    if (citations.length === 0) {
        actions.push("Run `memory ingest <path>` or `memory bootstrap` to add indexed docs.");
        actions.push("Try `memory docs search <query>` with broader terms.");
    }
    if (gaps.some((gap) => gap.includes("Only one doc citation"))) {
        actions.push("Ingest or link another relevant doc before treating this brief as complete.");
    }
    if (gaps.some((gap) => gap.includes("REFERENCES"))) {
        actions.push("Run `memory ingest <path>` after adding explicit doc references or identifiers.");
    }
    if (gaps.some((gap) => gap.includes("Bundle warning"))) {
        actions.push("Inspect `memory docs coverage` and the cited docs' evidence packs.");
    }
    if (actions.length === 0)
        actions.push("Use the cited excerpts as the docs evidence block.");
    return [...new Set(actions)];
}
function renderMarkdown(brief) {
    const lines = [];
    lines.push("# Memory Docs Brief");
    lines.push("");
    lines.push(`- Query: ${brief.query}`);
    lines.push(`- Status: ${brief.status}`);
    lines.push(`- Citations: ${brief.citations.length}`);
    lines.push(`- Source bundle: ${brief.source_bundle.hits}/${brief.source_bundle.total_docs} hit(s)`);
    if (brief.citations.length > 0) {
        lines.push("");
        lines.push("## Citations");
        for (const citation of brief.citations) {
            lines.push(`- ${citation.marker} ${citation.title || citation.path} (rid ${citation.rid}, score ${citation.score})`);
            lines.push(`  ${citation.path}`);
            if (citation.references.length > 0) {
                lines.push(`  References: ${citation.references.map((reference) => reference.title).join(", ")}`);
            }
        }
        lines.push("");
        lines.push("## Evidence Excerpts");
        for (const citation of brief.citations) {
            lines.push(`- ${citation.marker} ${citation.excerpt || "(no excerpt)"}`);
        }
    }
    if (brief.gaps.length > 0) {
        lines.push("");
        lines.push("## Gaps");
        for (const gap of brief.gaps)
            lines.push(`- ${gap}`);
    }
    if (brief.next_actions.length > 0) {
        lines.push("");
        lines.push("## Next Actions");
        for (const action of brief.next_actions)
            lines.push(`- ${action}`);
    }
    return `${lines.join("\n")}\n`;
}
