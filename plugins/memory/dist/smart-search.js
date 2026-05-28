import { buildMemoryAssetInventory, } from "./asset-inventory.js";
import { searchDocs } from "./doc-search.js";
import { recall } from "./engine.js";
import { buildVectorSearchReport, } from "./vector-search.js";
export async function buildMemorySmartSearch(store, query, opts = {}) {
    const limit = clampLimit(opts.limit);
    const [recallResult, docs, assets, vector] = await Promise.all([
        recall(store, query, {
            k: limit,
            depth: opts.depth,
            scope: opts.recall?.scope,
            includeSuperseded: opts.recall?.includeSuperseded,
            now: opts.recall?.now ?? opts.now,
        }),
        searchDocs(store, query, { limit }),
        buildMemoryAssetInventory(store, { query, limit }),
        buildVectorSearchReport(store, query, { limit }),
    ]);
    return {
        schema_version: "memory.smart_search.v1",
        read_only: true,
        query,
        generated_at: new Date(opts.now ?? Date.now()).toISOString(),
        summary: {
            recall_hits: recallResult.nodes.length,
            doc_hits: docs.hits.length,
            asset_hits: assets.assets.length,
            vector_hits: vector.hits.length,
            vector_status: vector.status,
        },
        top_results: buildTopResults(recallResult, docs, assets, vector, limit),
        recall: recallResult,
        docs,
        assets,
        vector,
        recommended_next_actions: smartSearchActions(recallResult, docs, assets, vector),
    };
}
function buildTopResults(recallResult, docs, assets, vector, limit) {
    const byId = new Map();
    const recallMax = maxScore(recallResult.nodes.map((node) => node.score));
    const docMax = maxScore(docs.hits.map((doc) => doc.score));
    const assetMax = maxScore(assets.assets.map((asset) => assetScore(asset, assets.query ?? "")));
    const vectorMax = maxScore(vector.hits.map((hit) => hit.score));
    for (const node of recallResult.nodes) {
        const id = `memory:${node.rid}`;
        const isAsset = typeof node.properties.asset_kind === "string";
        mergeResult(byId, id, {
            id,
            kind: isAsset ? "asset" : "memory",
            score: normalize(node.score, recallMax),
            sources: ["recall"],
            title: node.properties.title ?? node.label,
            excerpt: node.excerpt,
            ref: { rid: node.rid, label: node.label },
        });
    }
    for (const asset of assets.assets) {
        const id = `memory:${asset.rid}`;
        mergeResult(byId, id, {
            id,
            kind: "asset",
            score: normalize(assetScore(asset, assets.query ?? ""), assetMax) * 0.75,
            sources: ["asset"],
            title: asset.title,
            excerpt: `${asset.asset_kind} ${asset.media_type} at ${asset.path}`,
            ref: { rid: asset.rid, label: asset.label, path: asset.path },
        });
    }
    for (const doc of docs.hits) {
        const id = `doc:${doc.rid}`;
        mergeResult(byId, id, {
            id,
            kind: "doc",
            score: normalize(doc.score, docMax) * 0.8,
            sources: ["doc"],
            title: doc.title ?? doc.path,
            excerpt: doc.excerpt,
            ref: { rid: doc.rid, path: doc.path },
        });
    }
    for (const hit of vector.hits) {
        const id = `memory:${hit.rid}`;
        mergeResult(byId, id, {
            id,
            kind: hit.kind === "asset" ? "asset" : "memory",
            score: normalize(hit.score, vectorMax) * 0.65,
            sources: ["vector"],
            title: hit.title,
            excerpt: hit.excerpt,
            ref: { rid: hit.rid, label: hit.label, ...(hit.path ? { path: hit.path } : {}) },
        });
    }
    return [...byId.values()]
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((item, index) => ({ rank: index + 1, ...item }));
}
function mergeResult(byId, id, next) {
    const existing = byId.get(id);
    if (!existing) {
        byId.set(id, next);
        return;
    }
    byId.set(id, {
        ...existing,
        score: Math.min(1, existing.score + next.score * 0.25),
        sources: [...new Set([...existing.sources, ...next.sources])],
        ref: { ...existing.ref, ...next.ref },
    });
}
function maxScore(values) {
    return Math.max(1, ...values.filter((value) => Number.isFinite(value) && value > 0));
}
function normalize(value, max) {
    if (!Number.isFinite(value) || value <= 0)
        return 0;
    return Math.min(1, value / max);
}
function smartSearchActions(recallResult, docs, assets, vector) {
    const actions = [];
    if (recallResult.nodes.length === 0 && docs.hits.length === 0 && assets.assets.length === 0) {
        actions.push("bootstrap or ingest project docs before relying on Memory search");
    }
    if (docs.total_docs === 0)
        actions.push("run `memory bootstrap` or `memory ingest .` to seed document search");
    if (vector.status !== "available") {
        actions.push("run `memory vector maintain --local` for local-dev vectors or configure a vector provider");
    }
    return [...new Set(actions)];
}
function assetScore(asset, query) {
    const terms = query
        .toLowerCase()
        .split(/[^a-z0-9_.:/-]+/)
        .filter(Boolean);
    if (terms.length === 0)
        return 1;
    const haystack = [
        asset.title,
        asset.path,
        asset.asset_kind,
        asset.media_type,
        asset.hash ?? "",
    ]
        .join(" ")
        .toLowerCase();
    return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}
function clampLimit(value) {
    if (value == null || !Number.isFinite(value))
        return 10;
    return Math.min(50, Math.max(1, Math.trunc(value)));
}
