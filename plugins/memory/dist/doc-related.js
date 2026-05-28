import { buildDocReferenceGraphReport, } from "./doc-reference-graph.js";
export async function buildDocRelatedReport(store, input) {
    const graph = await buildDocReferenceGraphReport(store);
    return docRelatedFromGraph(graph, input);
}
export function docRelatedFromGraph(graph, input) {
    const target = findTargetDoc(graph, input);
    if (!target) {
        return {
            schema_version: "memory.doc_related.v1",
            read_only: true,
            found: false,
            matched_by: null,
            target: null,
            references: [],
            related_docs: [],
            warnings: ["document not found in doc reference graph"],
        };
    }
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const outgoing = graph.edges.filter((edge) => edge.from === target.id);
    const targetRefIds = new Set(outgoing.map((edge) => edge.to));
    const references = [...targetRefIds]
        .map((id) => nodeById.get(id))
        .filter((node) => node != null)
        .sort((a, b) => a.title.localeCompare(b.title));
    const related = new Map();
    for (const edge of graph.edges) {
        if (edge.from === target.id || !targetRefIds.has(edge.to))
            continue;
        const refs = related.get(edge.from) ?? new Set();
        refs.add(edge.to);
        related.set(edge.from, refs);
    }
    const relatedDocs = [...related.entries()]
        .map(([docId, refIds]) => relatedDoc(nodeById, docId, refIds))
        .filter((doc) => doc != null)
        .sort((a, b) => b.shared_references - a.shared_references ||
        a.path.localeCompare(b.path));
    return {
        schema_version: "memory.doc_related.v1",
        read_only: true,
        found: true,
        matched_by: input.rid != null ? "rid" : "path",
        target,
        references,
        related_docs: relatedDocs,
        warnings: references.length === 0 ? ["target document has no extracted references"] : [],
    };
}
function findTargetDoc(graph, input) {
    const docs = graph.nodes.filter((node) => node.kind === "doc");
    if (input.rid != null) {
        return docs.find((node) => node.rid === input.rid) ?? null;
    }
    if (input.path) {
        return (docs
            .filter((node) => node.path === input.path)
            .sort((a, b) => (b.outgoing_references ?? 0) - (a.outgoing_references ?? 0) ||
            b.rid - a.rid)[0] ?? null);
    }
    return null;
}
function relatedDoc(nodeById, docId, refIds) {
    const doc = nodeById.get(docId);
    if (!doc || doc.kind !== "doc" || !doc.path)
        return null;
    const references = [...refIds]
        .map((id) => nodeById.get(id))
        .filter((node) => node != null)
        .sort((a, b) => a.title.localeCompare(b.title));
    return {
        rid: doc.rid,
        path: doc.path,
        title: doc.title,
        shared_references: references.length,
        references,
    };
}
