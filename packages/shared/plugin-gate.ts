/**
 * plugin-gate.ts — the per-directory plugin activation gate (ADR 0067).
 *
 * RedSkills hooks are installed GLOBALLY on every agent (Claude Code, Codex,
 * opencode), so without a gate a plugin's lifecycle hooks fire in *every*
 * directory — even repos that never opted in. This module is the single
 * predicate every hook launcher consults FIRST, before doing any work (bundle
 * fetch, subprocess spawn, side effects):
 *
 *   - no `.red/config.yaml` reachable from cwd        → disabled. The project
 *     does not use RedSkills; stay fully inert (no fetch, no spawn).
 *   - `.red/config.yaml` present but no explicit
 *     `plugins.<name>.enabled: true`                  → disabled (strict
 *     opt-in — ADR 0067). Block-presence alone is NOT enough.
 *   - `plugins.<name>.enabled: true`                  → enabled.
 *
 * Only `/setup-red-skills` may create `.red/`; this gate NEVER creates anything,
 * it only reads. It is dependency-free (constrained-subset YAML, the same
 * grammar ADR 0042 uses) so it can run inside the pre-bundle launchers
 * (`red-fetch.mjs`, `afk.mjs`). The hand-written `memory`/`brain`
 * `bootstrap.mjs` launchers inline an equivalent of {@link pluginEnabledInConfig}
 * — keep the three implementations in lockstep.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Walk up from `start` for the first existing `start/.../rel` (bounded). */
export function findUp(start: string, rel: string): string | null {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function stripInlineComment(value: string): string {
  const hash = value.indexOf(" #");
  return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

/**
 * Read `<dottedKey>` from a constrained-subset `.red/config.yaml` (2-space
 * indent, scalar leaves) without a YAML dependency. Builds dotted keys from
 * indentation and returns the first matching scalar. Best-effort: malformed
 * lines are skipped, never thrown.
 */
export function flatConfigValue(text: string, dottedKey: string): string | undefined {
  const stack: Array<{ indent: number; key: string }> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const indent = line.length - line.trimStart().length;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const value = line.slice(colon + 1).trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });
    if (value) {
      const path = stack.map((s) => s.key).join(".");
      if (path === dottedKey) return stripInlineComment(value);
    }
  }
  return undefined;
}

/**
 * The strict opt-in predicate over the *text* of a `.red/config.yaml`: a plugin
 * is enabled only when `plugins.<name>.enabled` is explicitly the scalar `true`.
 * Anything else — absent block, absent key, `false`, any other value — is off.
 */
export function pluginEnabledInConfig(text: string, plugin: string): boolean {
  return flatConfigValue(text, `plugins.${plugin}.enabled`) === "true";
}

/**
 * The full gate: is `plugin` enabled for the project rooted at (or above) `cwd`?
 * Finds the nearest `.red/config.yaml` by walking up, then applies the strict
 * predicate. No `.red/config.yaml` anywhere → false (inert). Never creates or
 * writes anything.
 */
export function isPluginEnabled(cwd: string, plugin: string): boolean {
  const path = findUp(cwd, join(".red", "config.yaml"));
  if (!path) return false;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  return pluginEnabledInConfig(text, plugin);
}
