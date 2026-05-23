/**
 * Reasoning attempt writer — the Memory-side path for recording one AFK
 * terminal attempt as a graph object. The first slice of PRD #95.
 *
 * Writes:
 *   - one `attempt` node (defaulting to `reasoning` tier),
 *   - one minimal `issue` node (created or reused),
 *   - one `CONTAINS` edge: issue → attempt,
 *   - one minimal `file` node per touched path (created or reused), and
 *   - one `TOUCHED` edge per file: attempt → file.
 *
 * Re-recording the same attempt is idempotent: identity hashes for the attempt,
 * the issue, and each file node are stable functions of the AFK metadata, and
 * edges dedupe by (from, to, label). No ingest, reindex, or codebase scan runs
 * here — minimal file nodes are bare placeholders that a later `/memory:ingest`
 * may enrich with symbols and code edges.
 */

import { contentHash } from "../hash.js";
import type { MemoryStore } from "../graph-store.js";
import type { MemoryNode } from "../schema.js";

/** Terminal AFK outcomes the writer is expected to record. */
export type ReasoningAttemptStatus =
  | "done"
  | "blocked"
  | "no-sentinel"
  | "merge-conflict";

/**
 * Structured payload for one terminal AFK attempt. The identity fields
 * (`repository`, `issueNumber`, `attemptNumber`, optional `envelopeHash`) drive
 * the dedupe hash — everything else is observational evidence stored on the
 * node for later recall and inspection.
 */
export interface ReasoningAttemptPayload {
  /** Canonical repo identifier, e.g. `reddb-io/red-skills`. */
  repository: string;
  /** GitHub issue number this attempt belonged to. */
  issueNumber: number;
  /** Attempt ordinal as recorded by the orchestrator (1-based). */
  attemptNumber: number;
  /** Terminal outcome reported by AFK. */
  status: ReasoningAttemptStatus | string;
  /** Issue title at the time of recording, if known. */
  issueTitle?: string;
  /** Issue URL at the time of recording, if known. */
  issueUrl?: string;
  /** AFK worker / runner identifier, when needed to disambiguate. */
  workerId?: string;
  /** Worktree branch the attempt ran on. */
  branch?: string;
  /** Wall-clock duration of the attempt, in milliseconds. */
  durationMs?: number;
  /** Diffstat summary string from the terminal envelope. */
  diffstat?: string;
  /** Reference to the terminal Envelope comment (e.g. issue-comment URL). */
  envelopeRef?: string;
  /** Stable hash of the terminal Envelope, when AFK computes one. */
  envelopeHash?: string;
  /** Merge commit SHA when the attempt landed on `main`. */
  mergeCommit?: string;
  /** Branch left behind when the attempt failed without merging. */
  failureBranch?: string;
  /** Repo-relative paths the attempt touched. Empty array is valid. */
  touchedFiles?: string[];
  /** Free-form notes captured by the inner agent / orchestrator. */
  notes?: string;
  /** Error class label when the attempt failed. */
  errorClass?: string;
  /** Aggregate validation summary (e.g. "tests pass, typecheck pass"). */
  validationSummary?: string;
  /** Short why/outcome summary; one or two sentences. */
  summary?: string;
}

/** What `recordReasoningAttempt` actually wrote, for callers and tests. */
export interface ReasoningAttemptReceipt {
  attemptRid: number;
  issueRid: number;
  /** Same length and order as the deduplicated touched files. */
  fileRids: number[];
  /** `TOUCHED` edges, one per file, in the same order as `fileRids`. */
  touchedEdges: number[];
  /** `CONTAINS` edge from issue → attempt. */
  containsEdge: number;
  /** Touched paths after dedupe and normalisation. */
  touchedFiles: string[];
}

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
export async function recordReasoningAttempt(
  store: MemoryStore,
  payload: ReasoningAttemptPayload,
): Promise<ReasoningAttemptReceipt> {
  const issueLabel = issueNodeLabel(payload.repository, payload.issueNumber);
  const issueNode: MemoryNode = {
    label: issueLabel,
    node_type: "issue",
    properties: {
      title: payload.issueTitle ?? issueLabel,
      repository: payload.repository,
      issue_number: payload.issueNumber,
      url: payload.issueUrl,
      source: "github-issues",
      // Pinned identity hash so observational refinements (a title update on a
      // later attempt, say) reuse the same `issue` node instead of forking it.
      hash: contentHash("issue", payload.repository, String(payload.issueNumber)),
    },
  };
  const issueRid = await store.upsertNode(issueNode);

  const touched = dedupeTouchedFiles(payload.touchedFiles);
  const attemptLabel = attemptNodeLabel(
    payload.repository,
    payload.issueNumber,
    payload.attemptNumber,
    payload.workerId,
  );
  const attemptNode: MemoryNode = {
    label: attemptLabel,
    node_type: "attempt",
    properties: {
      title: payload.summary ?? attemptLabel,
      content: payload.summary,
      repository: payload.repository,
      issue_number: payload.issueNumber,
      attempt_number: payload.attemptNumber,
      worker_id: payload.workerId,
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
      summary: payload.summary,
      source: "afk",
      // Identity is the AFK attempt coordinates plus envelope hash when known.
      // Re-recording the same terminal attempt — even with new notes — reuses
      // this rid; a fresh attempt number or worker id forks a new node.
      hash: contentHash(
        "attempt",
        payload.repository,
        String(payload.issueNumber),
        String(payload.attemptNumber),
        payload.workerId ?? "",
        payload.envelopeHash ?? "",
      ),
    },
  };
  const attemptRid = await store.upsertNode(attemptNode);

  // Work hierarchy: issue CONTAINS attempt. The PRD parent edge lives on
  // `prd CONTAINS issue` and is out of this slice (no PRD inference here).
  const containsEdge = await store.upsertEdge({
    label: "CONTAINS",
    from_rid: issueRid,
    to_rid: attemptRid,
  });

  const fileRids: number[] = [];
  const touchedEdges: number[] = [];
  for (const path of touched) {
    const fileNode: MemoryNode = {
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
    touchedEdges.push(
      await store.upsertEdge({
        label: "TOUCHED",
        from_rid: attemptRid,
        to_rid: fileRid,
      }),
    );
  }

  return {
    attemptRid,
    issueRid,
    fileRids,
    touchedEdges,
    containsEdge,
    touchedFiles: touched,
  };
}

/** Stable, human-readable label for an issue node. */
export function issueNodeLabel(repository: string, issueNumber: number): string {
  return `issue:${repository}#${issueNumber}`;
}

/** Stable, human-readable label for an attempt node. */
export function attemptNodeLabel(
  repository: string,
  issueNumber: number,
  attemptNumber: number,
  workerId?: string,
): string {
  const base = `attempt:${repository}#${issueNumber}/${attemptNumber}`;
  return workerId ? `${base}@${workerId}` : base;
}

/** Stable label for a minimal file node — matches the ingest extractor's
 *  `file:${path}` convention so later ingest reuses the same node. */
export function fileNodeLabel(path: string): string {
  return `file:${path}`;
}

/** Drop empty entries and duplicates while preserving first-seen order. */
function dedupeTouchedFiles(paths: string[] | undefined): string[] {
  if (!paths || paths.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
