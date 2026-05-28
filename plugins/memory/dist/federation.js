/**
 * Federation cross-root read — adds privacy policy + skill-telemetry (issue #170).
 *
 * Reads markdown memory notes across multiple configured roots and returns a
 * merged, ranked list. A redaction policy (`redact:` block in
 * `.red/memory/federation.yaml`) is applied at read time — never at storage.
 * Fields listed in `redact.fields` are masked on every result; origins listed
 * in `redact.scopes` are dropped entirely. Each surviving result carries
 * `confidence_local` (normalized from the local recall score), `confidence_remote`
 * (per-origin trust from the policy, default 0.5), and `redacted_fields[]`.
 *
 * A skill-telemetry event `memory.federation.read` is emitted once per query
 * through an optional callback so callers (workbench, CLI) can record usage
 * without coupling the surface to the skill-events store.
 *
 * Default-deny: if `redact:` is present but malformed, the parser substitutes
 * a deny-all policy that masks every documented field and drops every origin.
 * No data may ever leak from a malformed policy.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { readConfig, resolveNotesDir } from "./config.js";
import { recall } from "./recall.js";
/** Fields on a `FederationResult` that may be referenced by a redact policy. */
export const REDACTABLE_FIELDS = ["excerpt", "path", "id"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_PER_ROOT_LIMIT = 10;
const DEFAULT_REMOTE_TRUST = 0.5;
const EMPTY_REDACT = { fields: [], scopes: [] };
/** Absolute path to the federation config file for a repo root. */
export function federationConfigPath(rootDir) {
    return resolve(rootDir, ".red/memory/federation.yaml");
}
/**
 * Build the deny-all fallback. Returned whenever the redact block is present
 * but unparseable — we mask every documented field and drop every configured
 * origin so a malformed policy can never leak data.
 */
export function denyAllRedactPolicy(roots) {
    return {
        fields: [...REDACTABLE_FIELDS],
        scopes: roots.map((r) => r.repo),
        defaultDeny: true,
    };
}
/**
 * Read `.red/memory/federation.yaml`. Returns `null` when the file is missing
 * so the federation surface can return an empty report gracefully. Throws on
 * malformed top-level structure (roots: block) so config bugs surface immediately;
 * the redact/trust blocks degrade to default-deny / empty respectively when
 * malformed, so policy-corruption never leaks data.
 */
export async function loadFederationConfig(rootDir) {
    let raw;
    try {
        raw = await readFile(federationConfigPath(rootDir), "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return null;
        throw err;
    }
    return parseFederationYaml(raw);
}
/**
 * YAML parser tuned for the federation config shape — `roots:`, `redact:`,
 * `trust:` top-level blocks. Avoids a full YAML dependency. Throws on a
 * malformed `roots:` list; degrades the `redact:` block to default-deny and
 * the `trust:` block to empty when those individual blocks are malformed.
 */
export function parseFederationYaml(raw) {
    const lines = raw.split(/\r?\n/);
    const roots = [];
    let inRoots = false;
    let currentRoot = null;
    // Block buffers
    let redactBlock = null;
    let trustBlock = null;
    let section = "none";
    const flushRoot = () => {
        if (!currentRoot)
            return;
        if (typeof currentRoot.repo !== "string" || currentRoot.repo.length === 0) {
            throw new Error(`federation.yaml: root entry missing "repo"`);
        }
        if (typeof currentRoot.path !== "string" || currentRoot.path.length === 0) {
            throw new Error(`federation.yaml: root entry "${currentRoot.repo}" missing "path"`);
        }
        roots.push({ repo: currentRoot.repo, path: currentRoot.path });
        currentRoot = null;
    };
    for (const rawLine of lines) {
        const noComment = rawLine.replace(/#.*$/, "").trimEnd();
        if (noComment.trim().length === 0)
            continue;
        // Top-level header detection (no leading indent).
        if (/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*$/.test(noComment)) {
            flushRoot();
            const name = noComment.replace(/\s*:\s*$/, "").trim();
            if (name === "roots") {
                section = "roots";
                inRoots = true;
                continue;
            }
            if (name === "redact") {
                section = "redact";
                redactBlock = { lines: [] };
                continue;
            }
            if (name === "trust") {
                section = "trust";
                trustBlock = { lines: [] };
                continue;
            }
            section = "none";
            continue;
        }
        if (section === "roots") {
            const itemMatch = noComment.match(/^\s*-\s*(.*)$/);
            if (itemMatch) {
                flushRoot();
                currentRoot = {};
                const after = itemMatch[1]?.trim() ?? "";
                if (after.length > 0) {
                    applyRootKv(currentRoot, after);
                }
                continue;
            }
            if (currentRoot) {
                applyRootKv(currentRoot, noComment.trim());
            }
            continue;
        }
        if (section === "redact" && redactBlock) {
            redactBlock.lines.push(noComment);
            continue;
        }
        if (section === "trust" && trustBlock) {
            trustBlock.lines.push(noComment);
            continue;
        }
        // Outside any known section — ignore. (Pre-roots commentary already caught above.)
    }
    flushRoot();
    void inRoots;
    const redact = redactBlock ? parseRedactBlock(redactBlock.lines, roots) : { ...EMPTY_REDACT };
    const trust = trustBlock ? parseTrustBlock(trustBlock.lines) : {};
    return { roots, redact, trust };
}
function parseRedactBlock(blockLines, roots) {
    try {
        let fields = null;
        let scopes = null;
        let current = null;
        let inlineHandled = false;
        for (const raw of blockLines) {
            const trimmed = raw.trim();
            const inlineList = raw.match(/^\s*(fields|scopes)\s*:\s*\[(.*)\]\s*$/);
            if (inlineList) {
                const key = inlineList[1];
                const list = inlineList[2]
                    .split(",")
                    .map((s) => unquote(s.trim()))
                    .filter((s) => s.length > 0);
                if (key === "fields")
                    fields = list;
                else
                    scopes = list;
                current = null;
                inlineHandled = true;
                continue;
            }
            const keyHeader = raw.match(/^\s*(fields|scopes)\s*:\s*$/);
            if (keyHeader) {
                current = keyHeader[1];
                if (current === "fields" && fields == null)
                    fields = [];
                if (current === "scopes" && scopes == null)
                    scopes = [];
                continue;
            }
            const itemMatch = raw.match(/^\s*-\s*(.*)$/);
            if (itemMatch && current) {
                const value = unquote(itemMatch[1].trim());
                if (value.length === 0)
                    continue;
                if (current === "fields")
                    fields.push(value);
                else
                    scopes.push(value);
                continue;
            }
            if (trimmed.length > 0 && !inlineHandled) {
                throw new Error(`federation.yaml: malformed redact entry: ${trimmed}`);
            }
        }
        if (fields == null && scopes == null && blockLines.length > 0) {
            throw new Error("federation.yaml: redact block declared but empty");
        }
        const finalFields = (fields ?? []).filter((f) => REDACTABLE_FIELDS.includes(f));
        return {
            fields: finalFields,
            scopes: scopes ?? [],
        };
    }
    catch {
        return denyAllRedactPolicy(roots);
    }
}
function parseTrustBlock(blockLines) {
    const out = {};
    for (const raw of blockLines) {
        const match = raw.match(/^\s*([A-Za-z0-9_./-]+)\s*:\s*([0-9.]+)\s*$/);
        if (!match)
            continue;
        const repo = match[1];
        const value = Number(match[2]);
        if (Number.isFinite(value)) {
            out[repo] = Math.max(0, Math.min(1, value));
        }
    }
    return out;
}
function applyRootKv(target, fragment) {
    const match = fragment.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!match)
        return;
    const key = match[1];
    const value = unquote((match[2] ?? "").trim());
    if (key === "repo")
        target.repo = value;
    else if (key === "path")
        target.path = value;
}
function unquote(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
/**
 * Compose a federation report by querying each configured root and applying
 * the redaction policy at read time. Dropped roots (matched by `redact.scopes`)
 * are surfaced with `status: "dropped-by-policy"` and zero hits. Surviving
 * results get `confidence_local`, `confidence_remote`, and `redacted_fields[]`.
 * The `onTelemetry` callback (if provided) fires once per query.
 */
export async function buildFederationReport(rootDir, query, opts = {}) {
    const trimmedQuery = query.trim();
    const limit = clampLimit(opts.limit, DEFAULT_LIMIT, MAX_LIMIT);
    const perRootLimit = clampLimit(opts.perRootLimit, DEFAULT_PER_ROOT_LIMIT, MAX_LIMIT);
    const generatedAt = new Date(opts.now ?? Date.now()).toISOString();
    const config = opts.config !== undefined ? opts.config : await loadFederationConfig(rootDir);
    if (!config || config.roots.length === 0 || trimmedQuery.length === 0) {
        return {
            schema_version: "memory.federation.v1",
            read_only: true,
            query: trimmedQuery,
            generated_at: generatedAt,
            limit,
            roots_queried: 0,
            roots: [],
            results: [],
            policy: {
                fields: config?.redact.fields ?? [],
                scopes: config?.redact.scopes ?? [],
                default_deny: config?.redact.defaultDeny ?? false,
            },
        };
    }
    const droppedScopes = new Set(config.redact.scopes);
    const rootStatuses = [];
    const rawHitsByRoot = [];
    for (const root of config.roots) {
        const absRoot = isAbsolute(root.path) ? root.path : resolve(rootDir, root.path);
        if (droppedScopes.has(root.repo)) {
            rootStatuses.push({
                origin_repo: root.repo,
                path: absRoot,
                status: "dropped-by-policy",
                hits: 0,
            });
            continue;
        }
        const status = {
            origin_repo: root.repo,
            path: absRoot,
            status: "ok",
            hits: 0,
        };
        try {
            const cfg = await readConfig(absRoot);
            if (!cfg) {
                status.status = "missing-config";
                rootStatuses.push(status);
                continue;
            }
            const notesDir = resolveNotesDir(absRoot, cfg);
            const hits = await recall(notesDir, trimmedQuery, perRootLimit);
            status.hits = hits.length;
            rootStatuses.push(status);
            rawHitsByRoot.push({ root, hits });
        }
        catch (err) {
            status.status = "error";
            status.error = err instanceof Error ? err.message : String(err);
            rootStatuses.push(status);
        }
    }
    // Normalize confidence_local using the global max raw score across all roots.
    const maxScore = rawHitsByRoot.reduce((m, entry) => entry.hits.reduce((mm, h) => Math.max(mm, h.score), m), 0);
    const merged = [];
    for (const { root, hits } of rawHitsByRoot) {
        const remoteTrust = clamp01(config.trust[root.repo] ?? DEFAULT_REMOTE_TRUST);
        for (const hit of hits) {
            const confidenceLocal = maxScore > 0 ? clamp01(hit.score / maxScore) : 0;
            merged.push(applyRedaction({
                origin_repo: root.repo,
                id: hit.id,
                score: hit.score,
                excerpt: hit.excerpt,
                path: hit.path,
                confidence_local: round3(confidenceLocal),
                confidence_remote: round3(remoteTrust),
                redacted_fields: [],
            }, config.redact.fields));
        }
    }
    merged.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        const repoCmp = a.origin_repo.localeCompare(b.origin_repo);
        if (repoCmp !== 0)
            return repoCmp;
        return (a.id ?? "").localeCompare(b.id ?? "");
    });
    const sliced = merged.slice(0, limit);
    const report = {
        schema_version: "memory.federation.v1",
        read_only: true,
        query: trimmedQuery,
        generated_at: generatedAt,
        limit,
        roots_queried: config.roots.length,
        roots: rootStatuses,
        results: sliced,
        policy: {
            fields: [...config.redact.fields],
            scopes: [...config.redact.scopes],
            default_deny: config.redact.defaultDeny ?? false,
        },
    };
    if (opts.onTelemetry) {
        await opts.onTelemetry({
            event: "memory.federation.read",
            query: trimmedQuery,
            generated_at: generatedAt,
            roots_queried: config.roots.length,
            results_count: sliced.length,
            redacted_fields: [...config.redact.fields],
            dropped_scopes: [...config.redact.scopes],
            default_deny: config.redact.defaultDeny ?? false,
        });
    }
    return report;
}
function applyRedaction(result, fields) {
    if (fields.length === 0)
        return result;
    const masked = { ...result };
    const redacted = [];
    for (const field of fields) {
        if (field === "excerpt" && masked.excerpt !== null) {
            masked.excerpt = null;
            redacted.push("excerpt");
        }
        else if (field === "path" && masked.path !== null) {
            masked.path = null;
            redacted.push("path");
        }
        else if (field === "id" && masked.id !== null) {
            masked.id = null;
            redacted.push("id");
        }
    }
    masked.redacted_fields = redacted;
    return masked;
}
function clamp01(value) {
    if (!Number.isFinite(value))
        return 0;
    if (value < 0)
        return 0;
    if (value > 1)
        return 1;
    return value;
}
function round3(value) {
    return Math.round(value * 1000) / 1000;
}
function clampLimit(value, fallback, max) {
    if (value == null || !Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(1, Math.trunc(value)));
}
