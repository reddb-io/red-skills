import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_CONNECTION_STRING = "file://./.red/brain/brain.rdb";

export interface BrainConfig {
  connection_string: string;
}

export interface ResolvedBrainConfig {
  rootDir: string;
  configPath: string;
  connectionString: string;
  rawConnectionString: string;
}

export async function findBrainRoot(startDir = process.cwd()): Promise<string> {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".red"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
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

export async function resolveBrainConfig(startDir = process.cwd()): Promise<ResolvedBrainConfig> {
  const rootDir = await findBrainRoot(startDir);
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
