#!/usr/bin/env node
/**
 * entrypoint-cli.ts — the single committed, dependency-free entrypoint for every
 * per-plugin bundle (ADR 0039). One source, two roles, selected by the
 * `__ENTRYPOINT_ROLE__` build define so the same program ships at the two paths
 * external configs already pin:
 *
 *   - `fetch`   → built to `plugins/dev/hooks/red-fetch.mjs` (the SessionStart
 *                 cache pre-warmer). Best-effort: NEVER blocks; populates the
 *                 version-keyed cache and exits 0 on any failure.
 *   - `run:<p>` → built to `plugins/dev/skills/engineering/afk/bin/afk.mjs` (the
 *                 skill/statusline launcher). Resolves plugin `<p>`'s bundle
 *                 (cache → repo-root dist → fetch) and execs it, failing LOUD
 *                 when nothing resolves (interactive — no silent no-op).
 *
 * Both modes are also reachable explicitly as subcommands regardless of role:
 *   node <entrypoint> fetch <plugin> <version> [--repo owner/name] [--cache-dir DIR]
 *   node <entrypoint> run   <plugin> [args… forwarded to the bundle]
 * and the no-subcommand form falls back to the build role (so the legacy
 * `red-fetch.mjs <plugin> <version>` invocation and `afk.mjs <cmd>` keep working).
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
import { fileURLToPath } from "node:url";
import {
  BundleFetchError,
  type BundleIO,
  NPM_PACKAGE,
  bundleFileName,
  ensureBundle,
  isCacheableVersion,
  resolveBundle,
} from "./bundle-fetch.js";
import { type ReleaseChannel, channelReleaseRef, resolveChannel } from "./channel.js";
import { findUp, flatConfigValue, isPluginEnabled } from "./plugin-gate.js";
import {
  backgroundSelfUpdateWithRetry,
  resolveActiveVersionDetailed,
  type SelfUpdateIO,
} from "./self-update.js";

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

const realIO: BundleIO = {
  async materialize(spec, stagingDir) {
    await mkdir(stagingDir, { recursive: true });
    // `npm install <spec> --prefix <staging>` resolves the pinned package via
    // npm's own cache (cache-first, shasum-verified) and lands it at
    // <staging>/node_modules/@reddb-io/red-skills. --no-save keeps the staging
    // dir free of a package.json; --ignore-scripts because our package has no
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
    return join(stagingDir, "node_modules", ...NPM_PACKAGE.split("/"));
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
export interface RunPlan {
  mode: "run";
  plugin?: string;
  /** Args forwarded verbatim to the resolved bundle. */
  rest: string[];
  repo: string;
  cacheDir?: string;
}
export type EntrypointPlan = FetchPlan | RunPlan;

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
 * Route argv into a fetch or run plan.
 *
 * A run-pinned build (`role === "run:<plugin>"`, e.g. the `afk.mjs` launcher) is
 * a *dedicated forwarder*: every arg goes to the pinned plugin's bundle, which
 * owns its own command surface (`run`, `monitor`, `fleet`, …). So the pin is
 * honoured FIRST — the generic `run`/`fetch` entrypoint verbs must not shadow a
 * dedicated launcher's own commands. Before #434 the `argv[0] === "run"` check
 * ran first, so `afk.mjs run --boot-only` parsed `--boot-only` as a *plugin
 * name* and 404'd; only the bare form happened to work.
 *
 * For the generic / fetch-role entrypoint (`red-fetch.mjs`, no run-pin) the
 * explicit `fetch`/`run <plugin>` subcommands still win, and the no-subcommand
 * form is the legacy positional fetch.
 */
export function parseEntrypoint(argv: readonly string[], role: string): EntrypointPlan {
  if (role.startsWith("run:")) {
    return { mode: "run", plugin: role.slice(4), rest: [...argv], repo: DEFAULT_REPO };
  }
  if (argv[0] === "run") {
    return { mode: "run", plugin: argv[1], rest: argv.slice(2), repo: DEFAULT_REPO };
  }
  if (argv[0] === "fetch") {
    return parseFetchArgs(argv.slice(1));
  }
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

// ── Run-mode bundle resolution (IO) ──────────────────────────────────────────

const moduleDir = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
})();

/** Installed plugin version, read from the nearest `.claude-plugin/plugin.json`. */
function resolvePluginVersion(): string {
  const manifest = findUp(moduleDir, join(".claude-plugin", "plugin.json"));
  if (!manifest) return "";
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).version || "";
  } catch {
    return "";
  }
}

function cachedBundlePath(
  plugin: string,
  version: string,
  cacheDir: string,
  channel: ReleaseChannel,
): string | null {
  if (!isCacheableVersion(version) && channel !== "canary") return null;
  const p = resolveBundle({ plugin, version, cacheDir, channel });
  return existsSync(p) ? p : null;
}

/** Repo-root `dist/<plugin>.bundle.min.mjs` fallback for local development. */
function distBundlePath(plugin: string): string | null {
  return findUp(moduleDir, join("dist", `${plugin}.bundle.min.mjs`));
}

/**
 * The config flag a fetch/run for `plugin` gates on. `code-nav` ships under the
 * dev plugin's umbrella (dev's SessionStart hook warms it, there is no separate
 * `plugins.code-nav` block), so it gates on `dev` — not a `code-nav` flag that
 * would never be set.
 */
export function gatePluginName(plugin: string): string {
  return plugin === "code-nav" ? "dev" : plugin;
}

/**
 * Run-mode subcommands that are fired by automatic hooks (PreToolUse model-tier
 * routing, the statusline refresh). When gated off they must be SILENT — no
 * stderr — so a non-opted-in repo gets zero noise on every tool call / render.
 * Interactive invocations (e.g. `/afk`) instead get a one-line setup hint.
 */
const SILENT_RUN_SUBCOMMANDS = new Set(["route-model-tier", "statusline"]);

async function runMode(plan: RunPlan): Promise<never> {
  const { plugin } = plan;
  if (!plugin) {
    process.stderr.write("entrypoint: `run` requires a <plugin> name.\n");
    process.exit(1);
  }
  // Per-directory gate (ADR 0067): a globally-installed launcher must stay inert
  // in any directory that did not explicitly opt in. Exit 0 (not 1) so a blanked
  // statusline degrades gracefully and an interactive invocation gets a hint
  // instead of a crash. Checked BEFORE any bundle resolution or fetch.
  if (!isPluginEnabled(process.cwd(), gatePluginName(plugin))) {
    if (!SILENT_RUN_SUBCOMMANDS.has(plan.rest[0] ?? "")) {
      process.stderr.write(
        `entrypoint: ${plugin} is not enabled in this directory ` +
          `(no \`plugins.${gatePluginName(plugin)}.enabled: true\` in .red/config.yaml). ` +
          `Run /red-setup to enable it.\n`,
      );
    }
    process.exit(0);
  }
  const cacheDir = cacheRoot(plan.cacheDir);
  const installedVersion = resolvePluginVersion();
  const channel = resolveLauncherChannel(process.env, readProjectConfig());
  // In-range self-update (ADR 0084): serve the version a prior background update
  // atomically swapped in, if any. This is a LOCAL read only (pointer + cache
  // existence) — it can never fetch, so the render/hook path stays fetch-free
  // (the blank-statusline class stays dead). No pointer → the installed version.
  const resolution = await resolveActiveVersionDetailed(realSelfUpdateIO, {
    plugin,
    installedVersion,
    cacheDir,
    channel,
  });
  const version = resolution.version;
  // Audit line so a fleet's channel is visible in its boot output (ADR 0058).
  const resolutionNote = resolution.logNotes.length > 0 ? `; ${resolution.logNotes.join("; ")}` : "";
  process.stderr.write(
    `entrypoint: resolving ${plugin} via ${channel} channel (${channelReleaseRef(channel, version)})${resolutionNote}\n`,
  );

  let bundle = cachedBundlePath(plugin, version, cacheDir, channel) ?? distBundlePath(plugin);
  if (!bundle && (version || channel === "canary")) {
    try {
      bundle = await ensureBundle(realIO, { plugin, version, repo: plan.repo, cacheDir, channel });
    } catch (err) {
      const kind = err instanceof BundleFetchError ? err.kind : "unknown";
      const msg = err instanceof Error ? err.message : String(err);
      await logLine(cacheDir, `${kind}: ${msg} (run plugin=${plugin} version=${version} channel=${channel})`);
      bundle = cachedBundlePath(plugin, version, cacheDir, channel) ?? distBundlePath(plugin);
    }
  }

  if (!bundle) {
    const want =
      isCacheableVersion(version) || channel === "canary"
        ? bundleFileName(plugin, version, channel)
        : `${plugin}-<version>.bundle.min.mjs`;
    process.stderr.write(
      `entrypoint: could not resolve the ${plugin} runtime bundle (${want}).\n` +
        `  Looked in cache ${cacheDir} and repo-root dist/.\n` +
        `  The bundle ships inside the ${NPM_PACKAGE} npm package (ADR 0091),\n` +
        `  resolved via npm on first run; ensure network access, or build locally:\n` +
        `    pnpm -C apps/${plugin} run bundle\n`,
    );
    process.exit(1);
  }

  // Delegate as a subprocess (argv[1] = bundle, so the bundle's
  // `import.meta.url === file://process.argv[1]` self-exec guard fires).
  const res = spawnSync(process.execPath, [bundle, ...plan.rest], { stdio: "inherit" });
  if (res.signal) {
    process.kill(process.pid, res.signal);
  }
  process.exit(res.status ?? 1);
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
    const path = await ensureBundle(realIO, { plugin, version, repo: plan.repo, cacheDir, channel });
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
  const plan = parseEntrypoint(argv, buildRole());
  if (plan.mode === "run") await runMode(plan);
  else await fetchMode(plan);
}

// Only execute when invoked directly (`node red-fetch.mjs …` / `node afk.mjs …`),
// never when imported (e.g. the unit test importing `parseEntrypoint`).
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
