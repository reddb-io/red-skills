import { runPromote } from "./promote.js";
import { current as sessionCurrent } from "./session-manager.js";
import { slugify } from "./store.js";
import { getRawTranscript } from "./working-memory.js";
/**
 * Run the AFK lifecycle hook for a single AFK worker session. Safe to call
 * multiple times for the same session id — subsequent invocations are no-ops.
 */
export async function runAfkLifecycle(store, rootDir, opts) {
    const session_id = opts.sessionId ?? (await sessionCurrent(rootDir));
    if (!session_id) {
        throw new Error("no session — start one or pass { sessionId } to runAfkLifecycle");
    }
    const worktree_id = opts.worktreeId;
    // 1. promote-all
    let promote;
    try {
        promote = await runPromote(store, rootDir, {
            triggeredBy: "hook",
            sessionId: session_id,
        });
    }
    catch {
        // No L2 events / store closed mid-call: surface an empty promote report so
        // the rest of the lifecycle can still run idempotently.
        promote = {
            session_id,
            promoted: 0,
            reinforced: 0,
            skipped: 0,
            promoted_rids: [],
            reinforced_rids: [],
            decisions: [],
        };
    }
    // 2. archive raw transcript (if any L2 transcript blob exists)
    let transcript_rid = null;
    let transcript_created = false;
    const raw = await readRawTranscriptForSession(store, rootDir, session_id);
    if (raw && raw.value.length > 0) {
        const archiveLabel = `transcript:worktree:${slugify(worktree_id)}:session:${slugify(session_id)}`;
        const existingRid = await store.findNodeByLabel(archiveLabel, "transcript");
        const node = {
            label: archiveLabel,
            node_type: "transcript",
            properties: {
                title: `AFK transcript ${worktree_id} (${session_id})`,
                content: raw.value,
                source: `afk:lifecycle:worktree=${worktree_id}:session=${session_id}`,
                confidence: "EXTRACTED",
                layer: "L3",
                scope: "worktree",
                scope_id: worktree_id,
                worktree_id,
                session_id,
                provenance: {
                    source_kind: "derived",
                    writer: "memory",
                    command: "memory afk-finalize",
                    evidence: [
                        `worktree:${worktree_id}`,
                        `session:${session_id}`,
                    ],
                },
            },
        };
        transcript_rid = await store.upsertNode(node);
        transcript_created = existingRid == null;
    }
    // 3. drop L2 for the session
    const dropped_rids = await dropL2ForSession(store, session_id);
    return {
        session_id,
        worktree_id,
        promote,
        transcript_rid,
        transcript_created,
        dropped_rids,
    };
}
/**
 * Read the raw transcript blob for `session_id` without going through the
 * session-manager file (the worker may already have torn it down). Returns
 * `null` if no L2 transcript node exists for the session.
 */
async function readRawTranscriptForSession(store, rootDir, session_id) {
    // Prefer the session-aware reader when the file is still present (matches
    // the live agent path), then fall back to a manual scan keyed by session id
    // so finalize works after the session file has been removed.
    const current = await sessionCurrent(rootDir);
    if (current === session_id) {
        const fromCurrent = await getRawTranscript(store, rootDir);
        if (fromCurrent)
            return fromCurrent;
    }
    const nodes = await store.listNodes();
    for (const n of nodes) {
        const p = n.properties;
        if (p.layer !== "L2")
            continue;
        if (p.session_id !== session_id)
            continue;
        if (p.working_kind !== "transcript")
            continue;
        return { session_id, value: String(p.value ?? "") };
    }
    return null;
}
async function dropL2ForSession(store, session_id) {
    const nodes = await store.listNodes();
    const victims = nodes.filter((n) => n.properties.layer === "L2" && n.properties.session_id === session_id);
    if (victims.length === 0)
        return [];
    // Reclaim L2 with the same `recordEvicted` overlay the L2 eviction sweep
    // (slice #182) uses: rows stop surfacing through `listNodes` immediately,
    // and storage compaction lands when the engine sweeps later. Matches the
    // "no automatic delete from disk" guarantee while satisfying the AFK
    // brief's "session's L2 namespace is removed" semantics.
    const rids = victims.map((v) => v.rid);
    await store.recordEvicted(rids);
    return rids;
}
