import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  CONFIG_VERSION,
  DEFAULT_NOTES_DIR,
  DEFAULT_STORE_PATH,
  HOOKS_OFF,
  type MemoryConfig,
  resolveNotesDir,
  resolveStoreUri,
  writeConfig,
} from "./config.js";
import { MemoryStore } from "./graph-store.js";

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
}

/**
 * Build the config object for graph mode: a per-project RedDB store, RedDB
 * required. Hooks and MCP stay off in this slice (later PRD #49 work). Pure —
 * no filesystem side effects, so tests can assert the gating directly.
 */
export function graphConfig(opts: GraphOptions = {}): MemoryConfig {
  return {
    version: CONFIG_VERSION,
    mode: "graph",
    notesDir: DEFAULT_NOTES_DIR,
    storePath: opts.storePath ?? DEFAULT_STORE_PATH,
    hooks: { ...HOOKS_OFF },
    mcp: false,
    reddb: true,
  };
}

export interface GraphInitResult {
  config: MemoryConfig;
  configPath: string;
  storeUri: string;
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
  await store.close();
  return { config, configPath, storeUri };
}
