import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { isPositiveIntegerToken, isValidWorkerId, parseWorkerAttemptPath } from "./worker-paths.js";

/**
 * attempt-ledger — derive the next attempt number and assemble the
 * restart-informed context for a new AFK attempt.
 *
 * Every AFK attempt lives on disk under the attempt-first tree owned by
 * worker-paths:
 *
 *   <root>/workers/<worker>/<issue>-a<attempt>/
 *
 * This module is the FS-enumeration consumer of worker-paths: worker-paths owns
 * the path *grammar* (build/parse, never touching disk); this module walks the
 * real attempt tree and reuses `parseWorkerAttemptPath` to interpret each hit.
 * The numbering logic is a pure function over a list of attempt-dir basenames;
 * the directory globbing is a thin injectable reader.
 *
 * Per-attempt outcome contract (read-only here): an attempt directory MAY carry
 * two plain-text marker files and one validation sidecar —
 *   <attempt_dir>/snapshot-branch.ref   one line: the remote snapshot branch ref.
 *   <attempt_dir>/failure.reason        free text: the recorded failure reason.
 *   <attempt_dir>/validation.jsonl      feedback/backpressure records for the failure.
 * All are optional; missing marker files degrade to labelled placeholders, and
 * a missing validation sidecar is omitted from the retry context.
 */

const SNAPSHOT_BRANCH_FILE = "snapshot-branch.ref";
const FAILURE_REASON_FILE = "failure.reason";
const VALIDATION_FILE = "validation.jsonl";
const NONE_BRANCH = "(none)";
const NONE_REASON = "(none recorded)";

export interface AttemptDirReader {
  /**
   * List the basenames of every entry under <root>/workers/<worker>/ for each
   * worker, returning one record per worker. Implementations resolve the
   * canonical `<root>/workers/*` layout against the real filesystem. A missing
   * tree yields an empty list rather than an error.
   */
  listAttemptDirs(root: string): Promise<AttemptDirEntry[]>;
  /** Read a marker file under an attempt directory, or null when absent/empty. */
  readMarker(attemptDir: string, file: string): Promise<string | null>;
}

export interface AttemptDirEntry {
  worker: string;
  /** Basenames of the directory entries inside the worker's directory. */
  basenames: string[];
}

export interface HighestAttempt {
  attempt: number;
  /** Absolute-ish path of the highest attempt directory, joined under root. */
  dir: string;
}

export interface AttemptContext {
  prevAttempt: number;
  prevSnapshotBranch: string;
  prevFailureReason: string;
  prevValidationSummary?: string;
}

/**
 * Pure numbering core: given the attempt-dir basenames for every worker and the
 * target issue, return the highest existing attempt and its directory path.
 * Non-matching basenames (wrong issue, non-numeric suffix) are ignored, so junk
 * entries never bump the counter. The selection is numeric, not lexical. Returns
 * null when no valid prior attempt exists for the issue.
 */
export function highestAttempt(
  root: string,
  issue: number,
  entries: readonly AttemptDirEntry[],
): HighestAttempt | null {
  let best: HighestAttempt | null = null;
  for (const entry of entries) {
    if (!isValidWorkerId(entry.worker)) continue;
    for (const basename of entry.basenames) {
      const parsed = parseWorkerAttemptPath(`workers/${entry.worker}/${basename}`);
      if (!parsed || parsed.issue !== issue) continue;
      if (!best || parsed.attempt > best.attempt) {
        best = { attempt: parsed.attempt, dir: join(root, "workers", entry.worker, basename) };
      }
    }
  }
  return best;
}

/**
 * Next attempt number for <issue>: (highest existing attempt on disk) + 1, or 1
 * when none exists. Throws on a malformed (root, issue) — delegated to
 * worker-paths validation — mirroring the bash non-zero / no-output contract.
 */
export async function attemptLedgerNextNumber(
  root: string,
  issue: number,
  reader: AttemptDirReader = defaultReader,
): Promise<number> {
  const issueNumber = validateIdentity(root, issue);
  const entries = await reader.listAttemptDirs(root);
  const best = highestAttempt(root, issueNumber, entries);
  return best ? best.attempt + 1 : 1;
}

/**
 * Directory path of the highest-numbered existing attempt for <issue> (the
 * previous attempt). Returns null when there is no prior attempt (the
 * first-attempt signal). Throws on a malformed identity.
 */
export async function attemptLedgerPrevDir(
  root: string,
  issue: number,
  reader: AttemptDirReader = defaultReader,
): Promise<string | null> {
  const issueNumber = validateIdentity(root, issue);
  const entries = await reader.listAttemptDirs(root);
  const best = highestAttempt(root, issueNumber, entries);
  return best ? best.dir : null;
}

/**
 * Restart-context block for the next attempt, assembled from the previous
 * attempt's directory. Returns null on the first attempt (nothing to restart
 * from). Throws on a malformed identity. Missing/empty marker files degrade to
 * labelled placeholders rather than failing.
 */
export async function attemptLedgerContext(
  root: string,
  issue: number,
  reader: AttemptDirReader = defaultReader,
): Promise<AttemptContext | null> {
  const issueNumber = validateIdentity(root, issue);
  const entries = await reader.listAttemptDirs(root);
  const best = highestAttempt(root, issueNumber, entries);
  if (!best) return null;

  const branchRaw = await reader.readMarker(best.dir, SNAPSHOT_BRANCH_FILE);
  const reasonRaw = await reader.readMarker(best.dir, FAILURE_REASON_FILE);
  const validationRaw = await reader.readMarker(best.dir, VALIDATION_FILE);
  // The ref is a single line; take the first and trim any surrounding newline.
  const branchLine = branchRaw?.split("\n", 1)[0]?.trim() ?? "";
  const context: AttemptContext = {
    prevAttempt: best.attempt,
    prevSnapshotBranch: branchLine.length > 0 ? branchLine : NONE_BRANCH,
    prevFailureReason: reasonRaw && reasonRaw.length > 0 ? reasonRaw : NONE_REASON,
  };
  if (validationRaw && validationRaw.trim().length > 0) {
    context.prevValidationSummary = validationRaw;
  }
  return context;
}

/** Render a context block in the same textual shape the bash module emits. */
export function formatAttemptContext(context: AttemptContext): string {
  const lines = [
    `prev-attempt: ${context.prevAttempt}`,
    `prev-snapshot-branch: ${context.prevSnapshotBranch}`,
    "prev-failure-reason:",
    context.prevFailureReason,
  ];
  if (context.prevValidationSummary) {
    lines.push("prev-validation-summary:", context.prevValidationSummary);
  }
  return lines.join("\n");
}

function validateIdentity(root: string, issue: number): number {
  if (!root) throw new Error("root is required");
  if (!isPositiveIntegerToken(issue)) throw new Error(`invalid issue: ${issue}`);
  return typeof issue === "number" ? issue : Number(issue);
}

/** Default reader: expands the canonical `<root>/workers/*` layout against the FS. */
export const defaultReader: AttemptDirReader = {
  async listAttemptDirs(root: string): Promise<AttemptDirEntry[]> {
    const workersDir = join(root, "workers");
    let workers: string[];
    try {
      workers = await readdir(workersDir);
    } catch {
      return [];
    }
    const entries: AttemptDirEntry[] = [];
    for (const worker of workers) {
      try {
        const basenames = await readdir(join(workersDir, worker));
        entries.push({ worker, basenames });
      } catch {
        // Not a directory (or unreadable): contributes no attempts.
      }
    }
    return entries;
  },
  async readMarker(attemptDir: string, file: string): Promise<string | null> {
    try {
      const text = await readFile(join(attemptDir, file), "utf8");
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  },
};
