import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AiProviderConfig } from "./extract-conversation.js";

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
  /**
   * Repo-relative path to the per-project RedDB graph store. Set in `graph`
   * (and later `hybrid`) mode; absent in markdown-only mode.
   */
  storePath?: string;
  hooks: HookConfig;
  /** Whether the stdio MCP server is wired up. Off in markdown-only mode. */
  mcp: boolean;
  /** Whether a RedDB engine is required. False in markdown-only mode. */
  reddb: boolean;
  /**
   * Whether Skill telemetry ingest is enabled for this project. An explicit
   * per-project opt-in, honored only in graph mode — markdown-only has no
   * engine to persist events into, so the field is left absent there. Absent
   * (legacy graph configs) reads as off via {@link skillTelemetryEnabled}.
   */
  skillTelemetry?: boolean;
  /**
   * Raw operational Memory event log policy. Events are an audit substrate, not
   * durable Memory facts; graph mode keeps them for a bounded default horizon.
   */
  eventLog?: {
    /** Number of days raw operational events remain visible to event readers. */
    retentionDays: number;
  };
  /**
   * AI provider for LLM conversation extraction (the `INFERRED` path). Absent
   * until the user configures one; when absent, only the deterministic
   * `EXTRACTED` paths run. Selects a RedDB engine-side provider mode
   * (`openai-compat` for a local Ollama / OpenAI-compatible endpoint,
   * `openai-native`, `anthropic-native`).
   */
  provider?: AiProviderConfig;
}

export const CONFIG_VERSION = 1;

/** Default raw Memory event retention horizon: 30 days. */
export const DEFAULT_MEMORY_EVENT_RETENTION_DAYS = 30;

/** Every hook disabled — the markdown-only default. */
export const HOOKS_OFF: HookConfig = {
  sessionStart: false,
  postToolUse: false,
  stop: false,
  preCompact: false,
};

/** Every hook enabled — the all-in opt-in for an engine-backed mode. */
export const HOOKS_ALL_ON: HookConfig = {
  sessionStart: true,
  postToolUse: true,
  stop: true,
  preCompact: true,
};

/**
 * What the init wizard offers for the "turn hooks on?" question: a blanket
 * boolean (`true` = all on, `false`/absent = all off) or a partial set to
 * enable a subset. Markdown-only is not negotiable — it never gets hooks.
 */
export type HookChoice = boolean | Partial<HookConfig> | undefined;

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
export function resolveHooks(mode: StorageMode, choice: HookChoice): HookConfig {
  if (mode === "markdown-only") return { ...HOOKS_OFF };
  if (choice === true) return { ...HOOKS_ALL_ON };
  if (!choice) return { ...HOOKS_OFF };
  return { ...HOOKS_OFF, ...choice };
}

/**
 * Whether Skill telemetry ingest is active for a project. True only when the
 * project is in graph mode and the explicit opt-in is set — the single source
 * of truth shared by the CLI event verb and adapters/status. A missing field
 * (legacy graph config) reads as off, so telemetry never fires unless a project
 * opted in at init time.
 */
export function skillTelemetryEnabled(config: MemoryConfig): boolean {
  return config.mode === "graph" && config.skillTelemetry === true;
}

/** Default location for markdown notes, under the single global `.red/`. */
export const DEFAULT_NOTES_DIR = ".red/memory/notes";

/** Default location for the per-project RedDB graph store, under `.red/`. */
export const DEFAULT_STORE_PATH = ".red/memory/graph.rdb";

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

/** Resolve the graph store path to an absolute `file://` URI for the SDK. */
export function resolveStoreUri(rootDir: string, config: MemoryConfig): string {
  const storePath = config.storePath ?? DEFAULT_STORE_PATH;
  const abs = isAbsolute(storePath) ? storePath : join(resolve(rootDir), storePath);
  return `file://${abs}`;
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
