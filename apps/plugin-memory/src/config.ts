import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AiProviderConfig } from "./extract-conversation.js";
import type { RecallRankingConfig } from "./recall-ranking.js";
import { mergeMemoryBlock, parsePluginsMemory } from "./shared-config.js";
import { readMemoryStateFile } from "./toon-state.js";

/** Storage backends the `memory init` wizard can configure. */
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
  /**
   * Per-directory activation flag (ADR 0067). `plugins.memory.enabled: true` is
   * what authorizes the globally-installed memory launcher to run in this repo;
   * `/red-setup` writes it. Carried here only so the `memory init` write
   * path round-trips it — the launcher gate reads it straight from the YAML.
   */
  enabled?: boolean;
  mode: StorageMode;
  /** Where markdown notes live, relative to the repo root. */
  notesDir: string;
  /**
   * Repo-relative path to the per-project RedDB graph store. Set in graph-like
   * modes; absent in markdown-only mode.
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
   * L2 working-memory eviction policy (issue #182). Drives the `memory working
   * evict` sweep. Both fields are optional — resolved against the documented
   * defaults via {@link resolveL2Policy}. L1 is naturally ephemeral and L3 is
   * never touched by this policy.
   */
  l2?: {
    /** Max age before an L2 node is reaped. Default {@link DEFAULT_L2_TTL_MS} (24h). */
    ttlMs?: number;
    /** Per-session byte budget for L2 events. Default {@link DEFAULT_L2_BYTE_BUDGET} (16 MiB). */
    byteBudget?: number;
  };
  /**
   * Deterministic governed-recall ranking pipeline overrides. Defaults are
   * documented in `DEFAULT_RECALL_RANKING_CONFIG`; this block stays sparse so
   * config only records operator changes.
   */
  recallRanking?: Partial<RecallRankingConfig>;
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

/** Default L2 node max age: 24 hours. */
export const DEFAULT_L2_TTL_MS = 24 * 60 * 60 * 1000;

/** Default L2 per-session byte budget: 16 MiB. */
export const DEFAULT_L2_BYTE_BUDGET = 16 * 1024 * 1024;

/** Resolved L2 eviction policy after config + defaults are applied. */
export interface ResolvedL2Policy {
  ttlMs: number;
  byteBudget: number;
}

/**
 * Resolve the active L2 eviction policy from a memory config. Missing or
 * non-finite fields fall back to {@link DEFAULT_L2_TTL_MS} and
 * {@link DEFAULT_L2_BYTE_BUDGET}.
 */
export function resolveL2Policy(config: MemoryConfig | null | undefined): ResolvedL2Policy {
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

/** Shared Repo store provisioned by `/red-setup` for all RedDB-backed plugins. */
export const REPO_STORE_PATH = ".red/red.rdb";

/**
 * Absolute path to the unified config file for a given repo root (ADR 0042).
 * Memory config lives under the `plugins.memory` block of this file.
 */
export function configPath(rootDir: string): string {
  return resolve(rootDir, ".red/config.yaml");
}

/**
 * Absolute path to the legacy standalone memory config. Read as a back-compat
 * fallback (ADR 0042); never written. Removable once repos have re-initialized.
 */
export function legacyConfigPath(rootDir: string): string {
  return resolve(rootDir, ".red/memory/config.json");
}

export function legacyToonConfigPath(rootDir: string): string {
  return resolve(rootDir, ".red/memory/config.toon");
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

/**
 * Write the memory config into the `plugins.memory` block of
 * `<root>/.red/config.yaml` (ADR 0042), merging into any existing file and
 * preserving the rest of it (global keys, a `plugins.dev` sibling, comments).
 * The block is sparse — only non-default fields are emitted.
 */
export async function writeConfig(
  rootDir: string,
  config: MemoryConfig,
): Promise<string> {
  const path = configPath(rootDir);
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, mergeMemoryBlock(existing, config), "utf8");
  return path;
}

/**
 * Read the memory config, or return null if memory was never initialized here.
 * Canonical source is the `plugins.memory` block of `.red/config.yaml`
 * (ADR 0042); falls back to the legacy standalone `.red/memory/config.json`
 * so repos that have not re-initialized keep working.
 */
export async function readConfig(rootDir: string): Promise<MemoryConfig | null> {
  try {
    const yaml = await readFile(configPath(rootDir), "utf8");
    const fromYaml = parsePluginsMemory(yaml);
    if (fromYaml) return fromYaml;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  return readLegacyStandaloneConfig(rootDir);
}

async function readLegacyStandaloneConfig(rootDir: string): Promise<MemoryConfig | null> {
  for (const path of [legacyToonConfigPath(rootDir), legacyConfigPath(rootDir)]) {
    try {
      return await readMemoryStateFile<MemoryConfig>(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return null;
}

export interface StorePathMigrationResult {
  configPath: string;
  fromStorePath: string | null;
  toStorePath: typeof REPO_STORE_PATH;
  configChanged: boolean;
  storeCopied: boolean;
}

/**
 * One-time migration from the legacy standalone memory graph store to the shared
 * Repo store. `/red-setup` and `memory doctor` call this explicitly; the
 * normal read path stays side-effect free.
 */
export async function migrateStorePathToRepoStore(rootDir: string): Promise<StorePathMigrationResult | null> {
  const config = await readConfig(rootDir);
  if (!config || config.mode === "markdown-only") return null;

  const current = config.storePath ?? DEFAULT_STORE_PATH;
  if (current === REPO_STORE_PATH) {
    return {
      configPath: configPath(rootDir),
      fromStorePath: current,
      toStorePath: REPO_STORE_PATH,
      configChanged: false,
      storeCopied: false,
    };
  }

  const legacyAbs = isAbsolute(current) ? current : join(resolve(rootDir), current);
  const targetAbs = join(resolve(rootDir), REPO_STORE_PATH);
  let storeCopied = false;
  if (await fileExists(legacyAbs)) {
    await mkdir(dirname(targetAbs), { recursive: true });
    if (!(await fileExists(targetAbs))) {
      await copyFile(legacyAbs, targetAbs);
      storeCopied = true;
    }
  }

  await writeConfig(rootDir, { ...config, storePath: REPO_STORE_PATH });
  return {
    configPath: configPath(rootDir),
    fromStorePath: current,
    toStorePath: REPO_STORE_PATH,
    configChanged: true,
    storeCopied,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
