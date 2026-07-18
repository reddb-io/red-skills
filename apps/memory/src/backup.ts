import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DEFAULT_STORE_PATH, readConfig, type MemoryConfig } from "./config.js";
import { readMemoryStateFile, writeMemoryStateFile } from "./toon-state.js";

export interface MemoryBackupFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface MemoryBackupManifest {
  schema_version: "memory.backup.v1";
  name: string;
  root: string;
  created_at: string;
  mode: MemoryConfig["mode"];
  store_path: string | null;
  files: MemoryBackupFile[];
  warnings: string[];
}

export interface MemoryBackupResult {
  manifest: MemoryBackupManifest;
  backup_dir: string;
  manifest_path: string;
  files: number;
  bytes: number;
}

export interface MemoryBackupListEntry {
  name: string;
  backup_dir: string;
  created_at: string;
  mode: MemoryConfig["mode"];
  files: number;
  bytes: number;
  warnings: string[];
}

export interface MemoryRestoreResult {
  restored_from: string;
  restored_files: number;
  restored_bytes: number;
  safety_backup: MemoryBackupResult;
  warnings: string[];
}

const MANIFEST = "manifest.toon";
const LEGACY_MANIFEST = "manifest.json";
const BACKUPS_DIR = "backups";

export async function createMemoryBackup(
  rootDir: string,
  opts: { name?: string; now?: number } = {},
): Promise<MemoryBackupResult> {
  const root = resolve(rootDir);
  const memoryDir = join(root, ".red/memory");
  const config = await requireMemoryConfig(root);
  const name = sanitizeBackupName(opts.name ?? timestampName(opts.now));
  const backupDir = join(memoryDir, BACKUPS_DIR, name);
  const dataDir = join(backupDir, "data");
  const warnings = [
    "restore should be run only when Memory MCP/agent processes are stopped",
  ];

  await mkdir(dataDir, { recursive: true });
  const files = await listMemoryFiles(memoryDir);
  const copied: MemoryBackupFile[] = [];
  for (const file of files) {
    // The config now lives in `.red/config.yaml` (ADR 0042), not under
    // `.red/memory`. We synthesize a self-contained `config.toon` snapshot
    // below from the resolved config, so skip any legacy in-tree copy to avoid
    // a duplicate manifest entry.
    if (file === "config.json" || file === "config.toon") continue;
    const src = join(memoryDir, file);
    const dest = join(dataDir, file);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    copied.push(await fileManifest(dataDir, file));
  }

  // Embed a normalized config snapshot so the backup is self-contained and the
  // manifest is stable regardless of where the live config is stored.
  await writeMemoryStateFile(join(dataDir, "config.toon"), config);
  copied.push(await fileManifest(dataDir, "config.toon"));

  const manifest: MemoryBackupManifest = {
    schema_version: "memory.backup.v1",
    name,
    root,
    created_at: new Date(opts.now ?? Date.now()).toISOString(),
    mode: config.mode,
    store_path: config.storePath ?? (config.mode === "graph" ? DEFAULT_STORE_PATH : null),
    files: copied,
    warnings,
  };
  const manifestPath = join(backupDir, MANIFEST);
  await writeMemoryStateFile(manifestPath, manifest);
  return {
    manifest,
    backup_dir: backupDir,
    manifest_path: manifestPath,
    files: copied.length,
    bytes: copied.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export async function listMemoryBackups(rootDir: string): Promise<MemoryBackupListEntry[]> {
  const backupsRoot = join(resolve(rootDir), ".red/memory", BACKUPS_DIR);
  let entries: string[];
  try {
    entries = await readdir(backupsRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const out: MemoryBackupListEntry[] = [];
  for (const entry of entries) {
    const backupDir = join(backupsRoot, entry);
    const info = await stat(backupDir).catch(() => null);
    if (!info?.isDirectory()) continue;
    const manifest = await readMemoryBackupManifest(rootDir, entry).catch(() => null);
    if (!manifest) continue;
    out.push({
      name: manifest.name,
      backup_dir: backupDir,
      created_at: manifest.created_at,
      mode: manifest.mode,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
      warnings: manifest.warnings,
    });
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function readMemoryBackupManifest(
  rootDir: string,
  name: string,
): Promise<MemoryBackupManifest> {
  const backupDir = backupPath(rootDir, name);
  const manifest = await readBackupManifestFile(backupDir);
  if (manifest.schema_version !== "memory.backup.v1") {
    throw new Error(`unsupported Memory backup manifest in ${backupDir}`);
  }
  return manifest;
}

async function readBackupManifestFile(backupDir: string): Promise<MemoryBackupManifest> {
  try {
    return await readMemoryStateFile<MemoryBackupManifest>(join(backupDir, MANIFEST));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return readMemoryStateFile<MemoryBackupManifest>(join(backupDir, LEGACY_MANIFEST));
}

export async function restoreMemoryBackup(
  rootDir: string,
  name: string,
  opts: { now?: number; safetyName?: string } = {},
): Promise<MemoryRestoreResult> {
  const root = resolve(rootDir);
  const memoryDir = join(root, ".red/memory");
  const backupDir = backupPath(root, name);
  const dataDir = join(backupDir, "data");
  const manifest = await readMemoryBackupManifest(root, name);
  for (const file of manifest.files) {
    const actual = await fileManifest(dataDir, file.path);
    if (actual.sha256 !== file.sha256 || actual.bytes !== file.bytes) {
      throw new Error(`backup file verification failed for ${file.path}`);
    }
  }
  const safety = await createMemoryBackup(root, {
    name: opts.safetyName ?? `pre-restore-${timestampName(opts.now)}`,
    now: opts.now,
  });

  await clearMemoryDirForRestore(memoryDir);
  for (const file of manifest.files) {
    const src = join(dataDir, file.path);
    const dest = join(memoryDir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
  }

  return {
    restored_from: manifest.name,
    restored_files: manifest.files.length,
    restored_bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
    safety_backup: safety,
    warnings: manifest.warnings,
  };
}

async function requireMemoryConfig(rootDir: string): Promise<MemoryConfig> {
  const config = await readConfig(rootDir);
  if (!config) throw new Error("memory is not initialized here — run `memory init` first");
  return config;
}

async function listMemoryFiles(memoryDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (dir === memoryDir && entry.name === BACKUPS_DIR) continue;
      const abs = join(dir, entry.name);
      const rel = relative(memoryDir, abs);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(memoryDir);
  return out.sort();
}

async function clearMemoryDirForRestore(memoryDir: string): Promise<void> {
  await mkdir(memoryDir, { recursive: true });
  for (const entry of await readdir(memoryDir, { withFileTypes: true })) {
    if (entry.name === BACKUPS_DIR) continue;
    await rm(join(memoryDir, entry.name), { recursive: true, force: true });
  }
}

async function fileManifest(baseDir: string, relPath: string): Promise<MemoryBackupFile> {
  const path = join(baseDir, relPath);
  const body = await readFile(path);
  return {
    path: relPath,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
}

function backupPath(rootDir: string, name: string): string {
  return join(resolve(rootDir), ".red/memory", BACKUPS_DIR, sanitizeBackupName(basename(name)));
}

function sanitizeBackupName(value: string): string {
  const name = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new Error("backup name cannot be empty");
  return name.slice(0, 120);
}

function timestampName(now = Date.now()): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}
