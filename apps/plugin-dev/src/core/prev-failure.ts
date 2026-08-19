import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isPositiveIntegerToken, isValidWorkerId, WORKER_NAMESPACES } from "./worker-paths.js";

/**
 * prev-failure — the ONE carry-forward ADR 0103 keeps when the attempt model is
 * removed: on an automatic re-queue, the previous failure reason plus a
 * reference to the terminal Envelope are injected into the next worker prompt.
 *
 * There is no attempt level and no attempt ledger. A worker's workspace for one
 * Ticket is the flat `<root>/<lane>/<worker>/<issue>/`, and a terminal FAILURE
 * persists two plain-text markers into it:
 *
 *   <workspace>/failure.reason   free text: the terminal Envelope summary.
 *   <workspace>/envelope.ref     one line: where that Envelope was posted.
 *
 * Both are optional. A missing `failure.reason` means there is nothing to carry
 * forward (the first run of a Ticket, or a run that ended clean), and the block
 * is omitted from the handoff entirely. Partial uncommitted work is NOT
 * salvaged — forensics are the Envelope and any pushed branch commits.
 *
 * The lane scan is namespace-blind so a Ticket re-queued into a different worker
 * (or a different lane) still sees the previous failure; when several
 * workspaces carry a reason, the most recently written one wins.
 */

/** `<workspace>/failure.reason` — the terminal Envelope summary, free text. */
export const FAILURE_REASON_FILE = "failure.reason";
/** `<workspace>/envelope.ref` — where the terminal Envelope was posted. */
export const ENVELOPE_REF_FILE = "envelope.ref";

/** The marker the handoff block and {@link isMergeConflictRetry} key off. */
export const PREV_FAILURE_REASON_MARKER = "prev-failure-reason:";

export interface PrevFailureContext {
  /** Free-text reason recorded by the previous terminal failure. */
  reason: string;
  /** Reference to the terminal Envelope, when one was recorded. */
  envelopeRef?: string;
}

export interface PrevFailureReader {
  /**
   * Absolute paths of every worker workspace directory for `issue`, across every
   * worker lane. A missing tree yields an empty list rather than an error.
   */
  listIssueWorkspaces(root: string, issue: number): Promise<string[]>;
  /** Read a marker file under a workspace, or null when absent/empty. */
  readMarker(workspace: string, file: string): Promise<string | null>;
  /** Epoch-ms mtime of a workspace's reason marker; 0 when unknown. */
  modifiedAt(workspace: string): Promise<number>;
}

/**
 * The previous failure context for `issue`, or null when nothing was recorded.
 * Throws on a malformed (root, issue), mirroring the worker-paths contract.
 */
export async function readPrevFailureContext(
  root: string,
  issue: number,
  reader: PrevFailureReader = defaultPrevFailureReader,
): Promise<PrevFailureContext | null> {
  const issueNumber = validateIdentity(root, issue);
  const workspaces = await reader.listIssueWorkspaces(root, issueNumber);

  let best: { workspace: string; reason: string; at: number } | null = null;
  for (const workspace of workspaces) {
    const raw = await reader.readMarker(workspace, FAILURE_REASON_FILE);
    const reason = raw?.trim() ?? "";
    if (reason.length === 0) continue;
    const at = await reader.modifiedAt(workspace);
    if (!best || at > best.at) best = { workspace, reason, at };
  }
  if (!best) return null;

  const context: PrevFailureContext = { reason: best.reason };
  const refRaw = await reader.readMarker(best.workspace, ENVELOPE_REF_FILE);
  // The ref is a single line; take the first and trim any surrounding newline.
  const ref = refRaw?.split("\n", 1)[0]?.trim() ?? "";
  if (ref.length > 0) context.envelopeRef = ref;
  return context;
}

/**
 * Render the carry-forward block injected into the next worker prompt. The
 * Envelope reference leads so the free-text reason stays LAST — the reason is
 * unbounded operator text, and `isMergeConflictRetry` scans everything after the
 * `prev-failure-reason:` marker.
 */
export function formatPrevFailureContext(context: PrevFailureContext): string {
  const lines: string[] = [];
  if (context.envelopeRef) lines.push(`prev-envelope: ${context.envelopeRef}`);
  lines.push(PREV_FAILURE_REASON_MARKER, context.reason);
  return lines.join("\n");
}

/** Safe lookup wrapper for the run wiring: absent or unreadable context reads
 * as `undefined` — the carry-forward is best-effort by contract (ADR 0103). */
export async function lookupPrevFailureContext(
  root: string,
  issue: number,
): Promise<string | undefined> {
  try {
    const context = await readPrevFailureContext(root, issue);
    return context ? formatPrevFailureContext(context) : undefined;
  } catch {
    return undefined;
  }
}

function validateIdentity(root: string, issue: number): number {
  if (!root) throw new Error("root is required");
  if (!isPositiveIntegerToken(issue)) throw new Error(`invalid issue: ${issue}`);
  return typeof issue === "number" ? issue : Number(issue);
}

/** Default reader: expands each lane's `<root>/<lane>/<worker>/<issue>` on the FS. */
export const defaultPrevFailureReader: PrevFailureReader = {
  async listIssueWorkspaces(root: string, issue: number): Promise<string[]> {
    const out: string[] = [];
    for (const namespace of WORKER_NAMESPACES) {
      let workers: string[];
      try {
        workers = await readdir(join(root, namespace));
      } catch {
        continue; // lane dir absent → contributes no workspace
      }
      for (const worker of workers) {
        if (!isValidWorkerId(worker)) continue;
        out.push(join(root, namespace, worker, String(issue)));
      }
    }
    return out;
  },
  async readMarker(workspace: string, file: string): Promise<string | null> {
    try {
      const text = await readFile(join(workspace, file), "utf8");
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  },
  async modifiedAt(workspace: string): Promise<number> {
    try {
      return (await stat(join(workspace, FAILURE_REASON_FILE))).mtimeMs;
    } catch {
      return 0;
    }
  },
};
