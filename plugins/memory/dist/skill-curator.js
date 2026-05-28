/**
 * memory:curate skills — the first report-only Skill curator surface.
 *
 * It reads Memory-owned Skill telemetry rollups and turns the evidence into
 * recommendations: stale, abandoned, frequently-failing, consolidation,
 * archive, and restore candidates. It is *pure* — it takes rollups and returns
 * a report. It never reads or writes a skill file, never opens the store, and
 * never calls a model. Mutating Curatable-skill workflows (patch / delete /
 * archive / restore / consolidate) stay out of the Memory plugin entirely; this
 * surface only describes what the evidence supports (CONTEXT.md: a Skill curator
 * "does not mutate skills itself").
 *
 * Bundled, read-only skills (`source_kind` of `plugin`/`hub`) can still surface
 * *observational* signals (stale / abandoned / frequently-failing), but never a
 * *mutation* recommendation (archive / consolidation / restore) — those only
 * make sense for Curatable skills, which are user-owned or agent-created.
 */
const MS_PER_DAY = 86_400_000;
/** Source kinds that are bundled, read-only content — never Curatable. */
const READ_ONLY_SOURCE_KINDS = new Set(["plugin", "hub"]);
export const CURATION_CATEGORIES = [
    "stale",
    "abandoned",
    "frequently-failing",
    "consolidation",
    "archive",
    "restore",
];
/** Categories that recommend a mutation — only ever emitted for Curatable skills. */
const MUTATION_CATEGORIES = new Set(["consolidation", "archive", "restore"]);
/** A skill is Curatable unless it is bundled read-only plugin/hub content. */
export function isCuratable(sourceKind) {
    return !READ_ONLY_SOURCE_KINDS.has(sourceKind);
}
/**
 * Turn Skill telemetry rollups into report-only curation recommendations.
 * Pure and deterministic — same input, same output, no IO, no model.
 */
export function curateSkills(skills, opts = {}) {
    const staleDays = opts.staleDays ?? 60;
    const now = opts.now ?? Date.now();
    const minViews = opts.minViewsForAbandoned ?? 3;
    const minResults = opts.minResultsForFailure ?? 5;
    const failureRatio = opts.failureRatio ?? 0.5;
    const staleCutoffMs = staleDays * MS_PER_DAY;
    const recommendations = [];
    let curatableSkills = 0;
    for (const skill of skills) {
        const curatable = isCuratable(skill.source_kind);
        if (curatable)
            curatableSkills += 1;
        const idleMs = now - Date.parse(skill.last_activity);
        const idleDays = Math.max(0, Math.floor(idleMs / MS_PER_DAY));
        const isStale = idleMs >= staleCutoffMs;
        const failed = skill.outcome_counts.failed ?? 0;
        const succeeded = skill.outcome_counts.succeeded ?? 0;
        const abandonedOutcomes = skill.outcome_counts.abandoned ?? 0;
        const push = (category, reason) => {
            // Mutation recommendations are limited to Curatable skills.
            if (MUTATION_CATEGORIES.has(category) && !curatable)
                return;
            recommendations.push({
                name: skill.name,
                source_kind: skill.source_kind,
                path: skill.path,
                curatable,
                category,
                reason,
            });
        };
        // --- observational signals (emitted for every skill) ---
        if (isStale) {
            push("stale", `no skill activity for ${idleDays}d (threshold ${staleDays}d)`);
        }
        if ((skill.view_count >= minViews && skill.use_count === 0) ||
            (abandonedOutcomes > 0 && abandonedOutcomes > succeeded)) {
            push("abandoned", skill.use_count === 0
                ? `loaded ${skill.view_count}× but never invoked`
                : `${abandonedOutcomes} abandoned outcome(s) outweigh ${succeeded} success(es)`);
        }
        if (skill.result_count >= minResults && failed / skill.result_count >= failureRatio) {
            const pct = Math.round((failed / skill.result_count) * 100);
            push("frequently-failing", `${failed}/${skill.result_count} results failed (${pct}%)`);
        }
        // --- mutation signals (Curatable skills only, enforced in push) ---
        if (skill.consolidation_signal) {
            push("consolidation", "telemetry flags overlap with another skill");
        }
        if (skill.archive_signal || (isStale && skill.use_count === 0)) {
            push("archive", skill.archive_signal
                ? "telemetry flags this skill for archival"
                : `stale (${idleDays}d) and never invoked`);
        }
        if (skill.curatable_status !== "active" && !isStale) {
            push("restore", `marked "${skill.curatable_status}" but active again (${idleDays}d idle)`);
        }
    }
    // Deterministic ordering: by category priority, then skill name.
    const order = new Map(CURATION_CATEGORIES.map((c, i) => [c, i]));
    recommendations.sort((a, b) => (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0) || a.name.localeCompare(b.name));
    return {
        generatedAt: new Date(now).toISOString(),
        staleDays,
        totalSkills: skills.length,
        curatableSkills,
        readOnlySkills: skills.length - curatableSkills,
        recommendations,
    };
}
/** Narrowing helper so callers can pass plain {@link SkillRollup}s. */
export function rollupsToCuratorInput(rollups) {
    return rollups.map((r) => ({ ...r }));
}
