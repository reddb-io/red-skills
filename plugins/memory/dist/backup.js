import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DEFAULT_STORE_PATH, readConfig } from "./config.js";
const MANIFEST = "manifest.json";
const BACKUPS_DIR = "backups";
export async function createMemoryBackup(rootDir, opts = {}) {
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
    const copied = [];
    for (const file of files) {
        const src = join(memoryDir, file);
        const dest = join(dataDir, file);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
        copied.push(await fileManifest(dataDir, file));
    }
    const manifest = {
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
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return {
        manifest,
        backup_dir: backupDir,
        manifest_path: manifestPath,
        files: copied.length,
        bytes: copied.reduce((sum, file) => sum + file.bytes, 0),
    };
}
export async function listMemoryBackups(rootDir) {
    const backupsRoot = join(resolve(rootDir), ".red/memory", BACKUPS_DIR);
    let entries;
    try {
        entries = await readdir(backupsRoot);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return [];
        throw err;
    }
    const out = [];
    for (const entry of entries) {
        const backupDir = join(backupsRoot, entry);
        const info = await stat(backupDir).catch(() => null);
        if (!info?.isDirectory())
            continue;
        const manifest = await readMemoryBackupManifest(rootDir, entry).catch(() => null);
        if (!manifest)
            continue;
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
export async function readMemoryBackupManifest(rootDir, name) {
    const backupDir = backupPath(rootDir, name);
    const manifest = JSON.parse(await readFile(join(backupDir, MANIFEST), "utf8"));
    if (manifest.schema_version !== "memory.backup.v1") {
        throw new Error(`unsupported Memory backup manifest in ${backupDir}`);
    }
    return manifest;
}
export async function restoreMemoryBackup(rootDir, name, opts = {}) {
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
async function requireMemoryConfig(rootDir) {
    const config = await readConfig(rootDir);
    if (!config)
        throw new Error("memory is not initialized here — run `memory init` first");
    return config;
}
async function listMemoryFiles(memoryDir) {
    const out = [];
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (dir === memoryDir && entry.name === BACKUPS_DIR)
                continue;
            const abs = join(dir, entry.name);
            const rel = relative(memoryDir, abs);
            if (entry.isDirectory()) {
                await walk(abs);
            }
            else if (entry.isFile()) {
                out.push(rel);
            }
        }
    }
    await walk(memoryDir);
    return out.sort();
}
async function clearMemoryDirForRestore(memoryDir) {
    await mkdir(memoryDir, { recursive: true });
    for (const entry of await readdir(memoryDir, { withFileTypes: true })) {
        if (entry.name === BACKUPS_DIR)
            continue;
        await rm(join(memoryDir, entry.name), { recursive: true, force: true });
    }
}
async function fileManifest(baseDir, relPath) {
    const path = join(baseDir, relPath);
    const body = await readFile(path);
    return {
        path: relPath,
        bytes: body.byteLength,
        sha256: createHash("sha256").update(body).digest("hex"),
    };
}
function backupPath(rootDir, name) {
    return join(resolve(rootDir), ".red/memory", BACKUPS_DIR, sanitizeBackupName(basename(name)));
}
function sanitizeBackupName(value) {
    const name = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!name)
        throw new Error("backup name cannot be empty");
    return name.slice(0, 120);
}
function timestampName(now = Date.now()) {
    return new Date(now).toISOString().replace(/[:.]/g, "-");
}
