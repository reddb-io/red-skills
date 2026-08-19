/**
 * workspace-root.ts — which tree the language servers index.
 *
 * The navigator is launched BY a host, from a launcher script that lives in
 * the plugin installation directory, and hosts differ on what the child's cwd
 * ends up being: a marketplace cache, `~/.claude/plugins/...`, or the emitted
 * opencode entry's baked `cwd: <plugins-root>`. Taking `process.cwd()` as the
 * workspace root therefore indexed the PLUGIN — every `goto_definition` in the
 * user's own repo answered "no definition found", and the failure looked like
 * a missing language server rather than a wrong root.
 *
 * The root follows the OPENED PROJECT: the operator's explicit override first,
 * then the project directory the host itself announces, and only then the cwd.
 * A candidate that is recognisably a plugin installation is refused at every
 * step, because a plugin tree is never the thing the user asked to navigate.
 * When the cwd is all that is left AND it is the plugin, the resolution says so
 * — a wrong root that announces itself is debuggable; a silent one is not.
 */
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/**
 * Env vars that carry the opened project, in precedence order. Mirrors
 * `resolveMcpProjectRoot` in apps/plugin-dev so one answer does not disagree with the
 * other about which repo the agent is working in.
 */
export const PROJECT_ROOT_ENV_VARS = [
  "CODE_NAV_ROOT",
  "RED_SKILLS_PROJECT_ROOT",
  "CLAUDE_PROJECT_DIR",
  "CODEX_PROJECT_DIR",
  "OPENCODE_PROJECT_DIR",
] as const;

/**
 * Env vars that carry the PLUGIN installation, never the project. Read only to
 * recognise a cwd that is the plugin — never as a root candidate.
 */
const PLUGIN_ROOT_ENV_VARS = ["CLAUDE_PLUGIN_ROOT", "CODEX_PLUGIN_ROOT"] as const;

/** Manifest files that mark a directory as an installed plugin. */
const PLUGIN_MANIFESTS = [
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
  join(".gemini-plugin", "plugin.json"),
];

/** Path fragments of the well-known host plugin caches. */
const PLUGIN_CACHE_FRAGMENTS = [
  join(".claude", "plugins"),
  join(".codex", "plugins"),
  join(".codex", ".tmp", "marketplaces"),
  join(".gemini", "plugins"),
];

function withinPluginCache(path: string): boolean {
  const padded = `${path}${sep}`;
  return PLUGIN_CACHE_FRAGMENTS.some((fragment) => padded.includes(`${sep}${fragment}${sep}`));
}

/**
 * True when `path` is a plugin installation rather than a project: it carries a
 * plugin manifest, sits inside a host's plugin cache, or IS the plugin root the
 * host announced.
 */
export function isPluginInstallDir(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const abs = resolve(path);
  for (const key of PLUGIN_ROOT_ENV_VARS) {
    const declared = (env[key] ?? "").trim();
    if (declared !== "" && resolve(declared) === abs) return true;
  }
  if (withinPluginCache(abs)) return true;
  return PLUGIN_MANIFESTS.some((manifest) => existsSync(join(abs, manifest)));
}

/** Where the workspace root came from, and whether it is trustworthy. */
export interface WorkspaceRootResolution {
  /** The absolute directory the language servers index. */
  root: string;
  /** The env var that supplied it, or `"cwd"` when nothing announced one. */
  source: (typeof PROJECT_ROOT_ENV_VARS)[number] | "cwd";
  /** Set when the only candidate left was a plugin installation. */
  warning?: string;
}

/**
 * Resolve the workspace root the language servers index.
 *
 * Precedence: an explicit project env var (first one set and usable), then the
 * cwd. A plugin installation directory is skipped wherever it appears — except
 * as the last resort, where returning the cwd at least keeps the server
 * answering, with a warning naming the env var that would fix it.
 */
export function resolveWorkspaceRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): WorkspaceRootResolution {
  for (const key of PROJECT_ROOT_ENV_VARS) {
    const declared = (env[key] ?? "").trim();
    if (declared === "") continue;
    const abs = resolve(declared);
    // CODE_NAV_ROOT is the operator's own word and is obeyed as written; the
    // host-announced vars are guessed on our behalf and get the plugin check.
    if (key === "CODE_NAV_ROOT" || !isPluginInstallDir(abs, env)) {
      return { root: abs, source: key };
    }
  }
  const fallback = resolve(cwd);
  if (isPluginInstallDir(fallback, env)) {
    return {
      root: fallback,
      source: "cwd",
      warning:
        `workspace root fell back to the plugin installation at ${fallback} — ` +
        `no project directory was announced. Set CODE_NAV_ROOT to the repository ` +
        `you want indexed.`,
    };
  }
  return { root: fallback, source: "cwd" };
}
