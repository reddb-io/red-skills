import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Owns `.red/memory/sessions/current` — the per-worktree session id that
 * working-memory layers (L1/L2) scope themselves to. Minted by the
 * `SessionStart` hook on Claude Code; on Codex (no equivalent event before
 * 2026-05) or any runner without a wired hook, falls back to the
 * `MEMORY_SESSION_ID` env var, then to a first-call mint via {@link ensure}.
 */

const SESSIONS_DIR = ".red/memory/sessions";
const CURRENT_FILE = "current";
const ENV_VAR = "MEMORY_SESSION_ID";

export function sessionsDir(rootDir: string): string {
  return resolve(rootDir, SESSIONS_DIR);
}

export function sessionFile(rootDir: string): string {
  return join(sessionsDir(rootDir), CURRENT_FILE);
}

/** Read the current session id, or null if no file (or unreadable). */
export async function current(rootDir: string): Promise<string | null> {
  try {
    const raw = await readFile(sessionFile(rootDir), "utf8");
    const id = raw.trim();
    return id.length > 0 ? id : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

/**
 * Mint a session id and write it to `.red/memory/sessions/current`,
 * overwriting any existing file. If `opts.id` is given (e.g. a runner-supplied
 * `session_id` from a SessionStart payload), it is used verbatim; otherwise a
 * UUID is minted. Returns the id written.
 */
export async function start(
  rootDir: string,
  opts: { id?: string } = {},
): Promise<string> {
  const id = opts.id?.trim() || randomUUID();
  const file = sessionFile(rootDir);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${id}\n`, "utf8");
  return id;
}

/** Drop the session file. No-op if it does not exist. */
export async function end(rootDir: string): Promise<void> {
  await rm(sessionFile(rootDir), { force: true });
}

/**
 * Resolve a session id for this worktree, minting + writing one if no file is
 * present yet. Resolution order:
 *
 * 1. `.red/memory/sessions/current` (already-minted lifecycle session).
 * 2. `process.env.MEMORY_SESSION_ID` (harness-provided override).
 * 3. A fresh UUID minted on this call.
 *
 * In cases 2 and 3 the resolved id is persisted to the file so subsequent
 * lookups (CLI, MCP, other hooks) all see the same value.
 */
export async function ensure(
  rootDir: string,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const existing = await current(rootDir);
  if (existing) return existing;
  const fromEnv = (opts.env ?? process.env)[ENV_VAR]?.trim();
  return start(rootDir, fromEnv ? { id: fromEnv } : {});
}
