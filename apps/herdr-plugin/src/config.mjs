/**
 * config — the plugin's declared defaults and the file above them.
 *
 * Herdr hands every plugin command a `HERDR_PLUGIN_CONFIG_DIR`; `config.toon`
 * inside it is the whole configuration surface. A malformed file is named on
 * stderr and ignored rather than fatal — this code runs a status line and a pane
 * that opens on session restore, and a plugin that refused to start over a stray
 * comma is the harder failure to diagnose than one that ran with its defaults.
 *
 * The file is TOON, which is this repo's format for everything it writes (ADR
 * 0131 absorbed the plugin under that mandate). A `config.json` written against
 * the pre-absorption plugin is not read: every value in it is a default this
 * file already declares, so `init-config` writes a fresh `config.toon` and the
 * operator edits that.
 */
import { decode, encode } from "@reddb-io/toon";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_CONFIG = {
  /** How often the dashboard re-reads the daemon, in milliseconds. */
  refreshMs: 2_000,
  /** `global` shows every project on the machine; `local` shows this checkout's. */
  mode: "global",
  /** Show each Worker's last logged line under its row. */
  verbose: true,
  /** Pins the daemon socket outright; `null` derives it. */
  socketPath: null,
  /** How long one socket read may take before it counts as unreachable. */
  timeoutMs: 2_000,
  notifications: {
    enabled: true,
    /** How often the watcher re-reads the daemon. Activity moves at human speed. */
    pollMs: 15_000,
    /** Do not repeat the same notification inside this window. */
    renotifyMs: 15 * 60_000,
    position: "top-right",
    sound: "none",
    /** A Worker starting is ordinary; only its end is news, by default. */
    workerBirth: false,
    workerDeath: true,
    budgetPressure: true,
    /** Fraction of a Worker's budget that counts as pressure. */
    budgetPressureAt: 0.9,
    daemonReach: true,
    pullRequests: true,
    staleness: true,
    upgrade: true,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** One level of nesting is all this config has, so one level is all it merges. PURE. */
export function mergeConfig(base, override) {
  if (!isPlainObject(override)) return base;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    merged[key] = isPlainObject(base[key]) && isPlainObject(value) ? { ...base[key], ...value } : value;
  }
  return merged;
}

/** The plugin id herdr registers this manifest under. */
export const PLUGIN_ID = "reddb-io.red-skills";

/**
 * herdr's own plugin directory, for a run that herdr did not start.
 *
 * Inside a pane the env vars are handed over and nothing here is guessed. Run by
 * hand — `node bin/red-skills-herdr.mjs doctor`, which is exactly when an operator is
 * checking what the pane is reading — they are absent, and a fallback of this
 * plugin's own invention would send the two runs to different files and report
 * "no config" over a config that is right there. So the fallback is herdr's
 * layout, the one `herdr plugin config-dir` prints.
 */
function herdrPluginDir(kind, env) {
  const base = env.HERDR_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr");
  return join(base, "plugins", kind, env.HERDR_PLUGIN_ID || PLUGIN_ID);
}

/** Where herdr put this plugin's config. */
export function configDir(env = process.env) {
  return env.HERDR_PLUGIN_CONFIG_DIR || herdrPluginDir("config", env);
}

/**
 * Where herdr put this plugin's state.
 *
 * The CLI has no `state-dir` to ask, so the fallback is the config dir's
 * sibling. A hand-run watcher that landed elsewhere would only keep its own
 * bookkeeping apart from the pane's — never lose it — which is why a guess is
 * acceptable here and would not be for the config.
 */
export function stateDir(env = process.env) {
  return env.HERDR_PLUGIN_STATE_DIR || herdrPluginDir("state", env);
}

export const CONFIG_FILE = "config.toon";

/** The effective configuration. A malformed file is reported and stepped over. */
export async function loadConfig(env = process.env) {
  const path = join(configDir(env), CONFIG_FILE);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      process.stderr.write(`red-skills-herdr: ${path} could not be read (${error.message}); using defaults\n`);
    }
    return { ...DEFAULT_CONFIG, path, present: false };
  }
  try {
    return { ...mergeConfig(DEFAULT_CONFIG, decode(raw)), path, present: true };
  } catch (error) {
    process.stderr.write(`red-skills-herdr: ${path} is not valid TOON (${error.message}); using defaults\n`);
    return { ...DEFAULT_CONFIG, path, present: false };
  }
}

/** Write the defaults out once, so an operator has a file to edit. */
export async function writeDefaultConfig(env = process.env) {
  const dir = configDir(env);
  const path = join(dir, CONFIG_FILE);
  await mkdir(dir, { recursive: true });
  await writeFile(path, encode(DEFAULT_CONFIG), { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  return path;
}
