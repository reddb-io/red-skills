/**
 * mcp-passthrough.ts — pure planner for the `.mcp.json` → opencode
 * `mcp>` block mapping (ADR 0079).
 *
 * Reads `plugins/<plugin>/.mcp.json` and returns a list of opencode-
 * shaped entries the Slice 1 emit step merges into the per-plugin
 * `opencode.json`. Each Claude/Codex `mcpServers: { name: { command,
 * args, env } }` entry becomes an opencode
 * `mcp: { name: { type: "local", command, environment, cwd? } }`
 * entry.
 *
 * The plugin root is resolved at build time, not at runtime: the
 * source `sh -c '... ${CODEX_PLUGIN_ROOT:-...} ...'` chain searches
 * four candidate paths; the Slice 3 generator picks the first
 * existing one and bakes the absolute path into the emitted
 * command array. A missing script is a build warning, not a silent
 * failure.
 *
 * No filesystem IO happens here beyond the `.mcp.json` read. The
 * planner is pure; the emit step is the thin shell that writes.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** An opencode-shaped MCP entry. */
export interface McpEntry {
  type: "local";
  /** The command and its args as a single array (no shell wrapper). */
  command: string[];
  /** Env vars to set when spawning the server. */
  environment?: Record<string, string>;
  /** Optional working directory. Omitted on release-asset installs
   *  (Slice 5) where the source path is not the user's install
   *  path. */
  cwd?: string;
  enabled?: boolean;
}

/** A planned `mcp:` entry. The emit step merges it into the Slice 1
 *  `opencode.json`'s `mcp:` block. */
export interface McpPlan {
  /** The MCP server name (e.g. `red-memory`, `navigator`). */
  name: string;
  /** The opencode-shaped entry. */
  entry: McpEntry;
  /** Warnings: source script paths that did not exist when the
   *  build ran. The MCP is still emitted with the best-effort
   *  resolved path; the warning surfaces to the user at
   *  `generate` time. */
  warnings: string[];
}

interface RawMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface RawMcpJson {
  mcpServers?: Record<string, RawMcpServer>;
}

/** Read a single plugin's `.mcp.json`. Returns `null` when the file
 *  is absent (e.g. a plugin that does not ship an MCP). */
export function readMcpJson(pluginsRoot: string, plugin: string): RawMcpJson | null {
  const path = join(pluginsRoot, plugin, ".mcp.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RawMcpJson;
  } catch (err) {
    return null;
  }
}

/** Search the same four candidate paths the source `sh -c` chain
 *  uses, returning the first that contains the requested script.
 *  The path is absolute; the caller bakes it into the emitted
 *  command array.
 *
 *  Per the source (plugins/memory/.mcp.json), the search order is:
 *    1. $CODEX_PLUGIN_ROOT (the dev checkout)
 *    2. $PWD/plugins/<plugin>
 *    3. $HOME/.codex/.tmp/marketplaces/red-skills/plugins/<plugin>
 *    4. $HOME/.codex/plugins/cache/red-skills/<plugin>/*
 *  The Slice 3 search order keeps (1) and (2) as the first
 *  candidates (a dev checkout or a `pnpm install` repo), and the
 *  well-known Codex cache paths as fallbacks. The $CODEX_PLUGIN_ROOT
 *  env var is **not** consulted — the generator resolves paths
 *  from the local filesystem, not from the opencode process env. */
export function resolveScriptPath(
  pluginsRoot: string,
  plugin: string,
  /** Either `scripts/bootstrap.mjs` or `hooks/<name>.sh`. */
  relativeScriptPath: string,
): { path: string | null; candidate: string | null } {
  const candidates = [
    join(pluginsRoot, plugin, relativeScriptPath),
    join(pluginsRoot, plugin, "hooks", relativeScriptPath.split("/").pop() ?? ""),
    // The tree that owns `plugins/` (a checkout or the installer's
    // materialised package set): `$root/dist/rsp.bundle.min.mjs` in the
    // source chain names a repo-root bundle, not a plugin-root one.
    join(pluginsRoot, "..", relativeScriptPath),
    join(pluginsRoot, "..", "..", ".codex", ".tmp", "marketplaces", "red-skills", "plugins", plugin, relativeScriptPath),
    join(homedir(), ".codex", "plugins", "cache", "red-skills", plugin, relativeScriptPath),
  ];
  // The .codex cache path is `<cache>/<plugin>/*/<relativeScriptPath>`;
  // walk one level deep into the cache dir and pick the first hit.
  for (const c of candidates.slice(0, 3)) {
    if (existsSync(c)) return { path: c, candidate: c };
  }
  // Codex cache: glob one level (best-effort; not as robust as the
  // source's shell glob, but the dev checkout path is the common
  // case and the build-time check is a warning, not a fail-closed).
  for (const c of candidates.slice(3)) {
    if (existsSync(c)) return { path: c, candidate: c };
  }
  return { path: null, candidate: candidates[0] ?? null };
}

/** Resolve explicit `$HOME/...` launchers from a source shell fallback. */
export function resolveHomeScriptPath(
  body: string,
  home: string = homedir(),
): string | null {
  for (const match of body.matchAll(/\$HOME\/([\w./-]+)/g)) {
    const candidate = join(home, match[1]!);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next explicit home-relative candidate.
    }
  }
  return null;
}

/** Rewrite a single Claude/Codex `mcpServers` entry to opencode's
 *  `mcp:` shape. The rewrite has three branches:
 *    - `command: "sh"` + `args: ["-c", "<body>"]` (the common
 *      shape for plugins that need a plugin root): the body is
 *      parsed for the `${CODEX_PLUGIN_ROOT:-...}` chain, the
 *      resolved script path replaces the chain, and the `sh -c`
 *      wrapper is removed. The command array is then
 *      `["<interpreter>", "<abs-script-path>", ...]`.
 *    - `command: "npx"` + `args: ["-y", "<pkg>", ...]`
 *      (`red-ui`): passed through verbatim.
 *    - Anything else: passed through as
 *      `[<command>, ...args]`.
 */
export function rewriteServer(
  pluginsRoot: string,
  plugin: string,
  name: string,
  raw: RawMcpServer,
): { entry: McpEntry; warnings: string[] } {
  const warnings: string[] = [];
  const command = raw.command ?? "sh";
  const args = raw.args ?? [];
  const environment = raw.env;

  if (command === "sh" && args[0] === "-c" && typeof args[1] === "string") {
    return rewriteShC(pluginsRoot, plugin, name, args[1], environment);
  }

  // passthrough: command + args become a single array
  const entry: McpEntry = {
    type: "local",
    command: [command, ...args],
    enabled: true,
  };
  if (environment) entry.environment = environment;
  return { entry, warnings };
}

/** Rewrite a `sh -c '<body>'` invocation. The body may:
 *  - reference `${CODEX_PLUGIN_ROOT}` (or its `:-` fallback chain)
 *    followed by a script path under the plugin root;
 *  - reference `${CODEX_PLUGIN_ROOT}/hooks/<name>.sh` for the
 *    dev plugin's `code-nav-mcp.sh`;
 *  - exec `node <bootstrap.mjs> mcp` for memory and brain.
 *
 *  The rewrite extracts the first `${CODEX_PLUGIN_ROOT}/<relpath>`
 *  reference, resolves `<relpath>` to an absolute path via
 *  {@link resolveScriptPath}, and emits a
 *  `[<interpreter>, <abs-script-path>, ...]` command array.
 */
function rewriteShC(
  pluginsRoot: string,
  plugin: string,
  name: string,
  body: string,
  environment: Record<string, string> | undefined,
): { entry: McpEntry; warnings: string[] } {
  const warnings: string[] = [];
  // Extract the first `<relpath>` that the body references via
  // a path following a `$root/` or `$root` reference. The source
  // body uses forms like:
  //   `... "${CODEX_PLUGIN_ROOT}/hooks/red-fetch.mjs" ...`
  //   `... "${CODEX_PLUGIN_ROOT}/skills/misc/branch-lock/..." ...`
  //   `... "$root/scripts/bootstrap.mjs" mcp`
  //   `... "$root/hooks/code-nav-mcp.sh" ...`
  // We pick the first one whose resolved path exists.
  const patterns = [
    /\$\{?CODEX_PLUGIN_ROOT\}?\/(?:\$\{?CLAUDE_PLUGIN_ROOT\}?\/)?([\w./-]+)/,
    /\$\{?CLAUDE_PLUGIN_ROOT\}?\/(?:\$\{?CODEX_PLUGIN_ROOT\}?\/)?([\w./-]+)/,
    /\$root\/([\w./-]+)/g,
  ];
  const candidates: string[] = [];
  for (const p of patterns) {
    if (p.flags && p.flags.includes("g")) {
      const m = body.matchAll(p as RegExp);
      for (const match of m) candidates.push(match[1]!);
    } else {
      const m = body.match(p as RegExp);
      if (m && m[1]) candidates.push(m[1]);
    }
  }

  // The tree being generated FROM wins. The explicit `$HOME/...` launchers
  // in the source chain are fallbacks for hosts that never materialised a
  // tree; consulting them first baked a Codex marketplace cache path into
  // every OpenCode install that happened to have one, and the MCP died the
  // day that cache was cleaned.
  let resolvedPath: string | null = null;
  for (const rel of candidates) {
    const { path } = resolveScriptPath(pluginsRoot, plugin, rel);
    if (path) {
      resolvedPath = path;
      break;
    }
  }
  if (!resolvedPath) resolvedPath = resolveHomeScriptPath(body);

  if (!resolvedPath) {
    warnings.push(
      `${name}: could not resolve any of the script paths referenced by the source hooks (${candidates.slice(0, 3).join(", ")}) — the plugin checkout or a Codex cache must exist for this MCP to start`,
    );
    // Fall back: emit the source `sh -c` as a wrapper so the MCP
    // still attempts to start; the user sees the source's env-var
    // chain (which will fail in opencode) instead of a missing
    // entry. The build is warn-and-continue, not fail-closed.
    const entry: McpEntry = {
      type: "local",
      command: ["sh", "-c", body],
      enabled: true,
    };
    if (environment) entry.environment = environment;
    return { entry, warnings };
  }

  // Determine the interpreter from the body. The source body
  // either calls `node <script>` (memory/brain bootstrap) or
  // `bash <script>` (dev branch-lock). The emitted command
  // array is `[<interpreter>, <abs-script-path>, ...remaining
  // positional args]`. We pick the interpreter from the
  // resolved path's extension (`.mjs` → `node`, `.sh` → `bash`).
  const interpreter = resolvedPath.endsWith(".mjs")
    ? "node"
    : resolvedPath.endsWith(".sh")
      ? "bash"
      : "sh";

  // Preserve the trailing args the source body used (e.g. `mcp`
  // for the bootstrap, `< $tmp` style stdin redirects are not
  // expressible in the opencode command array — the bootstrap
  // reads its own stdin if needed).
  const trailing = body.match(/mcp(?=['"\s;|&]|$)/) ? ["mcp"] : [];

  const entry: McpEntry = {
    type: "local",
    command: [interpreter, resolvedPath, ...trailing],
    cwd: pluginsRoot,
    enabled: true,
  };
  if (environment) entry.environment = environment;
  return { entry, warnings };
}

/** Plan all MCP entries for a single plugin. Returns an empty
 *  list when the plugin does not ship a `.mcp.json`. */
export function planPluginMcp(pluginsRoot: string, plugin: string): McpPlan[] {
  const raw = readMcpJson(pluginsRoot, plugin);
  if (!raw?.mcpServers) return [];
  const out: McpPlan[] = [];
  for (const [name, server] of Object.entries(raw.mcpServers)) {
    const { entry, warnings } = rewriteServer(pluginsRoot, plugin, name, server);
    out.push({ name, entry, warnings });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
