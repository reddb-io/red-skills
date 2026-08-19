import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_VERSION,
  DEFAULT_MEMORY_EVENT_RETENTION_DAYS,
  DEFAULT_NOTES_DIR,
  DEFAULT_STORE_PATH,
  HOOKS_OFF,
  type HookChoice,
  type MemoryConfig,
  resolveHooks,
  resolveNotesDir,
  resolveStoreUri,
  writeConfig,
} from "./config.js";
import { MemoryStore } from "./graph-store.js";
import {
  applyTierVersioning,
  type TierVersioningReport,
} from "./vcs-versioned-collections.js";

export interface MarkdownOnlyOptions {
  /** Repo-relative notes directory. Defaults to `.red/memory/notes`. */
  notesDir?: string;
}

/**
 * Build the config object for the markdown-only choice: hooks off, MCP off,
 * RedDB not required. Pure — no filesystem side effects, so the init-wizard
 * test can assert the gating directly.
 */
export function markdownOnlyConfig(opts: MarkdownOnlyOptions = {}): MemoryConfig {
  return {
    version: CONFIG_VERSION,
    mode: "markdown-only",
    notesDir: opts.notesDir ?? DEFAULT_NOTES_DIR,
    hooks: { ...HOOKS_OFF },
    mcp: false,
    reddb: false,
  };
}

export interface InitResult {
  config: MemoryConfig;
  configPath: string;
  notesDir: string;
}

/**
 * Run the markdown-only init path: write the config and create the notes
 * directory. Requires nothing beyond node — no RedDB, no MCP, no toolchain.
 */
export async function initMarkdownOnly(
  rootDir: string,
  opts: MarkdownOnlyOptions = {},
): Promise<InitResult> {
  const config = markdownOnlyConfig(opts);
  const notesDir = resolveNotesDir(rootDir, config);
  await mkdir(notesDir, { recursive: true });
  const configPath = await writeConfig(rootDir, config);
  return { config, configPath, notesDir: join(resolve(rootDir), config.notesDir) };
}

export interface GraphOptions {
  /** Repo-relative path to the RedDB store. Defaults to `.red/memory/graph.rdb`. */
  storePath?: string;
  /** Project tag stamped on every node. Defaults to the repo dir name. */
  project?: string;
  /**
   * The wizard's "turn hooks on?" answer. `true` enables all four auto-firing
   * hooks; a partial set enables a subset; `false`/absent leaves them all off.
   * Resolved through {@link resolveHooks} so the gating is centralized.
   */
  hooks?: HookChoice;
  /**
   * Explicit per-project Skill telemetry opt-in. `true` records that the
   * project wants Skill telemetry ingest; `false`/absent leaves it off.
   * Honored only in graph mode (markdown-only never gets it).
   */
  skillTelemetry?: boolean;
  /** Raw operational event retention horizon in days. Defaults to 30. */
  eventRetentionDays?: number;
}

/**
 * Build the config object for graph mode: a per-project RedDB store, RedDB
 * required. Hooks default off and are turned on only by an explicit `hooks`
 * opt-in. Pure — no filesystem side effects, so tests can assert the gating
 * directly.
 */
export function graphConfig(opts: GraphOptions = {}): MemoryConfig {
  return {
    version: CONFIG_VERSION,
    mode: "graph",
    notesDir: DEFAULT_NOTES_DIR,
    storePath: opts.storePath ?? DEFAULT_STORE_PATH,
    hooks: resolveHooks("graph", opts.hooks),
    mcp: false,
    reddb: true,
    skillTelemetry: opts.skillTelemetry === true,
    eventLog: {
      retentionDays: opts.eventRetentionDays ?? DEFAULT_MEMORY_EVENT_RETENTION_DAYS,
    },
  };
}

export interface GraphInitResult {
  config: MemoryConfig;
  configPath: string;
  storeUri: string;
  versioning: TierVersioningReport;
}

/**
 * Run the graph init path: write the config, then open the per-project RedDB
 * store once to provision its graph collections. Requires the local build to
 * have run (`pnpm install && build`) so `@reddb-io/sdk` and its bundled binary
 * are present — no committed `dist/`/`node_modules/`.
 */
export async function initGraph(
  rootDir: string,
  opts: GraphOptions = {},
): Promise<GraphInitResult> {
  const config = graphConfig(opts);
  const storeUri = resolveStoreUri(rootDir, config);
  // The SDK creates the .rdb file but not its parent directory.
  await mkdir(dirname(storeUri.replace(/^file:\/\//, "")), { recursive: true });
  const configPath = await writeConfig(rootDir, config);
  const store = await MemoryStore.open({ uri: storeUri, project: opts.project });
  try {
    const versioning = await applyTierVersioning(store);
    return { config, configPath, storeUri, versioning };
  } finally {
    await store.close();
  }
}
