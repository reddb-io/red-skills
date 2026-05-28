/**
 * candidate-reader — pure adapter from the report-only `memory curate skills
 * --json` envelope to the candidates the `/curate` skill acts on. Returns
 * candidates across every category in {@link CURATE_CATEGORIES} (`stale`,
 * `abandoned`, `frequently-failing`, `archive`), each tagged with the
 * surfacing category and the category's evidence in `reason`. Defensive on
 * top of Memory's own filtering: a future report leaking a `plugin`/`hub`
 * recommendation or a non-curatable item is dropped before consent.
 */
import { CURATE_CATEGORIES, READ_ONLY_SOURCE_KINDS, isCurateCategory, } from "./types.js";
export function readArchiveCandidates(envelope, opts = {}) {
    const pinned = opts.pinned ?? new Set();
    const candidates = [];
    const filtered = [];
    for (const rec of envelope.recommendations) {
        if (!isCurateCategory(rec.category))
            continue;
        if (READ_ONLY_SOURCE_KINDS.has(rec.source_kind)) {
            filtered.push({
                name: rec.name,
                category: rec.category,
                reason: `source_kind=${rec.source_kind} is read-only`,
            });
            continue;
        }
        if (!rec.curatable) {
            filtered.push({
                name: rec.name,
                category: rec.category,
                reason: "not curatable per report",
            });
            continue;
        }
        if (pinned.has(rec.name)) {
            filtered.push({ name: rec.name, category: rec.category, reason: "pinned" });
            continue;
        }
        candidates.push({
            name: rec.name,
            source_kind: rec.source_kind,
            path: rec.path,
            reason: rec.reason,
            category: rec.category,
            pinned: false,
        });
    }
    const order = new Map(CURATE_CATEGORIES.map((c, i) => [c, i]));
    candidates.sort((a, b) => (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0) || a.name.localeCompare(b.name));
    const byCategory = {};
    for (const cand of candidates) {
        const bucket = byCategory[cand.category] ?? [];
        bucket.push(cand);
        byCategory[cand.category] = bucket;
    }
    return { candidates, byCategory, filtered };
}
/** Parse a raw JSON string into an envelope. Throws on malformed JSON. */
export function parseCuratorReport(raw) {
    const value = JSON.parse(raw);
    if (!Array.isArray(value.recommendations)) {
        throw new Error("curator report missing recommendations[]");
    }
    // Strip unknown keys defensively while keeping the typed shape.
    const recs = value.recommendations.map((r) => ({
        name: String(r.name),
        source_kind: String(r.source_kind),
        path: String(r.path),
        curatable: Boolean(r.curatable),
        category: String(r.category),
        reason: String(r.reason ?? ""),
    }));
    return {
        generatedAt: String(value.generatedAt ?? ""),
        staleDays: Number(value.staleDays ?? 0),
        totalSkills: Number(value.totalSkills ?? 0),
        curatableSkills: Number(value.curatableSkills ?? 0),
        readOnlySkills: Number(value.readOnlySkills ?? 0),
        recommendations: recs,
    };
}
