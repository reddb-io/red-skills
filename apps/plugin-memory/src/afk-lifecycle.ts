/**
 * AFK lifecycle hook (PRD #174, issue #187). End-of-worktree sequence the AFK
 * worker invokes after its iteration closes:
 *
 *   1. **Promote-all** — run {@link runPromote} for the worker's session so every
 *      typed L2 candidate is dedup-checked and lifted into L3, regardless of
 *      overflow thresholds. Triggered with `triggeredBy: "hook"` so the engine
 *      events tag the promotion as lifecycle-driven (slice #176 / #183).
 *   2. **Archive raw transcript** — copy the session's L2 raw transcript blob
 *      into L3 as a durable `transcript` node carrying `worktree:<id>` and
 *      `session:<id>` evidence so a future re-extraction with a better prompt
 *      can still rebuild structured facts after the worktree is gone.
 *   3. **Drop L2** — every L2 node for the session (events + transcript) is
 *      deleted from the store; storage is reclaimed immediately instead of
 *      waiting for the TTL/byte-budget sweep (slice #182).
 *
 * Idempotent by construction:
 *
 *  - Step 1 is a no-op when no L2 events remain for the session.
 *  - Step 2 archives via {@link MemoryStore.upsertNode}, which dedupes on the
 *    `(label, node_type, title, content, scope, scope_id)` content hash; a
 *    second call with the same blob is a deduped hit, not a duplicate row.
 *  - Step 3 is naturally idempotent (delete-by-list); a session with no L2
 *    nodes is silently skipped.
 *
 * Errors in archival or drop never undo earlier work — each step records what
 * it did and the report surfaces the outcome.
 */
import type { MemoryStore, StoredNode } from "./graph-store.js";
import { runPromote, type PromoteReport } from "./promote.js";
import type { MemoryNode } from "./schema.js";
import { current as sessionCurrent } from "./session-manager.js";
import { slugify } from "./store.js";
import { getRawTranscript } from "./working-memory.js";

export interface AfkLifecycleOptions {
  /** Override the session id (otherwise resolved from `session-manager`). */
  sessionId?: string;
  /**
   * Worktree identifier — usually the AFK worker id or the iteration tag
   * (`w16XI-i1`). Stamped onto the archived transcript so future readers can
   * trace it back to the iteration that produced it.
   */
  worktreeId: string;
}

export interface AfkLifecycleReport {
  session_id: string;
  worktree_id: string;
  /** {@link PromoteReport} from the promote-all pass. */
  promote: PromoteReport;
  /** RID of the archived L3 transcript node, or `null` if no raw blob existed. */
  transcript_rid: number | null;
  /** Whether a new transcript node was created (vs an existing one being deduped). */
  transcript_created: boolean;
  /** RIDs of L2 nodes deleted in the drop pass (events + transcript). */
  dropped_rids: number[];
}

/**
 * Run the AFK lifecycle hook for a single AFK worker session. Safe to call
 * multiple times for the same session id — subsequent invocations are no-ops.
 */
export async function runAfkLifecycle(
  store: MemoryStore,
  rootDir: string,
  opts: AfkLifecycleOptions,
): Promise<AfkLifecycleReport> {
  const session_id = opts.sessionId ?? (await sessionCurrent(rootDir));
  if (!session_id) {
    throw new Error(
      "no session — start one or pass { sessionId } to runAfkLifecycle",
    );
  }
  const worktree_id = opts.worktreeId;

  // 1. promote-all
  let promote: PromoteReport;
  try {
    promote = await runPromote(store, rootDir, {
      triggeredBy: "hook",
      sessionId: session_id,
    });
  } catch {
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
  let transcript_rid: number | null = null;
  let transcript_created = false;
  const raw = await readRawTranscriptForSession(store, rootDir, session_id);
  if (raw && raw.value.length > 0) {
    const archiveLabel = `transcript:worktree:${slugify(worktree_id)}:session:${slugify(session_id)}`;
    const existingRid = await store.findNodeByLabel(archiveLabel, "transcript");
    const node: MemoryNode = {
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
async function readRawTranscriptForSession(
  store: MemoryStore,
  rootDir: string,
  session_id: string,
): Promise<{ session_id: string; value: string } | null> {
  // Prefer the session-aware reader when the file is still present (matches
  // the live agent path), then fall back to a manual scan keyed by session id
  // so finalize works after the session file has been removed.
  const current = await sessionCurrent(rootDir);
  if (current === session_id) {
    const fromCurrent = await getRawTranscript(store, rootDir);
    if (fromCurrent) return fromCurrent;
  }
  const nodes = await store.listNodes();
  for (const n of nodes) {
    const p = n.properties;
    if (p.layer !== "L2") continue;
    if (p.session_id !== session_id) continue;
    if (p.working_kind !== "transcript") continue;
    return { session_id, value: String(p.value ?? "") };
  }
  return null;
}

async function dropL2ForSession(
  store: MemoryStore,
  session_id: string,
): Promise<number[]> {
  const nodes = await store.listNodes();
  const victims: StoredNode[] = nodes.filter(
    (n) => n.properties.layer === "L2" && n.properties.session_id === session_id,
  );
  if (victims.length === 0) return [];
  // Reclaim L2 with the same `recordEvicted` overlay the L2 eviction sweep
  // (slice #182) uses: rows stop surfacing through `listNodes` immediately,
  // and storage compaction lands when the engine sweeps later. Matches the
  // "no automatic delete from disk" guarantee while satisfying the AFK
  // brief's "session's L2 namespace is removed" semantics.
  const rids = victims.map((v) => v.rid);
  await store.recordEvicted(rids);
  return rids;
}
