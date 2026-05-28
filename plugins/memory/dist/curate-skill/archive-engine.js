/**
 * archive-engine — moves an approved Curatable skill into a project-local
 * archive area with a manifest, and reverses the move on restore.
 *
 * Safety guarantees, encoded in code (not only docs):
 *
 *   1. The engine NEVER calls a destructive filesystem operation. It uses
 *      `rename` (atomic mv) to relocate the skill directory and writes a
 *      manifest sidecar; it never imports or invokes `unlink`, `rm`, `rmdir`,
 *      `rmSync`, or any equivalent. A test enforces this by injecting a
 *      filesystem facade whose destructive members throw on call.
 *
 *   2. Bundled read-only skills (`source_kind` in {plugin, hub}) and pinned
 *      skills are refused before any I/O — no path is touched, no manifest
 *      is written, no directory is created. The refusal is returned as a
 *      structured rejection.
 *
 *   3. Restoration is bit-exact: the manifest records SHA-256 + byte length
 *      for every file under the archived skill, and `executeRestore`
 *      verifies every restored file's hash against the manifest before the
 *      receipt is returned.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { READ_ONLY_SOURCE_KINDS, } from "./types.js";
export const defaultArchiveFs = {
    mkdir: async (p, opts) => {
        await mkdir(p, opts);
    },
    rename: (src, dst) => rename(src, dst),
    readFile: (p) => readFile(p),
    writeFile: (p, d) => writeFile(p, d),
    readdir: (p, opts) => readdir(p, opts),
    stat: (p) => stat(p),
    access: (p) => access(p),
};
const DEFAULT_ARCHIVE_DIR = ".red/memory/skill-archive";
function resolveOptions(opts) {
    return {
        rootDir: opts.rootDir,
        archiveBaseDir: join(opts.rootDir, opts.archiveDir ?? DEFAULT_ARCHIVE_DIR),
        now: opts.now ?? (() => new Date()),
        fs: opts.fs ?? defaultArchiveFs,
    };
}
/**
 * Refuse pinned / read-only inputs with a structured rejection. No filesystem
 * call is made before this gate clears.
 */
export function validateCandidate(c) {
    if (!c.name) {
        return { name: c.name ?? "<unnamed>", reason: "missing-name", detail: "candidate has no name" };
    }
    if (!c.path) {
        return { name: c.name, reason: "missing-path", detail: "candidate has no path" };
    }
    if (READ_ONLY_SOURCE_KINDS.has(c.source_kind)) {
        return {
            name: c.name,
            reason: "read-only-source-kind",
            detail: `source_kind=${c.source_kind} is bundled read-only content (plugin/hub)`,
        };
    }
    if (c.pinned === true) {
        return { name: c.name, reason: "pinned", detail: "skill is marked pinned" };
    }
    return null;
}
async function pathExists(fs, p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
async function walkFiles(fs, root, relPath = "") {
    const entries = await fs.readdir(join(root, relPath), { withFileTypes: true });
    const out = [];
    for (const ent of entries) {
        const next = relPath ? `${relPath}${sep}${ent.name}` : ent.name;
        if (ent.isDirectory()) {
            out.push(...(await walkFiles(fs, root, next)));
        }
        else if (ent.isFile()) {
            const data = await fs.readFile(join(root, next));
            out.push({
                relativePath: next.split(sep).join("/"),
                sha256: createHash("sha256").update(data).digest("hex"),
                byteLength: data.byteLength,
            });
        }
    }
    return out;
}
/**
 * Archive one approved candidate. Returns either a rejection (no I/O performed)
 * or a receipt describing the move + manifest.
 */
export async function executeArchive(candidate, options) {
    const rej = validateCandidate(candidate);
    if (rej)
        return { ok: false, rejection: rej };
    const { archiveBaseDir, now, fs } = resolveOptions(options);
    const originalRoot = dirname(candidate.path);
    const skillFileRelative = candidate.path.slice(originalRoot.length + 1) || "SKILL.md";
    const archiveRoot = join(archiveBaseDir, candidate.name);
    const payloadRoot = join(archiveRoot, "payload");
    if (await pathExists(fs, archiveRoot)) {
        throw new Error(`refusing to clobber existing archive at ${archiveRoot} — restore or rename first`);
    }
    const files = await walkFiles(fs, originalRoot);
    await fs.mkdir(archiveRoot, { recursive: true });
    await fs.rename(originalRoot, payloadRoot);
    const manifest = {
        name: candidate.name,
        originalRoot,
        skillFileRelative,
        source_kind: candidate.source_kind,
        archivedAt: now().toISOString(),
        category: candidate.category,
        reason: candidate.reason,
        files,
    };
    const manifestPath = join(archiveRoot, "manifest.json");
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return {
        ok: true,
        receipt: {
            name: candidate.name,
            originalRoot,
            archiveRoot,
            manifestPath,
            files,
        },
    };
}
/**
 * Restore one archived skill, verifying every file's SHA-256 against the
 * manifest. The archive manifest is intentionally left in place after restore
 * (the engine never calls a destructive op) — it is a record, not garbage.
 */
export async function executeRestore(name, options) {
    const { archiveBaseDir, fs } = resolveOptions(options);
    const archiveRoot = join(archiveBaseDir, name);
    const manifestPath = join(archiveRoot, "manifest.json");
    const payloadRoot = join(archiveRoot, "payload");
    const manifestRaw = (await fs.readFile(manifestPath)).toString("utf8");
    const manifest = JSON.parse(manifestRaw);
    if (await pathExists(fs, manifest.originalRoot)) {
        throw new Error(`refusing to overwrite live skill at ${manifest.originalRoot} — move it aside first`);
    }
    await fs.mkdir(dirname(manifest.originalRoot), { recursive: true });
    await fs.rename(payloadRoot, manifest.originalRoot);
    for (const file of manifest.files) {
        const filePath = join(manifest.originalRoot, ...file.relativePath.split("/"));
        const data = await fs.readFile(filePath);
        const sha = createHash("sha256").update(data).digest("hex");
        if (sha !== file.sha256) {
            throw new Error(`restored file ${file.relativePath} hash mismatch — expected ${file.sha256}, got ${sha}`);
        }
        if (data.byteLength !== file.byteLength) {
            throw new Error(`restored file ${file.relativePath} size mismatch — expected ${file.byteLength}, got ${data.byteLength}`);
        }
    }
    return {
        name,
        archiveRoot,
        restoredRoot: manifest.originalRoot,
        files: manifest.files,
    };
}
/** Surfaces the resolved archive base directory for the CLI. */
export function archiveBaseFor(options) {
    return resolveOptions(options).archiveBaseDir;
}
/** Re-export the relative helper for tests that want to assert paths. */
export const __pathRelative = relative;
