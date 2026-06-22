// platform/skill-paths.ts — locate the shipped AFK skill directory from a
// module path.
//
// The lifecycle hook path (runtime/hooks.ts) needs the skill root to resolve the
// built-in library hooks under `<skill>/hooks/red-*`. The bundle ships at
// `<skill>/bin/afk.mjs`, so from the running bundle the skill dir is two levels
// up. We walk ancestors looking for the `hooks/` directory (which always ships
// alongside the bundle); `hooks/red-cargo` is the stable anchor.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Walk up from `metaUrl`'s directory until an ancestor contains the AFK skill's
 * `hooks/red-cargo` library script, returning that ancestor (the skill root).
 * Throws when no such ancestor exists within 8 levels — e.g. a source-tree run,
 * where the skill lives under `plugins/`, not above `src/`; callers treat the
 * throw as "skill dir unreachable" and fall back accordingly.
 */
export function skillDirFromModule(metaUrl = import.meta.url): string {
  let cursor = dirname(fileURLToPath(metaUrl));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(cursor, "hooks", "red-cargo"))) return cursor;
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  throw new Error("could not locate AFK skill directory from module path");
}
