const TRUNCATION_MARKER = "[…truncated to fit memory store…]";
export async function buildDocCoverageReport(store) {
    const [docs, nodes, edges, vector] = await Promise.all([
        store.listDocs(),
        store.listNodes(),
        store.listEdges(),
        vectorSummary(store),
    ]);
    const nodeByRid = new Map(nodes.map((node) => [node.rid, node]));
    const rootByHash = new Map();
    for (const node of nodes) {
        const hash = node.properties.hash;
        if (typeof hash === "string" && !rootByHash.has(hash))
            rootByHash.set(hash, node);
    }
    const normalizedEdges = edges
        .map(normalizeEdge)
        .filter((edge) => edge != null);
    const vectorDocStatus = new Map("docs" in vector
        ? vector.docs.map((doc) => [doc.rid, doc.status])
        : []);
    const items = docs
        .map((doc) => coverageItem(doc, rootByHash.get(doc.hash) ?? null, normalizedEdges, nodeByRid, vectorDocStatus))
        .sort((a, b) => a.path.localeCompare(b.path));
    const totalReferences = items.reduce((sum, item) => sum + item.references.count, 0);
    const groundedDocs = items.filter((item) => item.graph_status === "grounded").length;
    const warnings = buildWarnings(docs.length, docs.length - groundedDocs, vector);
    return {
        schema_version: "memory.doc_coverage.v1",
        read_only: true,
        total_docs: docs.length,
        grounded_docs: groundedDocs,
        ungrounded_docs: docs.length - groundedDocs,
        docs_with_references: items.filter((item) => item.references.count > 0).length,
        total_references: totalReferences,
        vector: vectorSummaryShape(vector),
        docs: items,
        warnings,
    };
}
function coverageItem(doc, rootNode, edges, nodeByRid, vectorDocStatus) {
    const referenced = rootNode
        ? edges
            .filter((edge) => edge.from_rid === rootNode.rid && edge.label === "REFERENCES")
            .map((edge) => nodeByRid.get(edge.to_rid))
            .filter((node) => node != null)
            .sort((a, b) => nodeTitle(a).localeCompare(nodeTitle(b)))
        : [];
    return {
        rid: doc.rid,
        path: doc.path,
        title: doc.title ?? null,
        hash: doc.hash,
        body_bytes: Buffer.byteLength(doc.body, "utf8"),
        truncated: doc.body.includes(TRUNCATION_MARKER),
        graph_status: rootNode ? "grounded" : "ungrounded",
        root_node: rootNode ? nodeRef(rootNode) : null,
        references: {
            count: referenced.length,
            examples: referenced.slice(0, 5).map(nodeRef),
        },
        vector_status: vectorDocStatus.get(doc.rid) ?? "missing",
    };
}
async function vectorSummary(store) {
    try {
        return await store.vectorStatus();
    }
    catch (err) {
        return {
            overall: "unavailable",
            total: 0,
            ready: 0,
            stale: 0,
            unavailable: 0,
            failed: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
function vectorSummaryShape(vector) {
    return {
        overall: vector.overall,
        total: vector.total,
        ready: vector.ready,
        stale: vector.stale,
        unavailable: vector.unavailable,
        failed: vector.failed,
        ...("error" in vector && vector.error ? { error: vector.error } : {}),
    };
}
function buildWarnings(totalDocs, ungroundedDocs, vector) {
    const warnings = [];
    if (totalDocs === 0)
        warnings.push("no ingested documents found");
    if (ungroundedDocs > 0) {
        warnings.push(`${ungroundedDocs} document(s) lack a matching graph root node`);
    }
    if (vector.failed > 0)
        warnings.push(`${vector.failed} vector projection(s) failed`);
    if (vector.overall === "unavailable") {
        warnings.push("vector projection is unavailable");
    }
    return warnings;
}
function nodeRef(node) {
    return {
        rid: node.rid,
        label: node.label,
        node_type: node.node_type,
        title: nodeTitle(node),
    };
}
function nodeTitle(node) {
    const title = node.properties.title;
    return typeof title === "string" && title.trim() ? title : node.label;
}
function normalizeEdge(row) {
    const r = row;
    const label = r.label ?? r.LABEL;
    const from = r.from ?? r.from_id ?? r.from_rid ?? r.source ?? r.FROM;
    const to = r.to ?? r.to_id ?? r.to_rid ?? r.target ?? r.TO;
    const fromRid = Number(from);
    const toRid = Number(to);
    if (typeof label !== "string" || !Number.isFinite(fromRid) || !Number.isFinite(toRid)) {
        return null;
    }
    return {
        rid: numberOrUndefined(r.rid ?? r.red_entity_id),
        label: label,
        from_rid: fromRid,
        to_rid: toRid,
        weight: numberOrUndefined(r.weight ?? r.WEIGHT),
        properties: (r.properties ?? r.PROPERTIES),
    };
}
function numberOrUndefined(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
