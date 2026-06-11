/**
 * Incremental-diff selection — the deep, git-plumbing-free core of the
 * auto-update hooks (issue #236). Given the textual output of
 * `git diff --name-status` (with or without `-z`), it decides which files an
 * incremental re-ingest must touch: changed files are re-indexed, deleted and
 * renamed-from paths are reported so their graph elements go stale.
 *
 * Everything here is pure — it never shells out to git. The orchestrator
 * ({@link ../vcs-refresh}) owns the git calls and feeds their stdout in. That
 * split is deliberate: the selection logic is unit-tested in isolation
 * (`tests/git-diff-selection.test.ts`, AC4) while the thin git layer is covered
 * by the CLI integration tests.
 */

/** The single-letter change codes `git diff --name-status` emits. */
export type GitChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "B";

/** One parsed `--name-status` record. `oldPath` is set for renames/copies. */
export interface GitChange {
  status: GitChangeStatus;
  /** Destination path (the new name for renames/copies). */
  path: string;
  /** Source path for renames (R) and copies (C); absent otherwise. */
  oldPath?: string;
}

/**
 * Git's well-known empty-tree object id. Diffing the root commit against it
 * yields every file as an addition, so a repo's first commit still drives a
 * full incremental pass rather than crashing on a missing parent.
 */
export const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Statuses whose first field carries a `R100` / `C75`-style similarity score. */
const RENAME_OR_COPY = /^[RC]/;

function normalizeStatus(token: string): GitChangeStatus | null {
  const letter = token[0]?.toUpperCase();
  if (!letter) return null;
  if ("AMDRCTUXB".includes(letter)) return letter as GitChangeStatus;
  return null;
}

/**
 * Parse `git diff --name-status -z` output. With `-z` every field is
 * NUL-terminated: `<status>\0<path>\0` for ordinary changes, and
 * `<status>\0<old>\0<new>\0` for renames/copies (the status keeps its score,
 * e.g. `R100`). Unparseable trailing fragments are ignored.
 */
export function parseNameStatusZ(raw: string): GitChange[] {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const out: GitChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const statusToken = tokens[i];
    const status = normalizeStatus(statusToken);
    if (!status) {
      i += 1;
      continue;
    }
    if (RENAME_OR_COPY.test(statusToken)) {
      const oldPath = tokens[i + 1];
      const path = tokens[i + 2];
      if (oldPath && path) out.push({ status, path, oldPath });
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path) out.push({ status, path });
      i += 2;
    }
  }
  return out;
}

/**
 * Parse the tab-delimited (non `-z`) `git diff --name-status` form. Each line is
 * `<status>\t<path>` or `<status>\t<old>\t<new>` for renames/copies. Blank lines
 * are skipped.
 */
export function parseNameStatus(raw: string): GitChange[] {
  const out: GitChange[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    const status = normalizeStatus(fields[0] ?? "");
    if (!status) continue;
    if (RENAME_OR_COPY.test(fields[0]) && fields[1] && fields[2]) {
      out.push({ status, path: fields[2], oldPath: fields[1] });
    } else if (fields[1]) {
      out.push({ status, path: fields[1] });
    }
  }
  return out;
}

/** The split of a changed-file set into work the incremental refresh performs. */
export interface IngestSelection {
  /** Paths whose current content should be (re-)indexed. */
  reindexed: string[];
  /** Paths whose graph elements should go stale (deletions, rename sources). */
  removed: string[];
  /**
   * Deduped, ordered union handed to the incremental refresh. `refreshFiles`
   * re-indexes present files and stales the ones it can no longer read, so a
   * single list covers both reindex and removal.
   */
  paths: string[];
}

/**
 * Decide what an incremental re-ingest does for a set of parsed changes:
 *
 * - `A` / `M` / `T` / `U` → re-index the path (content changed).
 * - `C` (copy) → re-index the destination; the source is untouched.
 * - `R` (rename) → re-index the destination; stale the source.
 * - `D` (delete) → stale the path.
 * - `X` / `B` (unknown / broken pairing) → ignored.
 *
 * The returned `paths` is deduped and order-preserving so re-feeding the same
 * diff is stable.
 */
export function selectIngestPaths(changes: GitChange[]): IngestSelection {
  const reindexed: string[] = [];
  const removed: string[] = [];
  for (const change of changes) {
    switch (change.status) {
      case "A":
      case "M":
      case "T":
      case "U":
      case "C":
        reindexed.push(change.path);
        break;
      case "R":
        reindexed.push(change.path);
        if (change.oldPath) removed.push(change.oldPath);
        break;
      case "D":
        removed.push(change.path);
        break;
      default:
        // X (unknown) and B (broken pairing) carry no reliable path to index.
        break;
    }
  }
  const paths = [...new Set([...reindexed, ...removed])];
  return { reindexed, removed, paths };
}

/** A git revision range to diff, or `null` when nothing should be diffed. */
export interface RevRange {
  from: string;
  to: string;
}

/**
 * Resolve the diff range for a `post-checkout` hook. Git invokes it with
 * `<prev-HEAD> <new-HEAD> <flag>`, where `flag` is `"1"` for a branch checkout
 * and `"0"` for a file checkout. Only branch checkouts that actually moved HEAD
 * drive a refresh; everything else is a no-op.
 */
export function postCheckoutRange(
  prevHead: string,
  newHead: string,
  flag: string,
): RevRange | null {
  if (flag !== "1") return null;
  if (!prevHead || !newHead) return null;
  if (prevHead === newHead) return null;
  return { from: prevHead, to: newHead };
}

/**
 * Resolve the diff range for a `post-commit` hook: the just-made commit against
 * its first parent, or against the {@link EMPTY_TREE_OID} when it is the root
 * commit (no parent).
 */
export function postCommitRange(head: string, parent: string | undefined): RevRange {
  return { from: parent && parent.length > 0 ? parent : EMPTY_TREE_OID, to: head };
}
