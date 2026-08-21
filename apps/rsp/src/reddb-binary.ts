/**
 * reddb-binary.ts — where the `red` engine binary is, resolved from a BUNDLE.
 *
 * The SDK locates its own binary at `<sdk package>/bin/red`, derived from the
 * SDK module's `import.meta.url`. That is correct while the SDK is a package on
 * disk and WRONG the moment esbuild inlines it: the compiled file's URL is the
 * bundle's, so `<package root>` becomes the bundle's parent directory and the
 * probe lands on `<repo>/bin/red`, a path that has never existed (#4196). The
 * bundled resident therefore could not open its store on any machine where
 * neither `REDDB_BIN` nor the warm cache was populated.
 *
 * The fix is to stop deriving the package from the compiled file and to LOOK the
 * package up at runtime instead, walking the `node_modules` trees above the
 * running module and the cwd. `createRequire(...).resolve()` cannot do that job
 * here: the SDK's `exports` map declares only `"."` with an `import` condition,
 * so a CJS resolver is refused (`ERR_PACKAGE_PATH_NOT_EXPORTED`) and `bin/red`
 * is not an exported subpath under any condition. The walk below is the same
 * lookup Node itself performs, run for a path the `exports` map hides.
 *
 * The order is explicit-before-inferred, and the test pins it:
 *
 *   1. `REDDB_BIN` — the canonical operator override. Returned verbatim, never
 *      probed: an override that points at nothing must surface the SDK's own
 *      "binary not found" error, not be silently replaced by a guess.
 *   2. The SDK package's `bin/red` — what the unbundled SDK would have found,
 *      located by package lookup rather than by compiled-file arithmetic.
 *   3. The red-skills warm cache, newest version first — where the launcher
 *      drops the binary for a bundle that ships without a `node_modules`.
 *   4. `red` on `PATH` — the last resort. The SDK refuses PATH outright because
 *      the wire coupling between SDK and engine is tight, and that refusal is
 *      right for a FIRST choice; as a fourth one the alternative is not a safer
 *      binary, it is no store at all. A provisioned machine has the engine on
 *      PATH, and rsp's contract is to fail open, so a version-mismatched engine
 *      degrades the command it fronts instead of killing every command.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Which step of the cascade produced the path — carried for diagnosis, never for logic. */
export type ReddbBinarySource = "env" | "sdk-package" | "warm-cache" | "path";

export interface ResolvedReddbBinary {
  path: string;
  source: ReddbBinarySource;
}

/** Injected environment. Every field defaults to this process, so a test can pose as another host. */
export interface ReddbBinaryLookup {
  env?: NodeJS.ProcessEnv;
  /** Directory of the running module — the bundle's own directory in a bundled host. */
  fromDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  home?: string;
  exists?: (path: string) => boolean;
  listDir?: (path: string) => string[];
}

const SDK_PACKAGE_SEGMENTS = ["@reddb-io", "sdk"] as const;
/** pnpm's hoist directory: the fallback lookup dir Node never walks to on its own. */
const PNPM_HOIST_SEGMENTS = [".pnpm", "node_modules"] as const;

export function reddbBinaryFileName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "red.exe" : "red";
}

/**
 * Resolve the engine binary, or `null` when no step of the cascade answers.
 *
 * `null` is a legal answer: the caller leaves `REDDB_BIN` unset and the SDK
 * raises its own actionable error, which names the override and the repair.
 */
export function resolveReddbBinary(lookup: ReddbBinaryLookup = {}): ResolvedReddbBinary | null {
  const env = lookup.env ?? process.env;
  const exists = lookup.exists ?? existsSync;
  const listDir = lookup.listDir ?? listDirSafe;
  const platform = lookup.platform ?? process.platform;
  const name = reddbBinaryFileName(platform);

  const override = env.REDDB_BIN;
  if (typeof override === "string" && override !== "") return { path: override, source: "env" };

  const fromDir = lookup.fromDir ?? moduleDir();
  const cwd = lookup.cwd ?? process.cwd();
  for (const candidate of sdkPackageBinaries(fromDir, cwd, name)) {
    if (exists(candidate)) return { path: candidate, source: "sdk-package" };
  }

  for (const candidate of warmCacheBinaries(env, lookup.home ?? homedir(), name, listDir)) {
    if (exists(candidate)) return { path: candidate, source: "warm-cache" };
  }

  for (const candidate of pathBinaries(env, name)) {
    if (exists(candidate)) return { path: candidate, source: "path" };
  }

  return null;
}

/**
 * Publish the resolved binary as `REDDB_BIN` so the SDK's own lookup finds it.
 *
 * A caller that already set the override keeps it: step 1 of the cascade returns
 * it unchanged, so the assignment is a no-op rather than a re-derivation.
 */
export function ensureReddbBinary(lookup: ReddbBinaryLookup = {}): ResolvedReddbBinary | null {
  const env = lookup.env ?? process.env;
  const resolved = resolveReddbBinary({ ...lookup, env });
  if (resolved) env.REDDB_BIN = resolved.path;
  return resolved;
}

/** `<node_modules>/@reddb-io/sdk/bin/red` for every `node_modules` above the two starting points. */
function* sdkPackageBinaries(fromDir: string, cwd: string, name: string): Generator<string> {
  const seen = new Set<string>();
  for (const start of [fromDir, cwd]) {
    for (const nodeModules of nodeModulesChain(start)) {
      for (const root of [nodeModules, join(nodeModules, ...PNPM_HOIST_SEGMENTS)]) {
        const candidate = join(root, ...SDK_PACKAGE_SEGMENTS, "bin", name);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        yield candidate;
      }
    }
  }
}

function* nodeModulesChain(start: string): Generator<string> {
  let dir = start;
  for (;;) {
    yield join(dir, "node_modules");
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/**
 * Cached engine binaries, newest version first.
 *
 * An unset `RED_SKILLS_CACHE_DIR` means the standard cache location, not "no
 * cache" — the same default cascade the launcher fetch uses.
 */
function* warmCacheBinaries(
  env: NodeJS.ProcessEnv,
  home: string,
  name: string,
  listDir: (path: string) => string[],
): Generator<string> {
  const cacheDir = env.RED_SKILLS_CACHE_DIR
    ?? (env.XDG_CACHE_HOME
      ? join(env.XDG_CACHE_HOME, "red-skills", "bundles")
      : join(home, ".cache", "red-skills", "bundles"));
  const root = join(cacheDir, "reddb");
  for (const version of listDir(root).sort().reverse()) yield join(root, version, name);
}

function* pathBinaries(env: NodeJS.ProcessEnv, name: string): Generator<string> {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir !== "") yield join(dir, name);
  }
}

function moduleDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function listDirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
