import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CONFIG_VERSION,
  DEFAULT_NOTES_DIR,
  HOOKS_OFF,
  type MemoryConfig,
  resolveNotesDir,
  writeConfig,
} from "./config.js";

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
