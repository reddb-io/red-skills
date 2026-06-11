// platform/skill-paths.ts — locate the shipped AFK skill directory from a
// module path.
//
// The lifecycle hook path (runtime/hooks.ts) needs the skill root to resolve the
// built-in hook defaults under `<skill>/defaults/*.sh`. The bundle ships at
// `<skill>/bin/afk.mjs`, so from the running bundle the skill dir is two levels
// up. We walk ancestors looking for the `defaults/` directory (which always
// ships alongside the bundle); the legacy `scripts/` orchestration bash has been
// removed, so `defaults/` is the stable anchor.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `metaUrl`'s directory until an ancestor contains the AFK skill's
 * `defaults/` directory, returning that ancestor (the skill root). Throws when
 * no such ancestor exists within 8 levels — e.g. a source-tree run, where the
 * skill lives under `plugins/`, not above `src/`; callers treat the throw as
 * "skill dir unreachable" and fall back accordingly.
 */
export function skillDirFromModule(metaUrl = import.meta.url): string {
  let cursor = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(cursor, "defaults", "cargo-pre-worktree.sh"))) return cursor;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error("could not locate AFK skill directory from module path");
}
