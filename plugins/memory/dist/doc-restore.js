import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
export async function restoreDocsFromMemory(store, opts) {
    const root = resolve(opts.rootDir);
    const inPlace = opts.inPlace === true;
    const dryRun = opts.dryRun === true;
    const overwrite = opts.overwrite === true;
    const outDir = inPlace ? null : resolve(root, opts.outDir ?? ".red/memory/restored-docs");
    const docs = selectDocs(await store.listDocs(), opts);
    const items = [];
    if (docs.length === 0 && (opts.targetPath || opts.targetRid != null)) {
        items.push({
            rid: opts.targetRid ?? 0,
            source_path: opts.targetPath ?? "",
            destination_path: "",
            title: null,
            body_bytes: 0,
            status: "missing",
            reason: "no indexed document matched the requested path or rid",
        });
    }
    for (const doc of docs) {
        const destination = destinationForDoc(doc, root, outDir, inPlace);
        if (destination == null) {
            items.push(itemForDoc(doc, "", "skipped", "original path is outside root; use --out instead"));
            continue;
        }
        if (!overwrite && await exists(destination)) {
            items.push(itemForDoc(doc, destination, "skipped", "destination exists; pass --overwrite to replace it"));
            continue;
        }
        if (dryRun) {
            items.push(itemForDoc(doc, destination, "planned", null));
            continue;
        }
        await mkdir(dirnamePath(destination), { recursive: true });
        await writeFile(destination, doc.body, "utf8");
        items.push(itemForDoc(doc, destination, "restored", null));
    }
    return {
        schema_version: "memory.doc_restore.v1",
        dry_run: dryRun,
        in_place: inPlace,
        overwrite,
        root,
        out_dir: outDir,
        requested: {
            path: opts.targetPath ?? null,
            rid: opts.targetRid ?? null,
        },
        summary: summarize(items),
        items,
        recommended_next_actions: recommendations(items, dryRun),
    };
}
function selectDocs(docs, opts) {
    if (opts.targetRid != null)
        return docs.filter((doc) => doc.rid === opts.targetRid);
    if (opts.targetPath)
        return docs.filter((doc) => doc.path === opts.targetPath);
    return docs;
}
function destinationForDoc(doc, root, outDir, inPlace) {
    const source = resolve(doc.path);
    if (inPlace)
        return insideRoot(source, root) ? source : null;
    const relativePath = insideRoot(source, root)
        ? relative(root, source)
        : join("external", sanitizePath(doc.path || basename(source) || `doc-${doc.rid}.md`));
    return resolve(outDir ?? root, relativePath);
}
function itemForDoc(doc, destination, status, reason) {
    return {
        rid: doc.rid,
        source_path: doc.path,
        destination_path: destination,
        title: doc.title ?? null,
        body_bytes: Buffer.byteLength(doc.body, "utf8"),
        status,
        reason,
    };
}
function summarize(items) {
    return {
        matched_docs: items.filter((item) => item.status !== "missing").length,
        planned: items.filter((item) => item.status === "planned").length,
        restored: items.filter((item) => item.status === "restored").length,
        skipped: items.filter((item) => item.status === "skipped").length,
        missing: items.filter((item) => item.status === "missing").length,
        bytes: items
            .filter((item) => item.status === "planned" || item.status === "restored")
            .reduce((sum, item) => sum + item.body_bytes, 0),
    };
}
function recommendations(items, dryRun) {
    const actions = [];
    if (dryRun && items.some((item) => item.status === "planned")) {
        actions.push("rerun with `--yes` to restore the planned document files");
    }
    if (items.some((item) => item.reason?.includes("destination exists"))) {
        actions.push("pass `--overwrite` only when replacing the destination file is intended");
    }
    if (items.some((item) => item.reason?.includes("outside root"))) {
        actions.push("use `--out <dir>` to restore external indexed docs into a safe export directory");
    }
    if (items.some((item) => item.status === "missing")) {
        actions.push("run `memory docs search <query>` to find the stored document path or rid");
    }
    if (actions.length === 0)
        actions.push("document restore completed");
    return actions;
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}
function insideRoot(path, root) {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
function sanitizePath(path) {
    const cleaned = path.replaceAll("\\", "/").replace(/[^A-Za-z0-9._/-]+/g, "_");
    return cleaned.replace(/^\/+/, "").replace(/\.\./g, "_") || "document.md";
}
function dirnamePath(path) {
    const index = path.lastIndexOf("/");
    return index === -1 ? "." : path.slice(0, index);
}
