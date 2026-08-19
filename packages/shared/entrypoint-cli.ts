#!/usr/bin/env node
/**
 * entrypoint-cli.ts — the single committed, dependency-free entrypoint for every
 * per-plugin bundle (ADR 0039), now carrying ONE role, selected by the
 * `__ENTRYPOINT_ROLE__` build define:
 *
 *   - `fetch`   → built to `plugins/dev/hooks/red-fetch.mjs` (the SessionStart
 *                 cache pre-warmer). Best-effort: NEVER blocks; populates the
 *                 version-keyed cache and exits 0 on any failure.
 *
 * **The `run:<plugin>` role is gone with the binary it launched.** It resolved a
 * plugin bundle and exec'd it with the whole argv — the path `afk.mjs` took to
 * reach `red-skills-dev`'s 36 commands. ADR 0147 rule 1 makes `redskilled` the
 * only shipped binary of the execution chain, so a launcher whose whole job was
 * to start a second one has nothing left to start: a workflow verb is an `rs_dev`
 * tool, and a prompt-cadence read is the daemon's own argv.
 *
 * Fetch is also reachable explicitly as a subcommand:
 *   node <entrypoint> fetch <plugin> <version> [--repo owner/name] [--cache-dir DIR]
 * and the no-subcommand form is the legacy positional
 * `red-fetch.mjs <plugin> <version>` invocation.
 *
 * Resolution logic is the pure {@link ensureBundle} in bundle-fetch.ts; this file
 * wires it to node built-ins plus an `npm install` materialiser that resolves the
 * `@reddb-io/red-skills@<pin>` package (ADR 0091 npm transport). There is no
 * GitHub-release download and no client-side signature verification — integrity
 * is npm's tarball shasum. See ADR 0091 / 0084 / 0039 / 0038.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  BundleFetchError,
  type BundleIO,
  NPM_PACKAGE,
  ensureBundle,
  isCacheableVersion,
  resolveBundle,
} from "./bundle-fetch.js";
import { type ReleaseChannel, resolveChannel } from "./channel.js";
import { findUp, flatConfigValue, isPluginEnabled } from "./plugin-gate.js";
import { backgroundSelfUpdateWithRetry, type SelfUpdateIO } from "./self-update.js";

const DEFAULT_REPO = "reddb-io/red-skills";

/** esbuild `--define`s this per output; absent under tsx/test → empty. */
declare const __ENTRYPOINT_ROLE__: string;
function buildRole(): string {
  try {
    return typeof __ENTRYPOINT_ROLE__ === "string" ? __ENTRYPOINT_ROLE__ : "";
  } catch {
    return "";
  }
}

function cacheRoot(override?: string): string {
  if (override) return override;
  if (process.env.RED_SKILLS_CACHE_DIR) return process.env.RED_SKILLS_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "red-skills", "bundles");
  }
  return join(homedir(), ".cache", "red-skills", "bundles");
}

/**
 * Where red-dev keeps RedSkills on this machine: `~/.red/skills`, inside the
 * `.red` namespace with the rest of its state. Read-only from here — the
 * exact-version bundle under `versions/v<x>` is preferred when it exists, and
 * nothing is ever written into it (materialisation goes to the cache).
 */
function installRoot(): string {
  return process.env.RED_SKILLS_INSTALL_ROOT || join(homedir(), ".red", "skills");
}

const realIO: BundleIO = {
  async materialize(spec, stagingDir) {
    await mkdir(stagingDir, { recursive: true });
    // `npm install <spec> --prefix <staging>` resolves the pinned package via
    // npm's own cache (cache-first, shasum-verified) and lands it under
    // <staging>/node_modules/. --no-save keeps the staging dir free of a root
    // package.json; --ignore-scripts because our packages have no
    // postinstall (ADR 0091) and we never want to run arbitrary lifecycle code.
    const res = spawnSync(
      "npm",
      [
        "install",
        spec,
        "--prefix",
        stagingDir,
        "--no-save",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--loglevel=error",
      ],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`npm install ${spec} -> ${res.status}: ${(res.stderr || "").trim()}`);
    }
    const versionSeparator = spec.lastIndexOf("@");
    const packageName = spec.slice(0, versionSeparator);
    return join(stagingDir, "node_modules", ...packageName.split("/"));
  },
  async readFile(path) {
    return new Uint8Array(await readFile(path));
  },
  async writeFile(path, bytes) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },
  async exists(path) {
    return existsSync(path);
  },
  sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
  },
  async fetchText(url) {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return await res.text();
  },
  async rename(from, to) {
    await rename(from, to);
  },
};

/** realIO + an atomic rename for the self-update pointer swap (ADR 0084). */
const realSelfUpdateIO: SelfUpdateIO = {
  ...realIO,
  async readdir(path: string) {
    return await readdir(path);
  },
  async rename(from, to) {
    await rename(from, to);
  },
};

async function logLine(cacheDir: string, msg: string): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true });
    await appendFile(join(cacheDir, "red-fetch.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* logging must never throw */
  }
  process.stderr.write(`entrypoint: ${msg}\n`);
}

// ── Pure routing (unit-tested) ───────────────────────────────────────────────

export interface FetchPlan {
  mode: "fetch";
  plugin?: string;
  version?: string;
  repo: string;
  cacheDir?: string;
  help: boolean;
}
/** The only plan there is; the type survives as the routing contract's name. */
export type EntrypointPlan = FetchPlan;

function parseFetchArgs(argv: readonly string[]): FetchPlan {
  const out: FetchPlan = { mode: "fetch", repo: DEFAULT_REPO, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--repo") out.repo = argv[++i] ?? out.repo;
    else if (a === "--cache-dir") out.cacheDir = argv[++i];
    else if (!a.startsWith("-")) positional.push(a);
  }
  out.plugin = positional[0];
  out.version = positional[1];
  return out;
}

/**
 * Route argv into a fetch plan.
 *
 * The `role` parameter survives the deletion of the `run:<plugin>` role because
 * the build define still names the role the binary was built with, and a build
 * that names anything else is a stale artifact rather than a second mode: every
 * argv shape lands in fetch. The explicit `fetch` subcommand still wins, and the
 * no-subcommand form is the legacy positional fetch (`red-fetch.mjs dev 1.2.3`).
 */
export function parseEntrypoint(argv: readonly string[], _role: string): EntrypointPlan {
  if (argv[0] === "fetch") return parseFetchArgs(argv.slice(1));
  return parseFetchArgs(argv);
}

// ── Release-channel resolution (ADR 0058) ────────────────────────────────────

/**
 * The configured channel string from `.red/config.yaml`: the namespaced
 * `plugins.dev.afk.release.channel` (ADR 0042) with the legacy top-level
 * `afk.release.channel` as a fallback. Returns undefined when neither is set.
 */
export function configuredChannelValue(text: string): string | undefined {
  return (
    flatConfigValue(text, "plugins.dev.afk.release.channel") ??
    flatConfigValue(text, "afk.release.channel")
  );
}

/**
 * Resolve the launcher's active channel: `RED_SKILLS_CHANNEL` env wins, then the
 * configured value, then the safe `stable` default (today's behaviour).
 */
export function resolveLauncherChannel(
  env: Record<string, string | undefined>,
  configText: string | undefined,
): ReleaseChannel {
  return resolveChannel({ env, configValue: configText ? configuredChannelValue(configText) : undefined });
}

/** Walk up from `process.cwd()` for `.red/config.yaml` and read it (best-effort). */
function readProjectConfig(): string | undefined {
  const path = findUp(process.cwd(), join(".red", "config.yaml"));
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// ── Plugin gate (ADR 0067) ───────────────────────────────────────────────────

/**
 * The config flag a fetch for `plugin` gates on. `code-nav` ships under the dev
 * plugin's umbrella (dev's SessionStart hook warms it, there is no separate
 * `plugins.code-nav` block), so it gates on `dev` — not a `code-nav` flag that
 * would never be set.
 */
export function gatePluginName(plugin: string): string {
  return plugin === "code-nav" ? "dev" : plugin;
}

// ── Fetch mode (IO) ──────────────────────────────────────────────────────────

const FETCH_USAGE = `entrypoint (fetch) — resolve a plugin's built bundle from the ${NPM_PACKAGE} npm package into a local cache.

Usage:
  node <entrypoint> fetch <plugin> <version> [--repo owner/name] [--cache-dir DIR]
  node red-fetch.mjs       <plugin> <version> [--repo owner/name] [--cache-dir DIR]

Arguments:
  <plugin>     plugin name (e.g. dev, memory)
  <version>    plugin version without the leading v (e.g. 1.140.0)

Options:
  --repo       GitHub repo publishing the release (default: ${DEFAULT_REPO})
  --cache-dir  override the bundle cache dir
  -h, --help   show this help

Best-effort: never blocks session start. On any failure it logs to
<cache-dir>/red-fetch.log and exits 0.`;

async function fetchMode(plan: FetchPlan): Promise<never> {
  const cacheDir = cacheRoot(plan.cacheDir);
  if (plan.help || !plan.plugin || !plan.version) {
    process.stdout.write(`${FETCH_USAGE}\n`);
    if (!plan.help && (!plan.plugin || !plan.version)) {
      process.stdout.write("\nentrypoint: missing <plugin> and/or <version>; nothing to do.\n");
    }
    process.exit(0);
  }
  const { plugin, version } = plan;
  // Per-directory gate (ADR 0067): never warm the cache for a plugin that the
  // current directory has not opted into. Fetch is already best-effort/silent,
  // so a gated-off fetch is simply a no-op exit 0. (code-nav gates on dev.)
  if (!isPluginEnabled(process.cwd(), gatePluginName(plugin))) {
    process.exit(0);
  }
  const channel = resolveLauncherChannel(process.env, readProjectConfig());
  // A version that cannot key a cache entry has no expected path to name, and
  // asking for one now would throw before the fetch reported why (#3153).
  const expected =
    isCacheableVersion(version) || channel === "canary"
      ? resolveBundle({ plugin, version, cacheDir, channel })
      : `${cacheDir}/${plugin}-<version>.bundle.min.mjs`;
  try {
    const path = await ensureBundle(realIO, {
      plugin,
      version,
      repo: plan.repo,
      cacheDir,
      installRoot: installRoot(),
      channel,
    });
    process.stdout.write(`entrypoint: bundle ready at ${path} (${channel})\n`);
  } catch (err) {
    const kind = err instanceof BundleFetchError ? err.kind : "unknown";
    const msg = err instanceof Error ? err.message : String(err);
    await logLine(cacheDir, `${kind}: ${msg} (fetch plugin=${plugin} version=${version} channel=${channel})`);
    process.stdout.write(
      `entrypoint: could not fetch ${plugin}@${version} (${kind}); ` +
        `expected cache path ${expected}. Continuing — fetch is best-effort.\n`,
    );
  }
  // In-range self-update (ADR 0084): after the pinned cache is warm, kick a
  // DETACHED background check for a newer in-range bundle. Detached + unref'd so
  // session start never blocks on it, and it runs out-of-band from any render.
  spawnBackgroundSelfUpdate(plugin, version, plan.repo, plan.cacheDir);
  // Always succeed: a SessionStart hook must not block on a failed fetch.
  process.exit(0);
}

// ── In-range self-update (ADR 0084) ──────────────────────────────────────────

/** The reserved subcommand the detached background self-update process runs. */
const SELF_UPDATE_SUBCOMMAND = "__self-update";

/**
 * Fire-and-forget the background self-update as a detached child, so it survives
 * this process exiting and never delays the SessionStart hook. Only meaningful
 * on the `stable` channel (canary self-refreshes via checksum), so it is skipped
 * elsewhere. Best-effort: a spawn failure is swallowed.
 */
function spawnBackgroundSelfUpdate(
  plugin: string,
  version: string,
  repo: string,
  cacheDir?: string,
): void {
  const channel = resolveLauncherChannel(process.env, readProjectConfig());
  if (channel !== "stable" || !version) return;
  const self = process.argv[1];
  if (!self) return;
  try {
    const args = [self, SELF_UPDATE_SUBCOMMAND, plugin, version, "--repo", repo];
    if (cacheDir) args.push("--cache-dir", cacheDir);
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* best-effort: a failed background spawn never affects the foreground */
  }
}

/**
 * The detached background worker: resolve version/channel/gate, run the in-range
 * self-update, log the outcome, exit 0. Never throws to the parent (there is no
 * parent — it is detached), and {@link backgroundSelfUpdate} itself never throws.
 */
async function selfUpdateMode(argv: readonly string[]): Promise<never> {
  const plan = parseFetchArgs(argv);
  const plugin = plan.plugin;
  const installedVersion = plan.version ?? "";
  const cacheDir = cacheRoot(plan.cacheDir);
  if (!plugin || !isPluginEnabled(process.cwd(), gatePluginName(plugin))) {
    process.exit(0);
  }
  const channel = resolveLauncherChannel(process.env, readProjectConfig());
  const result = await backgroundSelfUpdateWithRetry(realSelfUpdateIO, {
    plugin,
    installedVersion,
    repo: plan.repo,
    cacheDir,
    channel,
  }, {
    onRetry: async ({ attempt, nextAttempt, delayMs, error }) => {
      await logLine(
        cacheDir,
        `self-update: ${plugin} check failed on attempt ${attempt} (${error}); retry ${nextAttempt} in ${Math.round(delayMs / 1000)}s`,
      );
    },
  });
  if (result.status === "updated") {
    await logLine(cacheDir, `self-update: ${plugin} swapped to ${result.version} for next boot after ${result.attempts ?? 1} attempt(s)`);
  } else if (result.status === "error") {
    await logLine(cacheDir, `self-update: ${plugin} check failed after ${result.attempts ?? 1} attempt(s) (${result.error}); cached bundle keeps serving`);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // The reserved background self-update worker (ADR 0084) is handled before any
  // role routing so it works from every build (the run-pinned `afk.mjs` and the
  // fetch-role `red-fetch.mjs` alike) and never collides with a bundle command.
  if (argv[0] === SELF_UPDATE_SUBCOMMAND) {
    await selfUpdateMode(argv.slice(1));
    return;
  }
  await fetchMode(parseEntrypoint(argv, buildRole()));
}

// Only execute when invoked directly (`node red-fetch.mjs …`), never when
// imported (e.g. the unit test importing `parseEntrypoint`).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
