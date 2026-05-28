/**
 * Hybrid recall composer — folds an arbitrary number of ranked id lists into a
 * single ranking via Reciprocal Rank Fusion (RRF):
 *
 *   score(d) = Σ_i 1 / (k + rank_i(d))
 *
 * where `rank_i(d)` is `d`'s 1-indexed rank in source `i` and `k` is the RRF
 * smoothing constant from Cormack, Clarke & Büttcher (SIGIR '09) — by
 * convention `k = 60`. RRF carries no per-source weights and no learned
 * coefficients: every input ranking contributes purely by position. That is
 * the property the wider memory recall path relies on — vector, keyword, and
 * graph-distance rankings are blended without hand-tuned multipliers.
 *
 * This module is pure. It does not touch the store, the graph, or any I/O.
 */
/** Default RRF smoothing constant (Cormack et al., SIGIR '09). */
export const RRF_K = 60;
/**
 * Reciprocal Rank Fusion over the supplied rankings. The output is sorted by
 * fused score descending, with ties broken by ascending rid for determinism.
 *
 * Duplicate rids within a single ranking are collapsed to their best (lowest)
 * rank. Sources with empty `rids` contribute nothing but are still allowed —
 * a vector-unavailable call site can pass `{ source: "vector", rids: [] }`
 * without special-casing.
 */
export function hybridRecall(rankings, opts = {}) {
    const k = opts.k ?? RRF_K;
    const acc = new Map();
    for (const ranking of rankings) {
        const seenInThis = new Set();
        for (let i = 0; i < ranking.rids.length; i++) {
            const rid = ranking.rids[i];
            if (!Number.isFinite(rid))
                continue;
            if (seenInThis.has(rid))
                continue;
            seenInThis.add(rid);
            const rank = i + 1;
            const contribution = 1 / (k + rank);
            const entry = acc.get(rid) ?? { rid, score: 0, contributors: {} };
            entry.score += contribution;
            entry.contributors[ranking.source] = rank;
            acc.set(rid, entry);
        }
    }
    const hits = [...acc.values()];
    hits.sort((a, b) => b.score - a.score || a.rid - b.rid);
    return opts.limit != null ? hits.slice(0, opts.limit) : hits;
}
