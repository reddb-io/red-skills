import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_CONNECTION_STRING = "file://./.red/brain/brain.rdb";
export const BRAIN_ROOT_ENV = "RED_BRAIN_ROOT";
export const BRAIN_ROOT_MARKER = "brain.root";

export interface BrainConfig {
  connection_string: string;
}

export interface ResolvedBrainConfig {
  rootDir: string;
  configPath: string;
  connectionString: string;
  rawConnectionString: string;
}

export interface BrainRootResolutionOptions {
  env?: Record<string, string | undefined>;
}

export async function findBrainRoot(
  startDir = process.cwd(),
  options: BrainRootResolutionOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const envRoot = env[BRAIN_ROOT_ENV];
  if (envRoot) return resolve(startDir, envRoot);

  const configRoot = await findConfiguredBrainRoot(startDir);
  if (configRoot) return configRoot;

  // **Brain is the USER's, not a project's** (ADR 0152). A second repository is
  // not a second brain, so the default root is host-scoped and every checkout
  // reaches the same store. An explicit `RED_BRAIN_ROOT` or a
  // `plugins.brain.rootDir` in config still wins above — both are read before
  // this line — and a checkout that ALREADY holds a store keeps it, because
  // silently pointing an existing brain at an empty one loses a user's notes.
  const existing = findExistingProjectBrainRoot(startDir);
  if (existing) return existing;
  return hostBrainRoot(options.env ?? process.env);
}

/**
 * The root the host-scoped brain hangs off — the user's home directory.
 *
 * A root is the directory that CONTAINS `.red/brain`, never `.red` itself:
 * `brainConfigPath` and the default connection string both append `.red/brain`
 * to it, exactly as a checkout root does. Returning `~/.red` here put the store
 * at `~/.red/.red/brain` — one level deeper than the `~/.red/brain` ADR 0152
 * decided, and deeper than every other root in this module resolves to.
 */
export function hostBrainRoot(env: Record<string, string | undefined> = process.env): string {
  return env["HOME"] ?? env["USERPROFILE"] ?? homedir();
}

/** A checkout that already carries a brain store, walking up from `startDir`. */
function findExistingProjectBrainRoot(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const redDir = join(current, ".red");
    if (
      existsSync(redDir) &&
      (existsSync(join(redDir, "brain")) || existsSync(join(redDir, BRAIN_ROOT_MARKER)))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function findConfiguredBrainRoot(startDir: string): Promise<string | null> {
  let current = resolve(startDir);
  while (true) {
    const configPath = join(current, ".red", "config.yaml");
    try {
      const text = await readFile(configPath, "utf8");
      const root = parseBrainRootOverride(text);
      if (root) return resolve(current, root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function parseBrainRootOverride(text: string): string | null {
  const flat = parseYamlFlat(text);
  return (
    flat["plugins.brain.rootDir"] ??
    flat["plugins.brain.root"] ??
    flat["plugins.brain.root_dir"] ??
    flat["brain.rootDir"] ??
    flat["brain.root"] ??
    flat["brain.root_dir"] ??
    null
  );
}

function parseYamlFlat(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const stack: string[] = [];
  const indents: number[] = [];

  for (const rawLine of text.split("\n")) {
    let line = rawLine.replace(/\r$/, "");
    if (!/".*"/.test(line) && !/'.*'/.test(line)) {
      const hash = line.indexOf("#");
      if (hash >= 0) line = line.slice(0, hash);
    }
    if (line.replace(/\s/g, "") === "") continue;

    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent % 2 !== 0) continue;
    const rest = line.slice(indent).replace(/\s+$/, "");
    const colon = rest.indexOf(":");
    if (colon < 0 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(rest.slice(0, colon))) continue;

    const key = rest.slice(0, colon);
    let value = rest.slice(colon + 1).replace(/^\s+/, "");
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) value = value.slice(1, -1);

    while (indents.length > 0 && indents[indents.length - 1]! >= indent) {
      stack.pop();
      indents.pop();
    }

    const full = stack.length > 0 ? `${stack.join(".")}.${key}` : key;
    if (value === "") {
      stack.push(key);
      indents.push(indent);
    } else {
      out[full] = value;
    }
  }

  return out;
}

export function brainConfigPath(rootDir: string): string {
  return join(resolve(rootDir), ".red", "brain", "config.yaml");
}

export function rootEnvPath(rootDir: string): string {
  return join(resolve(rootDir), ".env");
}

export async function ensureBrainConfig(rootDir: string): Promise<string> {
  const path = brainConfigPath(rootDir);
  if (existsSync(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `connection_string: ${DEFAULT_CONNECTION_STRING}\n`, "utf8");
  return path;
}

export async function readBrainConfig(rootDir: string): Promise<BrainConfig | null> {
  const path = brainConfigPath(rootDir);
  try {
    const text = await readFile(path, "utf8");
    return parseBrainConfig(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function parseBrainConfig(text: string): BrainConfig {
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith("connection_string:"));
  if (!line) return { connection_string: DEFAULT_CONNECTION_STRING };
  const raw = line.slice("connection_string:".length).trim();
  return { connection_string: unquote(raw) || DEFAULT_CONNECTION_STRING };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Resolve the HOST brain config — `~/.red/brain`, with no walk-up at all.
 *
 * The daemon holds this store for every session on the machine (ADR 0152), and
 * it must never take a client checkout as an input (ADR 0144 §5). `findBrainRoot`
 * deliberately does take one: it honours a directory that ALREADY carries a
 * store, so a user's existing notes are never silently repointed. That mercy
 * belongs to a session standing somewhere; the daemon stands nowhere, so it
 * asks for the user's root by name. `RED_BRAIN_ROOT` still wins, resolved
 * against the host root rather than against whoever happened to call.
 */
export async function resolveHostBrainConfig(
  env: Record<string, string | undefined> = process.env,
): Promise<ResolvedBrainConfig> {
  const home = hostBrainRoot(env);
  const override = env[BRAIN_ROOT_ENV];
  return await resolveBrainConfigAt(
    override == null || override === "" ? home : resolve(home, override),
  );
}

export async function resolveBrainConfig(startDir = process.cwd()): Promise<ResolvedBrainConfig> {
  return await resolveBrainConfigAt(await findBrainRoot(startDir));
}

async function resolveBrainConfigAt(rootDir: string): Promise<ResolvedBrainConfig> {
  const configPath = await ensureBrainConfig(rootDir);
  const config = (await readBrainConfig(rootDir)) ?? {
    connection_string: DEFAULT_CONNECTION_STRING,
  };
  const env = await readRootEnv(rootDir);
  const rawConnectionString = config.connection_string;
  const interpolated = interpolateEnv(rawConnectionString, env);
  return {
    rootDir,
    configPath,
    rawConnectionString,
    connectionString: resolveConnectionString(rootDir, interpolated),
  };
}

export async function readRootEnv(rootDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const text = await readFile(rootEnvPath(rootDir), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = unquote(trimmed.slice(idx + 1).trim());
      if (out[key] == null) out[key] = value;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return out;
}

export function interpolateEnv(value: string, env: Record<string, string>): string {
  return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_match, bare, braced) => {
    const name = String(bare ?? braced);
    const resolved = env[name];
    if (resolved == null || resolved === "") {
      throw new Error(`Brain connection_string references missing environment variable ${name}`);
    }
    return resolved;
  });
}

export function resolveConnectionString(rootDir: string, connectionString: string): string {
  if (!connectionString.startsWith("file://")) return connectionString;
  const path = connectionString.slice("file://".length);
  if (isAbsolute(path)) return connectionString;
  return `file://${resolve(rootDir, path)}`;
}
