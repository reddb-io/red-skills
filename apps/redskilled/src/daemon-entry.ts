/**
 * daemon-entry — which file a spawn invokes to get a daemon, resolved by name.
 *
 * ADR 0130 rule 7 makes auto-spawn the only start path, which puts the whole
 * weight of "which code runs the daemon" on this module. The rule it enforces is
 * one sentence: **the spawn resolves the published bundle, and never
 * re-executes the calling process's own entry path.** This repository has fixed
 * that exact defect twice — the rsp resident inferring its target from
 * `process.argv[1]` (#2736) and the fleet launcher re-execing itself (#2677) —
 * and the failure it produces is the nasty kind: the launcher's own version
 * becomes the daemon's version, so a stale caller quietly mints a staler daemon
 * and the skew widens instead of clearing.
 *
 * Where rsp fails OPEN (a missing resident costs elision, never the command),
 * redskilled fails CLOSED (ADR 0130 rule 6): an unresolvable bundle is
 * {@link RedskilledDaemonEntryError}, naming every path it probed. There is
 * deliberately **no fallback to the caller's path** — the fallback is the bug,
 * not the safety net, because a daemon spawned from a foreign host's entry
 * either dies on an argument it does not route or serves the host's stale code.
 *
 * PURE apart from the injected existence and directory lookups.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The shipped bundle's file name — the artifact a release carries (issue #2842). */
export const REDSKILLED_BUNDLE_ASSET = "redskilled.bundle.min.mjs";

/** The named diagnostic a caller emits when no published bundle can be found. */
export const REDSKILLED_ENTRY_UNRESOLVED = "redskilled-daemon-entry-unresolved";

/** Env var that pins the daemon executable outright, ahead of every candidate. */
export const REDSKILLED_BIN_ENV = "REDSKILLED_BIN";

/** Which candidate produced the entry — carried for diagnosis, never for logic. */
export type RedskilledEntrySource =
  | "server-command"
  | "env-redskilled-bin"
  | "caller-entry"
  | "caller-sibling-bundle"
  | "plugin-root-bundle"
  | "repo-bundle"
  | "workspace-entry"
  | "node-modules-entry"
  | "bundle-cache";

export interface ResolvedRedskilledEntry {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: RedskilledEntrySource;
  /** The resolved daemon file, named separately from the argv it sits inside. */
  readonly entry?: string;
}

export interface UnresolvedRedskilledEntry {
  readonly diagnostic: typeof REDSKILLED_ENTRY_UNRESOLVED;
  /** Every path that was probed, in order — the message a human needs. */
  readonly searched: readonly string[];
  /** The caller's own entrypoint, named so the log shows the foreign host. */
  readonly callerEntry?: string;
}

export type RedskilledEntryResolution = ResolvedRedskilledEntry | UnresolvedRedskilledEntry;

export function isResolvedRedskilledEntry(
  resolution: RedskilledEntryResolution,
): resolution is ResolvedRedskilledEntry {
  return "command" in resolution;
}

/** Injected environment. Every field defaults to this process, so a test can pose as a foreign host. */
export interface RedskilledEntryLookup {
  /** Repo root the workspace and `dist/` candidates hang off. */
  readonly rootDir?: string;
  /** The caller's own entrypoint (`process.argv[1]` by default). */
  readonly callerEntry?: string;
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  readonly listDir?: (path: string) => readonly string[];
}

/** An explicit command always wins; the resolver is the fallback, not the override. */
export interface RedskilledEntryOverride {
  readonly serverCommand?: string;
  readonly serverArgs?: readonly string[];
}

/**
 * Thrown when no published bundle exists — loudly, and naming why.
 *
 * The message carries the caller's entry and every probed path, because the two
 * questions an operator has are "which host asked?" and "where should the
 * artifact have been?", and a spawn that answered neither is how #2842 stayed
 * invisible for the whole of the app's life.
 */
export class RedskilledDaemonEntryError extends Error {
  readonly code = REDSKILLED_ENTRY_UNRESOLVED;
  readonly searched: readonly string[];
  readonly callerEntry?: string;

  constructor(unresolved: UnresolvedRedskilledEntry) {
    super(
      `${REDSKILLED_ENTRY_UNRESOLVED}: no published ${REDSKILLED_BUNDLE_ASSET} found to spawn the redskilled daemon from` +
        `${unresolved.callerEntry ? ` (caller entry: ${unresolved.callerEntry}, which is NOT used as a fallback)` : ""}` +
        `\nsearched:\n${unresolved.searched.map((path) => `  ${path}`).join("\n")}`,
    );
    this.name = "RedskilledDaemonEntryError";
    this.searched = unresolved.searched;
    if (unresolved.callerEntry != null) this.callerEntry = unresolved.callerEntry;
  }
}

/**
 * The session a `serve` argv points at — every path the daemon may not derive.
 *
 * Structural on purpose: {@link RedskilledPaths} satisfies it, and typing the
 * parameter this way keeps the argv builder free of the module that resolves a
 * session, so both the client spawn and the supervisor unit can render the same
 * flags from the same one function.
 */
export interface RedskilledServeTarget {
  readonly socketPath: string;
  readonly leasePath: string;
  readonly eventLanePath: string;
  readonly sessionKeyHash: string;
  readonly machineIdHash: string;
  /** The machine-wide claim the daemon must hold; given, never derived (rule 3). */
  readonly machineClaimPath: string;
}

/**
 * The `serve` argv for one session — ONE builder, for every way a daemon starts.
 *
 * The supervisor unit, `provision` and a self-replacement all hand the daemon the
 * same flags. A second copy of this list is how a flag added to one start path
 * goes missing from the others.
 *
 * **There is no idle-exit flag to add** (ADR 0150 §4): the daemon is always on,
 * so a serve argv carries nothing that could make it leave by boredom.
 */
export function redskilledServeArgv(
  target: RedskilledServeTarget,
  options: { readonly daemonVersion?: string } = {},
): string[] {
  const argv = [
    "serve",
    "--socket",
    target.socketPath,
    "--lease",
    target.leasePath,
    "--events",
    target.eventLanePath,
    "--session-key-hash",
    target.sessionKeyHash,
    "--machine-id-hash",
    target.machineIdHash,
    "--machine-claim",
    target.machineClaimPath,
  ];
  if (options.daemonVersion != null) argv.push("--daemon-version", options.daemonVersion);
  return argv;
}

/** Where cache-keyed bundles land, so every resolver probes one directory. */
export function redskilledBundleCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return bundleCacheRoot(env);
}

const VERSIONED_BUNDLE = /^([a-z0-9-]+)-(.+)\.bundle\.min\.mjs$/;
// `(?!mcp[.-])` bars the one sibling that wears the daemon's name plus a
// surface suffix rather than a version: `redskilled-mcp[...].bundle.min.mjs`.
// Without it the MCP host recognized ITSELF as a daemon entry, spawned its own
// bundle as the daemon, and the child exited 2 (#3652).
const REDSKILLED_VERSIONED_BUNDLE = /^redskilled-(?!mcp[.-])(.+)\.bundle\.min\.mjs$/;
const PLUGIN_ROOT_VARS = [
  "RED_SKILLS_DEV_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "CODEX_PLUGIN_ROOT",
  "OPENCODE_PLUGIN_ROOT",
] as const;

/**
 * Resolve the file that routes `serve`.
 *
 * Order is explicit-before-inferred: the caller's override, then
 * `REDSKILLED_BIN`, then the caller's entry *only when it is itself a redskilled
 * entry*, then the bundles that ship beside a host (plugin root, repo `dist/`,
 * workspace, installed package, bundle cache). A caller entry that is some other
 * app's bundle is never a candidate — it is only reported, so the diagnostic can
 * name the foreign host that asked.
 */
export function resolveRedskilledEntry(
  override: RedskilledEntryOverride = {},
  lookup: RedskilledEntryLookup = {},
): RedskilledEntryResolution {
  if (override.serverCommand) {
    return { command: override.serverCommand, args: override.serverArgs ?? [], source: "server-command" };
  }
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const execPath = lookup.execPath ?? process.execPath;
  const execArgv = lookup.execArgv ?? [];
  const callerEntry = lookup.callerEntry === undefined ? process.argv[1] : lookup.callerEntry;
  const node = (entry: string, source: RedskilledEntrySource): ResolvedRedskilledEntry => ({
    command: execPath,
    args: [...execArgv, entry],
    source,
    entry,
  });

  const pinned = env[REDSKILLED_BIN_ENV];
  if (pinned) return { command: pinned, args: [], source: "env-redskilled-bin", entry: pinned };

  if (callerEntry && isRedskilledEntryPath(callerEntry)) return node(resolve(callerEntry), "caller-entry");

  const searched: string[] = [];
  for (const [path, source] of entryCandidates(callerEntry, lookup.rootDir, env, lookup.listDir ?? listDirSafe)) {
    searched.push(path);
    if (exists(path)) return node(path, source);
  }
  return {
    diagnostic: REDSKILLED_ENTRY_UNRESOLVED,
    searched,
    ...(callerEntry ? { callerEntry: resolve(callerEntry) } : {}),
  };
}

/** Resolve or throw — the shape the fail-closed spawn path wants. */
export function requireRedskilledEntry(
  override: RedskilledEntryOverride = {},
  lookup: RedskilledEntryLookup = {},
): ResolvedRedskilledEntry {
  const resolution = resolveRedskilledEntry(override, lookup);
  if (isResolvedRedskilledEntry(resolution)) return resolution;
  throw new RedskilledDaemonEntryError(resolution);
}

/**
 * Does this path route `serve` itself?
 *
 * True for the redskilled bundle in any of its names, for the packaged
 * `red-skills-redskilled` shim that execs it, and for `cli.js` / `cli.ts` inside
 * a `redskilled` package (`apps/redskilled/src/cli.ts`,
 * `@reddb-io/redskilled/dist/cli.js`). Every other file — including another
 * app's bundle that merely inlined this module — is not an entry.
 */
export function isRedskilledEntryPath(path: string): boolean {
  const name = basename(path);
  if (name === REDSKILLED_BUNDLE_ASSET || REDSKILLED_VERSIONED_BUNDLE.test(name)) return true;
  if (name === "red-skills-redskilled" || name === "red-skills-redskilled.mjs") return true;
  if (name !== "cli.js" && name !== "cli.mjs" && name !== "cli.ts") return false;
  return hasRedskilledPackageAncestor(resolve(path));
}

function hasRedskilledPackageAncestor(entry: string): boolean {
  let dir = dirname(entry);
  for (let i = 0; i < 4; i++) {
    if (basename(dir) === "redskilled") return true;
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
  listDir: (path: string) => readonly string[],
): Generator<[string, RedskilledEntrySource]> {
  if (callerEntry) {
    // A host bundle and the redskilled bundle are published side by side, both
    // as `dist/<app>.bundle.min.mjs` and as cache-keyed `<app>-<key>...`.
    const dir = dirname(resolve(callerEntry));
    yield [join(dir, REDSKILLED_BUNDLE_ASSET), "caller-sibling-bundle"];
    const versioned = VERSIONED_BUNDLE.exec(basename(callerEntry));
    // A caller named `redskilled-mcp[...]` backtracks to suffix `mcp[...]`;
    // yielding that sibling would be the caller spawning itself (#3652).
    if (versioned && !/^mcp([.-]|$)/.test(versioned[2]!)) {
      yield [join(dir, `redskilled-${versioned[2]}.bundle.min.mjs`), "caller-sibling-bundle"];
    }
    yield [join(dir, "..", "dist", REDSKILLED_BUNDLE_ASSET), "caller-sibling-bundle"];
  }
  for (const variable of PLUGIN_ROOT_VARS) {
    const root = env[variable];
    if (!root) continue;
    yield [join(root, "dist", REDSKILLED_BUNDLE_ASSET), "plugin-root-bundle"];
    yield [join(root, "..", "..", "dist", REDSKILLED_BUNDLE_ASSET), "plugin-root-bundle"];
  }
  if (rootDir) {
    yield [join(rootDir, "dist", REDSKILLED_BUNDLE_ASSET), "repo-bundle"];
    yield [join(rootDir, "apps", "redskilled", "dist", "cli.js"), "workspace-entry"];
    yield [join(rootDir, "node_modules", "@reddb-io", "redskilled", "dist", "cli.js"), "node-modules-entry"];
  }
  const cacheRoot = bundleCacheRoot(env);
  yield [join(cacheRoot, REDSKILLED_BUNDLE_ASSET), "bundle-cache"];
  for (const name of cachedRedskilledBundles(cacheRoot, listDir)) yield [join(cacheRoot, name), "bundle-cache"];
}

function bundleCacheRoot(env: NodeJS.ProcessEnv): string {
  if (env.RED_SKILLS_CACHE_DIR) return env.RED_SKILLS_CACHE_DIR;
  const xdg = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(xdg, "red-skills", "bundles");
}

/** Cache-keyed bundles, newest key first — `canary` sorts last, it is not a version. */
function cachedRedskilledBundles(cacheRoot: string, listDir: (path: string) => readonly string[]): string[] {
  return listDir(cacheRoot)
    .filter((name) => REDSKILLED_VERSIONED_BUNDLE.test(name))
    .sort((a, b) => compareBundleKeys(bundleKey(b), bundleKey(a)));
}

function bundleKey(name: string): string {
  return REDSKILLED_VERSIONED_BUNDLE.exec(name)?.[1] ?? "";
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

function listDirSafe(path: string): readonly string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
