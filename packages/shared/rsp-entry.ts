/**
 * rsp-entry.ts — where the resident's own executable lives, resolved explicitly.
 *
 * The resident auto-spawn used to infer its target from `process.argv[1]`, so a
 * host that is not the rsp CLI (the dev bundle, redskilled-mcp, memory, brain)
 * re-executed *itself* with `warm-resident` — an argument only the rsp CLI
 * routes. rsp fails open by contract, so that spawn died in silence and the
 * surface quietly lost elision, handles and telemetry (#2736, same defect class
 * as #2677: never infer the executable from the caller's argv).
 *
 * This module resolves the rsp entry from named candidates instead, and when no
 * candidate exists it says so — {@link RspResidentEntryError}, a named
 * diagnostic on the degradation path — rather than spawning something that
 * ignores `warm-resident`.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The named diagnostic a host emits when no rsp entry can be resolved. */
export const RSP_ENTRY_UNRESOLVED = "rsp-resident-entry-unresolved";

/** Which candidate produced the entry — carried for diagnosis, never for logic. */
export type RspEntrySource =
  | "server-command"
  | "env-rsp-bin"
  | "caller-entry"
  | "caller-sibling-bundle"
  | "plugin-root-bundle"
  | "repo-bundle"
  | "workspace-entry"
  | "node-modules-entry"
  | "bundle-cache";

export interface ResolvedRspEntry {
  command: string;
  args: string[];
  source: RspEntrySource;
}

export interface UnresolvedRspEntry {
  diagnostic: typeof RSP_ENTRY_UNRESOLVED;
  /** Every path that was probed, in order — the message a human needs. */
  searched: string[];
  /** The caller's own entrypoint, named so the log shows the foreign host. */
  callerEntry?: string;
}

export type RspEntryResolution = ResolvedRspEntry | UnresolvedRspEntry;

export function isResolvedRspEntry(resolution: RspEntryResolution): resolution is ResolvedRspEntry {
  return "command" in resolution;
}

/** Injected environment. Every field defaults to this process, so tests can pose as a foreign host. */
export interface RspEntryLookup {
  /** Repo root of the resident being started — the workspace/bundle candidates hang off it. */
  rootDir?: string;
  /** The caller's own entrypoint (`process.argv[1]` by default). */
  callerEntry?: string;
  execPath?: string;
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
}

/** An explicit `serverCommand` always wins; the resolver is the fallback, not the override. */
export interface RspEntryOverride {
  serverCommand?: string;
  serverArgs?: string[];
}

/** Thrown by the spawn path so an unresolvable entry is loud in logs and still fails open. */
export class RspResidentEntryError extends Error {
  readonly code = RSP_ENTRY_UNRESOLVED;
  readonly searched: string[];
  readonly callerEntry?: string;

  constructor(unresolved: UnresolvedRspEntry) {
    super(
      `${RSP_ENTRY_UNRESOLVED}: no rsp entrypoint found for the resident auto-spawn` +
        `${unresolved.callerEntry ? ` (caller entry: ${unresolved.callerEntry})` : ""}` +
        `\nsearched:\n${unresolved.searched.map((path) => `  ${path}`).join("\n")}`,
    );
    this.name = "RspResidentEntryError";
    this.searched = unresolved.searched;
    this.callerEntry = unresolved.callerEntry;
  }
}

const RSP_BUNDLE = "rsp.bundle.min.mjs";
const VERSIONED_BUNDLE = /^([a-z0-9-]+)-(.+)\.bundle\.min\.mjs$/;
const RSP_VERSIONED_BUNDLE = /^rsp-(.+)\.bundle\.min\.mjs$/;
const PLUGIN_ROOT_VARS = [
  "RED_SKILLS_DEV_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "CODEX_PLUGIN_ROOT",
  "OPENCODE_PLUGIN_ROOT",
] as const;

/**
 * Resolve the command that understands `warm-resident` / `server`.
 *
 * Order is explicit-before-inferred: the caller's override, then `RSP_BIN`, then
 * the caller's entry *only when it is itself an rsp entry*, then the bundles
 * that ship beside a host (plugin root, repo `dist/`, workspace, bundle cache).
 */
export function resolveRspEntry(
  override: RspEntryOverride = {},
  lookup: RspEntryLookup = {},
): RspEntryResolution {
  if (override.serverCommand) {
    return { command: override.serverCommand, args: override.serverArgs ?? [], source: "server-command" };
  }
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const execPath = lookup.execPath ?? process.execPath;
  const execArgv = lookup.execArgv ?? process.execArgv;
  const callerEntry = lookup.callerEntry === undefined ? process.argv[1] : lookup.callerEntry;
  const node = (entry: string, source: RspEntrySource): ResolvedRspEntry =>
    ({ command: execPath, args: [...execArgv, entry], source });

  if (env.RSP_BIN) return { command: env.RSP_BIN, args: [], source: "env-rsp-bin" };

  if (callerEntry && isRspEntryPath(callerEntry)) return node(resolve(callerEntry), "caller-entry");

  const searched: string[] = [];
  for (const [path, source] of entryCandidates(callerEntry, lookup.rootDir, env, lookup.listDir ?? listDirSafe)) {
    searched.push(path);
    if (exists(path)) return node(path, source);
  }
  return { diagnostic: RSP_ENTRY_UNRESOLVED, searched, ...(callerEntry ? { callerEntry: resolve(callerEntry) } : {}) };
}

/** Resolve or throw — the shape the spawn path wants. */
export function requireRspEntry(override: RspEntryOverride = {}, lookup: RspEntryLookup = {}): ResolvedRspEntry {
  const resolution = resolveRspEntry(override, lookup);
  if (isResolvedRspEntry(resolution)) return resolution;
  throw new RspResidentEntryError(resolution);
}

/**
 * Does this path route `warm-resident` itself?
 *
 * True for the rsp bundle in any of its names, and for `cli.js` / `cli.ts`
 * inside an `rsp` package (`apps/rsp/src/cli.ts`, `@reddb-io/rsp/dist/cli.js`),
 * and for the packaged `bin/rsp*` shim that execs the bundle.
 */
export function isRspEntryPath(path: string): boolean {
  const name = basename(path);
  if (name === RSP_BUNDLE || RSP_VERSIONED_BUNDLE.test(name)) return true;
  if (name === "rsp" || name === "rsp.mjs" || name === "rsp.js") return true;
  if (name !== "cli.js" && name !== "cli.mjs" && name !== "cli.ts") return false;
  return hasRspPackageAncestor(resolve(path));
}

function hasRspPackageAncestor(entry: string): boolean {
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++) {
    if (basename(dir) === "rsp") return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

function* entryCandidates(
  callerEntry: string | undefined,
  rootDir: string | undefined,
  env: NodeJS.ProcessEnv,
  listDir: (path: string) => string[],
): Generator<[string, RspEntrySource]> {
  if (callerEntry) {
    // A host bundle and the rsp bundle are published side by side, both as
    // `dist/<plugin>.bundle.min.mjs` and as cache-keyed `<plugin>-<key>...`.
    const dir = dirname(resolve(callerEntry));
    yield [join(dir, RSP_BUNDLE), "caller-sibling-bundle"];
    const versioned = VERSIONED_BUNDLE.exec(basename(callerEntry));
    if (versioned) yield [join(dir, `rsp-${versioned[2]}.bundle.min.mjs`), "caller-sibling-bundle"];
    yield [join(dir, "..", "dist", RSP_BUNDLE), "caller-sibling-bundle"];
  }
  for (const variable of PLUGIN_ROOT_VARS) {
    const root = env[variable];
    if (!root) continue;
    yield [join(root, "dist", RSP_BUNDLE), "plugin-root-bundle"];
    yield [join(root, "..", "..", "dist", RSP_BUNDLE), "plugin-root-bundle"];
  }
  if (rootDir) {
    yield [join(rootDir, "dist", RSP_BUNDLE), "repo-bundle"];
    yield [join(rootDir, "apps", "rsp", "dist", "cli.js"), "workspace-entry"];
    yield [join(rootDir, "node_modules", "@reddb-io", "rsp", "dist", "cli.js"), "node-modules-entry"];
  }
  const cacheRoot = bundleCacheRoot(env);
  yield [join(cacheRoot, RSP_BUNDLE), "bundle-cache"];
  for (const name of cachedRspBundles(cacheRoot, listDir)) yield [join(cacheRoot, name), "bundle-cache"];
}

function bundleCacheRoot(env: NodeJS.ProcessEnv): string {
  if (env.RED_SKILLS_CACHE_DIR) return env.RED_SKILLS_CACHE_DIR;
  const xdg = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(xdg, "red-skills", "bundles");
}

/** Cache-keyed bundles, newest key first — `canary` sorts last, it is not a version. */
function cachedRspBundles(cacheRoot: string, listDir: (path: string) => string[]): string[] {
  return listDir(cacheRoot)
    .filter((name) => RSP_VERSIONED_BUNDLE.test(name))
    .sort((a, b) => compareBundleKeys(bundleKey(b), bundleKey(a)));
}

function bundleKey(name: string): string {
  return RSP_VERSIONED_BUNDLE.exec(name)?.[1] ?? "";
}

function compareBundleKeys(a: string, b: string): number {
  const parse = (key: string) => key.split(".").map((part) => Number.parseInt(part, 10));
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (Number.isNaN(x) || x === undefined) return Number.isNaN(y) || y === undefined ? a.localeCompare(b) : -1;
    if (Number.isNaN(y) || y === undefined) return 1;
    if (x !== y) return x - y;
  }
  return 0;
}

function listDirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
