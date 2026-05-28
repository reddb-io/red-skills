/**
 * Reasoning attempt writer — the Memory-side path for recording one AFK
 * terminal attempt as a graph object. PRD #95.
 *
 * Writes:
 *   - one `attempt` node (defaulting to `reasoning` tier),
 *   - one minimal `issue` node (created or reused),
 *   - one minimal `prd` node when the issue body explicitly declares a parent
 *     PRD via `prd: #N` or `parent-prd: #N` (and the matching `prd CONTAINS
 *     issue` edge),
 *   - one `CONTAINS` edge: issue → attempt,
 *   - deterministic `PRECEDES` edges chaining same-issue attempts in
 *     attempt-number order,
 *   - one minimal `file` node per touched path (created or reused), and
 *   - one `TOUCHED` edge per file: attempt → file.
 *
 * Parent PRDs are only recognised from an explicit `prd: #N` / `parent-prd: #N`
 * marker line in the issue body. Labels, title text, comments, issue links,
 * and branch names are *not* parsed — the writer never infers a parent PRD
 * from weak signals.
 *
 * Re-recording the same attempt is idempotent: identity hashes for the
 * attempt, the issue, the PRD, and each file node are stable functions of the
 * work-item coordinates, and edges dedupe by (from, to, label). No ingest,
 * reindex, or codebase scan runs here — minimal file nodes are bare
 * placeholders that a later `/memory:ingest` may enrich with symbols and code
 * edges.
 */
import { contentHash } from "../hash.js";
/**
 * Record one structured AFK reasoning attempt into the Memory graph.
 *
 * Idempotent: the attempt, issue, and file nodes all have stable identity
 * hashes derived from AFK metadata (not from observational evidence), so a
 * second call with the same identity reuses the same rids; edge dedupe in
 * {@link MemoryStore.upsertEdge} guarantees no duplicate `CONTAINS` or
 * `TOUCHED` rows. The writer does **not** call `/memory:ingest` or trigger any
 * file scan — minimal `file` nodes carry only their path.
 */
export async function recordReasoningAttempt(store, payload) {
    // Parse the parent PRD strictly from the issue body — no inference from
    // labels, title text, comments, links, or branch names is permitted (AC #3).
    const parentPrd = parseParentPrdFromBody(payload.issueBody);
    const issueLabel = issueNodeLabel(payload.repository, payload.issueNumber);
    const issueNode = {
        label: issueLabel,
        node_type: "issue",
        properties: {
            title: payload.issueTitle ?? issueLabel,
            repository: payload.repository,
            issue_number: payload.issueNumber,
            url: payload.issueUrl,
            source: "github-issues",
            // Normalised parent PRD reference (AC #1). Only set when an explicit
            // marker was parsed; weak signals never land here.
            ...(parentPrd != null ? { parent_prd: parentPrd } : {}),
            // Pinned identity hash so observational refinements (a title update on a
            // later attempt, say) reuse the same `issue` node instead of forking it.
            hash: contentHash("issue", payload.repository, String(payload.issueNumber)),
        },
    };
    const issueRid = await store.upsertNode(issueNode);
    // Parent PRD hierarchy (AC #2, #4). Only created when the issue body
    // declared an explicit marker — `upsertNode` and `upsertEdge` make this
    // idempotent across re-records.
    let prdRid;
    let prdContainsIssueEdge;
    if (parentPrd != null) {
        const prdLabel = prdNodeLabel(payload.repository, parentPrd);
        const prdNode = {
            label: prdLabel,
            node_type: "prd",
            properties: {
                title: prdLabel,
                repository: payload.repository,
                prd_number: parentPrd,
                source: "github-issues",
                hash: contentHash("prd", payload.repository, String(parentPrd)),
            },
        };
        prdRid = await store.upsertNode(prdNode);
        prdContainsIssueEdge = await store.upsertEdge({
            label: "CONTAINS",
            from_rid: prdRid,
            to_rid: issueRid,
        });
    }
    const touched = dedupeTouchedFiles(payload.touchedFiles);
    const hooks = normaliseHookRecords(payload.hooks);
    const attemptLabel = attemptNodeLabel(payload.repository, payload.issueNumber, payload.attemptNumber, payload.workerId);
    const attemptNode = {
        label: attemptLabel,
        node_type: "attempt",
        properties: {
            title: payload.summary ?? attemptLabel,
            content: payload.summary,
            repository: payload.repository,
            issue_number: payload.issueNumber,
            attempt_number: payload.attemptNumber,
            worker_id: payload.workerId,
            ...(parentPrd != null ? { parent_prd: parentPrd } : {}),
            status: payload.status,
            branch: payload.branch,
            duration_ms: payload.durationMs,
            diffstat: payload.diffstat,
            envelope_ref: payload.envelopeRef,
            envelope_hash: payload.envelopeHash,
            merge_commit: payload.mergeCommit,
            failure_branch: payload.failureBranch,
            touched_files: touched,
            notes: payload.notes,
            error_class: payload.errorClass,
            validation_summary: payload.validationSummary,
            // Only set when at least one user hook executed (issue #216). Absent
            // property + normalised array contract keeps recall surfaces from
            // rendering an empty section for projects with no user hooks declared.
            ...(hooks.length > 0 ? { hooks } : {}),
            summary: payload.summary,
            source: "afk",
            // Identity is the AFK attempt coordinates plus envelope hash when known.
            // Re-recording the same terminal attempt — even with new notes — reuses
            // this rid; a fresh attempt number or worker id forks a new node.
            hash: contentHash("attempt", payload.repository, String(payload.issueNumber), String(payload.attemptNumber), payload.workerId ?? "", payload.envelopeHash ?? ""),
        },
    };
    const attemptRid = await store.upsertNode(attemptNode);
    // Work hierarchy: issue CONTAINS attempt. The parent PRD edge (when
    // present) is the separate `prd CONTAINS issue` written above.
    const containsEdge = await store.upsertEdge({
        label: "CONTAINS",
        from_rid: issueRid,
        to_rid: attemptRid,
    });
    const fileRids = [];
    const touchedEdges = [];
    for (const path of touched) {
        const fileNode = {
            label: fileNodeLabel(path),
            node_type: "file",
            properties: {
                title: path,
                source: path,
                // Identity hash uses the path only — a later `/memory:ingest` pass
                // enriches this node with symbols/edges without forking it, because
                // ingest produces the same hash for the same path (see extract-code).
                hash: contentHash("file", path),
            },
        };
        const fileRid = await store.upsertNode(fileNode);
        fileRids.push(fileRid);
        touchedEdges.push(await store.upsertEdge({
            label: "TOUCHED",
            from_rid: attemptRid,
            to_rid: fileRid,
        }));
    }
    const validations = normaliseValidationRecords(payload.validationRecords);
    const validationRids = [];
    const testedByEdges = [];
    for (const record of validations) {
        const validationNode = {
            label: validationNodeLabel(payload.repository, payload.issueNumber, payload.attemptNumber, record.name),
            node_type: "validation",
            properties: {
                title: record.name,
                repository: payload.repository,
                issue_number: payload.issueNumber,
                attempt_number: payload.attemptNumber,
                worker_id: payload.workerId,
                name: record.name,
                command: record.command,
                status: record.status,
                duration_ms: record.durationMs,
                summary: record.summary,
                source: "afk-validation-sidecar",
                hash: contentHash("validation", payload.repository, String(payload.issueNumber), String(payload.attemptNumber), payload.workerId ?? "", payload.envelopeHash ?? "", record.name),
            },
        };
        const validationRid = await store.upsertNode(validationNode);
        validationRids.push(validationRid);
        testedByEdges.push(await store.upsertEdge({
            label: "TESTED_BY",
            from_rid: attemptRid,
            to_rid: validationRid,
        }));
    }
    // Retry history (AC #5). Build the full PRECEDES chain across every
    // attempt currently known for this (repository, issueNumber), sorted by
    // attempt_number. Edge dedupe keeps re-recording idempotent (AC #6); the
    // chain is rebuilt cheaply each time so out-of-order writes still land on
    // the deterministic order.
    const precedesEdges = await linkPrecedesChain(store, payload.repository, payload.issueNumber);
    return {
        attemptRid,
        issueRid,
        prdRid,
        parentPrd: parentPrd ?? undefined,
        prdContainsIssueEdge,
        fileRids,
        touchedEdges,
        validationRids,
        testedByEdges,
        containsEdge,
        precedesEdges,
        touchedFiles: touched,
    };
}
/**
 * Parse `prd: #N` / `parent-prd: #N` from an issue body.
 *
 * Only an explicit marker line is accepted (case-insensitive, optional
 * leading whitespace). Random `#N` mentions in prose, references inside
 * code fences, labels-like substrings in the title, branch names, and
 * issue comments are *not* parsed here — by contract this function only
 * sees the issue body, and only the explicit marker line counts. Returns
 * the parsed PRD number or `null`.
 *
 * If both `prd:` and `parent-prd:` appear, `parent-prd:` wins (it is the
 * more specific marker); if neither appears, returns `null`.
 */
export function parseParentPrdFromBody(body) {
    if (!body)
        return null;
    const parentPrdMatch = body.match(/^[ \t]*parent-prd[ \t]*:[ \t]*#?(\d+)\b/im);
    if (parentPrdMatch)
        return Number(parentPrdMatch[1]);
    const prdMatch = body.match(/^[ \t]*prd[ \t]*:[ \t]*#?(\d+)\b/im);
    if (prdMatch)
        return Number(prdMatch[1]);
    return null;
}
/**
 * Rebuild the deterministic PRECEDES chain for every attempt currently known
 * for `(repository, issueNumber)`. Attempts are sorted by `attempt_number`
 * ascending and consecutive pairs get one `PRECEDES` edge each. `upsertEdge`
 * dedupes on (from, to, label), so calling this repeatedly is a no-op once
 * the chain is in place.
 */
async function linkPrecedesChain(store, repository, issueNumber) {
    const all = await store.listNodes();
    const attempts = all
        .filter((n) => n.node_type === "attempt")
        .filter((n) => n.properties.repository === repository &&
        Number(n.properties.issue_number) === issueNumber)
        .map((n) => ({
        rid: n.rid,
        attemptNumber: Number(n.properties.attempt_number ?? 0),
    }))
        .filter((a) => Number.isFinite(a.attemptNumber));
    // Deterministic order: attempt_number ascending. Ties (same attempt_number
    // across distinct worker ids) fall back to rid ascending so the chain is
    // stable across re-records.
    attempts.sort((a, b) => {
        if (a.attemptNumber !== b.attemptNumber)
            return a.attemptNumber - b.attemptNumber;
        return a.rid - b.rid;
    });
    const edges = [];
    for (let i = 1; i < attempts.length; i++) {
        edges.push(await store.upsertEdge({
            label: "PRECEDES",
            from_rid: attempts[i - 1].rid,
            to_rid: attempts[i].rid,
        }));
    }
    return edges;
}
/** Stable, human-readable label for an issue node. */
export function issueNodeLabel(repository, issueNumber) {
    return `issue:${repository}#${issueNumber}`;
}
/** Stable, human-readable label for a parent PRD node. */
export function prdNodeLabel(repository, prdNumber) {
    return `prd:${repository}#${prdNumber}`;
}
/** Stable, human-readable label for an attempt node. */
export function attemptNodeLabel(repository, issueNumber, attemptNumber, workerId) {
    const base = `attempt:${repository}#${issueNumber}/${attemptNumber}`;
    return workerId ? `${base}@${workerId}` : base;
}
/** Stable label for a minimal file node — matches the ingest extractor's
 *  `file:${path}` convention so later ingest reuses the same node. */
export function fileNodeLabel(path) {
    return `file:${path}`;
}
/** Stable label for a validation check node. */
export function validationNodeLabel(repository, issueNumber, attemptNumber, name) {
    return `validation:${repository}#${issueNumber}/${attemptNumber}/${name}`;
}
/** Drop empty entries and duplicates while preserving first-seen order. */
function dedupeTouchedFiles(paths) {
    if (!paths || paths.length === 0)
        return [];
    const seen = new Set();
    const out = [];
    for (const p of paths) {
        if (typeof p !== "string")
            continue;
        const trimmed = p.trim();
        if (trimmed.length === 0 || seen.has(trimmed))
            continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}
function normaliseHookRecords(records) {
    if (!Array.isArray(records))
        return [];
    const out = [];
    for (const record of records) {
        if (record == null || typeof record !== "object")
            continue;
        const raw = record;
        const lifecycle = typeof raw.lifecycle === "string" ? raw.lifecycle.trim() : "";
        const command = typeof raw.command === "string" ? raw.command.trim() : "";
        const rawExit = raw.exit_code;
        const exit_code = typeof rawExit === "number" && Number.isFinite(rawExit)
            ? Math.trunc(rawExit)
            : typeof rawExit === "string" && /^-?\d+$/.test(rawExit.trim())
                ? Number(rawExit.trim())
                : NaN;
        if (!lifecycle || !command || !Number.isFinite(exit_code))
            continue;
        out.push({ lifecycle, command, exit_code });
    }
    return out;
}
function normaliseValidationRecords(records) {
    if (!Array.isArray(records))
        return [];
    const out = [];
    for (const record of records) {
        if (record == null || typeof record !== "object")
            continue;
        const raw = record;
        const name = typeof raw.name === "string" ? raw.name.trim() : "";
        const status = typeof raw.status === "string" ? raw.status.trim() : "";
        if (!name || !status)
            continue;
        const command = typeof raw.command === "string" ? raw.command.trim() : undefined;
        const summary = typeof raw.summary === "string" ? raw.summary.trim() : undefined;
        const durationMs = typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)
            ? raw.durationMs
            : undefined;
        out.push({
            name,
            status,
            ...(command ? { command } : {}),
            ...(durationMs != null ? { durationMs } : {}),
            ...(summary ? { summary: summary.slice(0, 1000) } : {}),
        });
    }
    return out;
}
