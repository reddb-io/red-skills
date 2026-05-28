import { buildDocReferenceGraphReport, } from "./doc-reference-graph.js";
export async function buildDocBacklinksReport(store, input) {
    const graph = await buildDocReferenceGraphReport(store);
    return docBacklinksFromGraph(graph, input);
}
export function docBacklinksFromGraph(graph, input) {
    const match = findReferenceTargets(graph, input);
    if (match.references.length === 0) {
        return {
            schema_version: "memory.doc_backlinks.v1",
            read_only: true,
            found: false,
            matched_by: null,
            query: queryText(input),
            references: [],
            docs: [],
            warnings: ["referenced node not found in doc reference graph"],
        };
    }
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const refIds = new Set(match.references.map((node) => node.id));
    const docs = new Map();
    for (const edge of graph.edges) {
        if (!refIds.has(edge.to))
            continue;
        const refs = docs.get(edge.from) ?? new Set();
        refs.add(edge.to);
        docs.set(edge.from, refs);
    }
    const backlinkDocs = [...docs.entries()]
        .map(([docId, matchedRefIds]) => backlinkDoc(nodeById, docId, matchedRefIds))
        .filter((doc) => doc != null)
        .sort((a, b) => b.matched_references - a.matched_references ||
        a.path.localeCompare(b.path));
    return {
        schema_version: "memory.doc_backlinks.v1",
        read_only: true,
        found: true,
        matched_by: match.matchedBy,
        query: queryText(input),
        references: match.references,
        docs: backlinkDocs,
        warnings: backlinkDocs.length === 0
            ? ["referenced node has no incoming document references"]
            : [],
    };
}
function findReferenceTargets(graph, input) {
    const references = graph.nodes.filter((node) => node.kind === "reference");
    if (input.rid != null) {
        return {
            references: references.filter((node) => node.rid === input.rid),
            matchedBy: "rid",
        };
    }
    if (input.label) {
        return {
            references: references.filter((node) => node.label === input.label),
            matchedBy: "label",
        };
    }
    if (input.title) {
        const title = input.title;
        return {
            references: references.filter((node) => sameText(node.title, title)),
            matchedBy: "title",
        };
    }
    const query = input.query?.trim() ?? "";
    if (!query)
        return { references: [], matchedBy: "query" };
    const exactLabel = references.filter((node) => node.label === query);
    if (exactLabel.length > 0)
        return { references: exactLabel, matchedBy: "query" };
    const exactTitle = references.filter((node) => sameText(node.title, query));
    if (exactTitle.length > 0)
        return { references: exactTitle, matchedBy: "query" };
    const normalizedQuery = normalizeEntityText(query);
    return {
        references: references.filter((node) => {
            const label = node.label.toLowerCase();
            return (normalizeEntityText(node.title) === normalizedQuery ||
                normalizeEntityText(node.label) === normalizedQuery ||
                label.endsWith(`:${normalizedQuery}`));
        }),
        matchedBy: "query",
    };
}
function backlinkDoc(nodeById, docId, refIds) {
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
        matched_references: references.length,
        references,
    };
}
function queryText(input) {
    if (input.rid != null)
        return String(input.rid);
    return input.label ?? input.title ?? input.query ?? null;
}
function sameText(left, right) {
    return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}
function normalizeEntityText(value) {
    return value.trim().toLowerCase().replaceAll(/[^a-z0-9_:-]+/g, "_");
}
