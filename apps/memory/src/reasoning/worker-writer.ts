/**
 * Reasoning worker writer — the Memory-side path for recording one AFK
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
import type { MemoryStore } from "../graph-store.js";
import type { MemoryNode } from "../schema.js";

/** Terminal AFK outcomes the writer is expected to record. */
export type ReasoningWorkerStatus =
  | "done"
  | "blocked"
  | "no-sentinel"
  | "merge-conflict";

/**
 * One user-hook execution recorded from the AFK Envelope's `hooks` section
 * (issue #215). The trio is recorded best-effort on the `attempt` node so a
 * recall query like *"what filter did this attempt run with?"* answers from
 * graph properties instead of re-reading the raw Envelope.
 */
export interface WorkerHookRecord {
  /** Lifecycle point the hook ran at, e.g. `pre_pick`, `post_pick`. */
  lifecycle: string;
  /** The hook command line as registered. */
  command: string;
  /** Process exit code the hook returned. */
  exit_code: number;
}

/** One structured AFK validation sidecar record. */
export interface ValidationSidecarRecord {
  /** Stable check name, e.g. `test:plugins/memory`. */
  name: string;
  /** Command/check invocation, when the runner knows it. */
  command?: string;
  /** Check result, e.g. `passed`, `failed`, or `skipped`. */
  status: string;
  /** Wall-clock duration in milliseconds, when the command executed. */
  durationMs?: number;
  /** Short relevant output/error summary. */
  summary?: string;
}

/**
 * Structured payload for one terminal AFK attempt. The identity fields
 * (`repository`, `issueNumber`, `attemptNumber`, optional `envelopeHash`) drive
 * the dedupe hash — everything else is observational evidence stored on the
 * node for later recall and inspection.
 */
export interface ReasoningWorkerPayload {
  /** Canonical repo identifier, e.g. `reddb-io/red-skills`. */
  repository: string;
  /** GitHub issue number this attempt belonged to. */
  issueNumber: number;
  /** Attempt ordinal as recorded by the orchestrator (1-based). */
  attemptNumber: number;
  /** Terminal outcome reported by AFK. */
  status: ReasoningWorkerStatus | string;
  /** Canonical issue type bucket, e.g. `bug`, `prd`, or `unknown`. */
  issueType?: string;
  /** AFK model tier used for the attempt, e.g. `validate`, `simple`, `complex`, or `think`. */
  modelTier?: string;
  /** Coarse routing outcome for later policy queries. */
  outcome?: "success" | "failure" | "escalated";
  /** Issue title at the time of recording, if known. */
  issueTitle?: string;
  /** Issue URL at the time of recording, if known. */
  issueUrl?: string;
  /**
   * Issue body at the time of recording. Scanned for an explicit
   * `prd: #N` or `parent-prd: #N` marker line; nothing else is inspected.
   * The parser never reads labels, title text, comments, links, or branch
   * names — there is no weak-signal inference of a parent PRD.
   */
  issueBody?: string;
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
  /** Structured validation sidecar records; never parsed from free-form text. */
  validationRecords?: ValidationSidecarRecord[];
  /**
   * User-hook executions captured from the Envelope `hooks` section
   * (issue #215). Dropped entirely when no user hooks ran — a project with no
   * user hooks declared produces an `attempt` node without the property,
   * keeping the schema empty-array-free.
   */
  hooks?: WorkerHookRecord[];
  /** Short why/outcome summary; one or two sentences. */
  summary?: string;
}

/** What `recordReasoningWorker` actually wrote, for callers and tests. */
export interface ReasoningWorkerReceipt {
  workerRid: number;
  issueRid: number;
  /** Rid of the parent `prd` node, when the issue body declared one. */
  prdRid?: number;
  /** Parent PRD number parsed from the issue body, when present. */
  parentPrd?: number;
  /** `CONTAINS` edge from prd → issue, when a parent PRD was recorded. */
  prdContainsIssueEdge?: number;
  /** Same length and order as the deduplicated touched files. */
  fileRids: number[];
  /** `TOUCHED` edges, one per file, in the same order as `fileRids`. */
  touchedEdges: number[];
  /** Validation nodes written from structured sidecar records. */
  validationRids: number[];
  /** `TESTED_BY` edges, one per validation node. */
  testedByEdges: number[];
  /** `CONTAINS` edge from issue → worker run. */
  containsEdge: number;
  /**
   * `PRECEDES` edges connecting consecutive worker runs on this issue in
   * run-number order. Empty when this is the only known run.
   */
  precedesEdges: number[];
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
export async function recordReasoningWorker(
  store: MemoryStore,
  payload: ReasoningWorkerPayload,
): Promise<ReasoningWorkerReceipt> {
  // Parse the parent PRD strictly from the issue body — no inference from
  // labels, title text, comments, links, or branch names is permitted (AC #3).
  const parentPrd = parseParentPrdFromBody(payload.issueBody);

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
  let prdRid: number | undefined;
  let prdContainsIssueEdge: number | undefined;
  if (parentPrd != null) {
    const prdLabel = prdNodeLabel(payload.repository, parentPrd);
    const prdNode: MemoryNode = {
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
  const workerLabel = workerNodeLabel(
    payload.repository,
    payload.issueNumber,
    payload.attemptNumber,
    payload.workerId,
  );
  const workerNode: MemoryNode = {
    label: workerLabel,
    node_type: "worker",
    properties: {
      title: payload.summary ?? workerLabel,
      content: payload.summary,
      repository: payload.repository,
      issue_number: payload.issueNumber,
      attempt_number: payload.attemptNumber,
      worker_id: payload.workerId,
      ...(parentPrd != null ? { parent_prd: parentPrd } : {}),
      status: payload.status,
      issue_type: payload.issueType,
      model_tier: payload.modelTier,
      outcome: payload.outcome,
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
      // Identity is the AFK worker coordinates plus envelope hash when known.
      // Re-recording the same terminal run — even with new notes — reuses
      // this rid; a fresh run number or worker id forks a new node.
      hash: contentHash(
        "worker",
        payload.repository,
        String(payload.issueNumber),
        String(payload.attemptNumber),
        payload.workerId ?? "",
        payload.envelopeHash ?? "",
      ),
    },
  };
  const workerRid = await store.upsertNode(workerNode);

  // Work hierarchy: issue CONTAINS attempt. The parent PRD edge (when
  // present) is the separate `prd CONTAINS issue` written above.
  const containsEdge = await store.upsertEdge({
    label: "CONTAINS",
    from_rid: issueRid,
    to_rid: workerRid,
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
        from_rid: workerRid,
        to_rid: fileRid,
      }),
    );
  }

  const validations = normaliseValidationRecords(payload.validationRecords);
  const validationRids: number[] = [];
  const testedByEdges: number[] = [];
  for (const record of validations) {
    const validationNode: MemoryNode = {
      label: validationNodeLabel(
        payload.repository,
        payload.issueNumber,
        payload.attemptNumber,
        record.name,
      ),
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
        hash: contentHash(
          "validation",
          payload.repository,
          String(payload.issueNumber),
          String(payload.attemptNumber),
          payload.workerId ?? "",
          payload.envelopeHash ?? "",
          record.name,
        ),
      },
    };
    const validationRid = await store.upsertNode(validationNode);
    validationRids.push(validationRid);
    testedByEdges.push(
      await store.upsertEdge({
        label: "TESTED_BY",
        from_rid: workerRid,
        to_rid: validationRid,
      }),
    );
  }

  // Retry history (AC #5). Build the full PRECEDES chain across every
  // attempt currently known for this (repository, issueNumber), sorted by
  // attempt_number. Edge dedupe keeps re-recording idempotent (AC #6); the
  // chain is rebuilt cheaply each time so out-of-order writes still land on
  // the deterministic order.
  const precedesEdges = await linkPrecedesChain(
    store,
    payload.repository,
    payload.issueNumber,
  );

  return {
    workerRid,
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
export function parseParentPrdFromBody(body: string | undefined): number | null {
  if (!body) return null;
  const parentPrdMatch = body.match(/^[ \t]*parent-prd[ \t]*:[ \t]*#?(\d+)\b/im);
  if (parentPrdMatch) return Number(parentPrdMatch[1]);
  const prdMatch = body.match(/^[ \t]*prd[ \t]*:[ \t]*#?(\d+)\b/im);
  if (prdMatch) return Number(prdMatch[1]);
  return null;
}

/**
 * Rebuild the deterministic PRECEDES chain for every worker run currently known
 * for `(repository, issueNumber)`. Runs are sorted by `attempt_number`
 * ascending and consecutive pairs get one `PRECEDES` edge each. `upsertEdge`
 * dedupes on (from, to, label), so calling this repeatedly is a no-op once
 * the chain is in place.
 */
async function linkPrecedesChain(
  store: MemoryStore,
  repository: string,
  issueNumber: number,
): Promise<number[]> {
  const all = await store.listNodes();
  const workerRuns = all
    .filter((n) => n.node_type === "worker")
    .filter(
      (n) =>
        n.properties.repository === repository &&
        Number(n.properties.issue_number) === issueNumber,
    )
    .map((n) => ({
      rid: n.rid,
      attemptNumber: Number(n.properties.attempt_number ?? 0),
    }))
    .filter((a) => Number.isFinite(a.attemptNumber));

  // Deterministic order: attempt_number ascending. Ties (same attempt_number
  // across distinct worker ids) fall back to rid ascending so the chain is
  // stable across re-records.
  workerRuns.sort((a, b) => {
    if (a.attemptNumber !== b.attemptNumber) return a.attemptNumber - b.attemptNumber;
    return a.rid - b.rid;
  });

  const edges: number[] = [];
  for (let i = 1; i < workerRuns.length; i++) {
    edges.push(
      await store.upsertEdge({
        label: "PRECEDES",
        from_rid: workerRuns[i - 1].rid,
        to_rid: workerRuns[i].rid,
      }),
    );
  }
  return edges;
}

/** Stable, human-readable label for an issue node. */
export function issueNodeLabel(repository: string, issueNumber: number): string {
  return `issue:${repository}#${issueNumber}`;
}

/** Stable, human-readable label for a parent PRD node. */
export function prdNodeLabel(repository: string, prdNumber: number): string {
  return `prd:${repository}#${prdNumber}`;
}

/** Stable, human-readable label for a worker run node. */
export function workerNodeLabel(
  repository: string,
  issueNumber: number,
  attemptNumber: number,
  workerId?: string,
): string {
  const base = `worker:${repository}#${issueNumber}/${attemptNumber}`;
  return workerId ? `${base}@${workerId}` : base;
}

/** Stable label for a minimal file node — matches the ingest extractor's
 *  `file:${path}` convention so later ingest reuses the same node. */
export function fileNodeLabel(path: string): string {
  return `file:${path}`;
}

/** Stable label for a validation check node. */
export function validationNodeLabel(
  repository: string,
  issueNumber: number,
  attemptNumber: number,
  name: string,
): string {
  return `validation:${repository}#${issueNumber}/${attemptNumber}/${name}`;
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

function normaliseHookRecords(
  records: WorkerHookRecord[] | undefined,
): WorkerHookRecord[] {
  if (!Array.isArray(records)) return [];
  const out: WorkerHookRecord[] = [];
  for (const record of records) {
    if (record == null || typeof record !== "object") continue;
    const raw = record as unknown as Record<string, unknown>;
    const lifecycle = typeof raw.lifecycle === "string" ? raw.lifecycle.trim() : "";
    const command = typeof raw.command === "string" ? raw.command.trim() : "";
    const rawExit = raw.exit_code;
    const exit_code =
      typeof rawExit === "number" && Number.isFinite(rawExit)
        ? Math.trunc(rawExit)
        : typeof rawExit === "string" && /^-?\d+$/.test(rawExit.trim())
          ? Number(rawExit.trim())
          : NaN;
    if (!lifecycle || !command || !Number.isFinite(exit_code)) continue;
    out.push({ lifecycle, command, exit_code });
  }
  return out;
}

function normaliseValidationRecords(
  records: ValidationSidecarRecord[] | undefined,
): ValidationSidecarRecord[] {
  if (!Array.isArray(records)) return [];
  const out: ValidationSidecarRecord[] = [];
  for (const record of records) {
    if (record == null || typeof record !== "object") continue;
    const raw = record as unknown as Record<string, unknown>;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    const status = typeof raw.status === "string" ? raw.status.trim() : "";
    if (!name || !status) continue;
    const command = typeof raw.command === "string" ? raw.command.trim() : undefined;
    const summary = typeof raw.summary === "string" ? raw.summary.trim() : undefined;
    const durationMs =
      typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)
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
