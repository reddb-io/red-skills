import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Storage backends the `memory init` wizard can configure. This slice only
 * implements `markdown-only`; `graph` and `hybrid` arrive in later PRD #49
 * slices and are kept in the type so the config schema is forward-stable.
 */
export type StorageMode = "markdown-only" | "graph" | "hybrid";

/**
 * The four auto-firing hooks the full memory plugin can install. In
 * markdown-only mode every one is off — nothing reads or writes memory unless
 * the user explicitly runs `/memory:store` or `/memory:recall`.
 */
export interface HookConfig {
  sessionStart: boolean;
  postToolUse: boolean;
  stop: boolean;
  preCompact: boolean;
}

export interface MemoryConfig {
  version: number;
  mode: StorageMode;
  /** Where markdown notes live, relative to the repo root. */
  notesDir: string;
  hooks: HookConfig;
  /** Whether the stdio MCP server is wired up. Off in markdown-only mode. */
  mcp: boolean;
  /** Whether a RedDB engine is required. Always false in markdown-only mode. */
  reddb: boolean;
}

export const CONFIG_VERSION = 1;

/** Every hook disabled — the markdown-only default. */
export const HOOKS_OFF: HookConfig = {
  sessionStart: false,
  postToolUse: false,
  stop: false,
  preCompact: false,
};

/** Default location for markdown notes, under the single global `.red/`. */
export const DEFAULT_NOTES_DIR = ".red/memory/notes";

/** Absolute path to the memory config file for a given repo root. */
export function configPath(rootDir: string): string {
  return resolve(rootDir, ".red/memory/config.json");
}

/** Resolve a config's `notesDir` (always repo-relative) to an absolute path. */
export function resolveNotesDir(rootDir: string, config: MemoryConfig): string {
  return isAbsolute(config.notesDir)
    ? config.notesDir
    : join(resolve(rootDir), config.notesDir);
}

/** Write the config to `<root>/.red/memory/config.json`, creating parents. */
export async function writeConfig(
  rootDir: string,
  config: MemoryConfig,
): Promise<string> {
  const path = configPath(rootDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

/** Read the config, or return null if memory was never initialized here. */
export async function readConfig(rootDir: string): Promise<MemoryConfig | null> {
  try {
    const raw = await readFile(configPath(rootDir), "utf8");
    return JSON.parse(raw) as MemoryConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
