import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
export const CONFIG_VERSION = 1;
/** Default raw Memory event retention horizon: 30 days. */
export const DEFAULT_MEMORY_EVENT_RETENTION_DAYS = 30;
/** Default L2 node max age: 24 hours. */
export const DEFAULT_L2_TTL_MS = 24 * 60 * 60 * 1000;
/** Default L2 per-session byte budget: 16 MiB. */
export const DEFAULT_L2_BYTE_BUDGET = 16 * 1024 * 1024;
/**
 * Resolve the active L2 eviction policy from a memory config. Missing or
 * non-finite fields fall back to {@link DEFAULT_L2_TTL_MS} and
 * {@link DEFAULT_L2_BYTE_BUDGET}.
 */
export function resolveL2Policy(config) {
    const l2 = config?.l2 ?? {};
    const ttl = typeof l2.ttlMs === "number" && Number.isFinite(l2.ttlMs) && l2.ttlMs > 0
        ? l2.ttlMs
        : DEFAULT_L2_TTL_MS;
    const budget = typeof l2.byteBudget === "number" && Number.isFinite(l2.byteBudget) && l2.byteBudget > 0
        ? l2.byteBudget
        : DEFAULT_L2_BYTE_BUDGET;
    return { ttlMs: ttl, byteBudget: budget };
}
/** Every hook disabled — the markdown-only default. */
export const HOOKS_OFF = {
    sessionStart: false,
    postToolUse: false,
    stop: false,
    preCompact: false,
};
/** Every hook enabled — the all-in opt-in for an engine-backed mode. */
export const HOOKS_ALL_ON = {
    sessionStart: true,
    postToolUse: true,
    stop: true,
    preCompact: true,
};
/**
 * Resolve the active hook set from the chosen storage mode and the user's
 * opt-in. The single source of truth for hook gating, shared by the init
 * wizard and its gating test:
 *
 * - `markdown-only` → always {@link HOOKS_OFF}; there is no engine to recall
 *   from or index into, so nothing can fire (AC3).
 * - `graph` / `hybrid` → honor the choice: `true`/all-on, `false`/absent/off,
 *   or a partial set merged over {@link HOOKS_OFF}.
 */
export function resolveHooks(mode, choice) {
    if (mode === "markdown-only")
        return { ...HOOKS_OFF };
    if (choice === true)
        return { ...HOOKS_ALL_ON };
    if (!choice)
        return { ...HOOKS_OFF };
    return { ...HOOKS_OFF, ...choice };
}
/**
 * Whether Skill telemetry ingest is active for a project. True only when the
 * project is in graph mode and the explicit opt-in is set — the single source
 * of truth shared by the CLI event verb and adapters/status. A missing field
 * (legacy graph config) reads as off, so telemetry never fires unless a project
 * opted in at init time.
 */
export function skillTelemetryEnabled(config) {
    return config.mode === "graph" && config.skillTelemetry === true;
}
/** Default location for markdown notes, under the single global `.red/`. */
export const DEFAULT_NOTES_DIR = ".red/memory/notes";
/** Default location for the per-project RedDB graph store, under `.red/`. */
export const DEFAULT_STORE_PATH = ".red/memory/graph.rdb";
/** Absolute path to the memory config file for a given repo root. */
export function configPath(rootDir) {
    return resolve(rootDir, ".red/memory/config.json");
}
/** Resolve a config's `notesDir` (always repo-relative) to an absolute path. */
export function resolveNotesDir(rootDir, config) {
    return isAbsolute(config.notesDir)
        ? config.notesDir
        : join(resolve(rootDir), config.notesDir);
}
/** Resolve the graph store path to an absolute `file://` URI for the SDK. */
export function resolveStoreUri(rootDir, config) {
    const storePath = config.storePath ?? DEFAULT_STORE_PATH;
    const abs = isAbsolute(storePath) ? storePath : join(resolve(rootDir), storePath);
    return `file://${abs}`;
}
/** Write the config to `<root>/.red/memory/config.json`, creating parents. */
export async function writeConfig(rootDir, config) {
    const path = configPath(rootDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return path;
}
/** Read the config, or return null if memory was never initialized here. */
export async function readConfig(rootDir) {
    try {
        const raw = await readFile(configPath(rootDir), "utf8");
        return JSON.parse(raw);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
}
