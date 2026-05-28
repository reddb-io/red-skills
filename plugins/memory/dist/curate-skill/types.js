/**
 * Curate-skill workflow types. This module is the engine consumed by the
 * `/curate` skill in the dev plugin — the slash command orchestrates the
 * candidate read → consent → archive/restore loop, and the modules here are
 * the pure pieces that loop calls into.
 *
 * The TypeScript code colocates with the Memory plugin to share its tsx /
 * vitest toolchain and the Skill telemetry types; the mutation workflow
 * itself remains the `/curate` skill in `plugins/dev`, so CONTEXT.md's "skill
 * mutation is a workflow outside the Memory plugin" rule is honoured at the
 * workflow level. The Memory CLI never invokes archive or restore.
 */
/** Read-only source kinds — defensively rejected by the archive engine. */
export const READ_ONLY_SOURCE_KINDS = new Set(["plugin", "hub"]);
/**
 * Curator categories the interactive /curate workflow can act on. The full
 * curator emits more (consolidation, restore) but those land in later slices;
 * here we cover every category the brief lists as in-scope.
 */
export const CURATE_CATEGORIES = [
    "stale",
    "abandoned",
    "frequently-failing",
    "archive",
];
export function isCurateCategory(value) {
    return CURATE_CATEGORIES.includes(value);
}
