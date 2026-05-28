export async function buildVectorSearchReport(store, query, options = {}) {
    const limit = clampLimit(options.limit);
    try {
        const rows = dedupeRows(await store.searchVector(query, limit));
        const hits = [];
        for (const row of rows) {
            const node = await store.getNode(row.rid);
            if (!node)
                continue;
            hits.push(vectorHitFromNode(node, row.score));
        }
        return { query, limit, status: "available", hits, read_only: true };
    }
    catch (err) {
        return {
            query,
            limit,
            status: "unavailable",
            hits: [],
            error: err instanceof Error ? err.message : String(err),
            read_only: true,
        };
    }
}
function vectorHitFromNode(node, score) {
    const props = node.properties;
    const title = stringValue(props.title) ?? node.label;
    const assetKind = stringValue(props.asset_kind);
    const path = stringValue(props.source);
    return {
        rid: node.rid,
        score,
        kind: assetKind ? "asset" : "memory",
        label: node.label,
        node_type: node.node_type,
        title,
        excerpt: excerptFromNode(node),
        confidence: confidenceValue(props.confidence),
        source: stringValue(props.source),
        ...(assetKind ? { asset_kind: assetKind } : {}),
        ...(assetKind && path ? { path } : {}),
        ...(assetKind && stringValue(props.media_type)
            ? { media_type: stringValue(props.media_type) ?? undefined }
            : {}),
    };
}
function excerptFromNode(node) {
    const props = node.properties;
    const text = stringValue(props.summary) ??
        stringValue(props.content) ??
        stringValue(props.title) ??
        node.label;
    return cleanExcerpt(text, 220);
}
function dedupeRows(rows) {
    const byRid = new Map();
    for (const row of rows) {
        const existing = byRid.get(row.rid);
        if (!existing) {
            byRid.set(row.rid, row);
            continue;
        }
        existing.score = Math.max(existing.score, row.score);
    }
    return [...byRid.values()];
}
function cleanExcerpt(value, limit) {
    const clean = value.replace(/\s+/g, " ").trim();
    if (clean.length <= limit)
        return clean;
    return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value : null;
}
function confidenceValue(value) {
    return value === "EXTRACTED" || value === "INFERRED" || value === "AMBIGUOUS"
        ? value
        : "INFERRED";
}
function clampLimit(value) {
    if (value == null || !Number.isFinite(value))
        return 20;
    return Math.min(50, Math.max(1, Math.trunc(value)));
}
