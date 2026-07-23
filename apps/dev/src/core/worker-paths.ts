export interface WorkerAttemptIdentity {
  worker: string;
  issue: number;
  attempt: number;
}

export function isValidWorkerId(worker: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(worker);
}

export function isPositiveIntegerToken(token: string | number): boolean {
  return typeof token === "number"
    ? Number.isInteger(token) && token >= 1
    : /^[1-9][0-9]*$/.test(token);
}

function normalizeRoot(root: string): string {
  return root.replace(/\/$/, "");
}

/**
 * Worker-lane namespaces readers still understand under `.red/tmp/`. New castle
 * workers write to the shared `workers` root with `current.kind` carrying
 * `afk`/`go`/`scout`; the `go-workers` and `scout-workers` lanes remain here so
 * read-only observability surfaces can UNION legacy live workers until their
 * lanes age out.
 */
export const WORKER_NAMESPACES = ["workers", "go-workers", "scout-workers"] as const;

/**
 * Every per-namespace workers root under a `.red/tmp` dir, for read-only union
 * discovery. Namespace-blind on purpose: it does NOT consult
 * `RED_AFK_WORKERS_NAMESPACE`, so an aggregating reader with no env override
 * still sees all lanes. A namespace whose directory is absent on disk simply
 * contributes nothing (the caller's glob swallows ENOENT), never an error.
 */
export function allWorkersRoots(tmpDir: string): string[] {
  if (!tmpDir) throw new Error("tmpDir is required");
  const base = normalizeRoot(tmpDir);
  return WORKER_NAMESPACES.map((ns) => `${base}/${ns}`);
}

/**
 * The worker-tree segment under the tmp root. Defaults to `workers` (the castle
 * worker root). `RED_AFK_WORKERS_NAMESPACE` remains as a legacy compatibility
 * override for still-migrating lanes such as scout; `/go` no longer sets it.
 * Only a `[A-Za-z0-9_-]+` value is honoured; anything else falls back to
 * `workers`.
 */
export function workersSegment(): string {
  const ns = process.env.RED_AFK_WORKERS_NAMESPACE;
  return ns && /^[A-Za-z0-9_-]+$/.test(ns) ? ns : "workers";
}

function asPositiveInteger(value: string | number, field: string): number {
  if (!isPositiveIntegerToken(value)) throw new Error(`invalid ${field}: ${value}`);
  return typeof value === "number" ? value : Number(value);
}

export function buildWorkerAttemptPath(
  root: string,
  worker: string,
  issueValue: string | number,
  _attemptValue: string | number,
): string {
  if (!root) throw new Error("root is required");
  if (!isValidWorkerId(worker)) throw new Error(`invalid worker id: ${worker}`);
  const issue = asPositiveInteger(issueValue, "issue");
  asPositiveInteger(_attemptValue, "attempt");
  return `${normalizeRoot(root)}/${workersSegment()}/${worker}/${issue}`;
}

export function parseWorkerAttemptPath(path: string): WorkerAttemptIdentity | null {
  if (!path) return null;
  const normalized = path.replace(/\/$/, "");
  // Accept every worker-lane segment so a parked-attempt path reverses
  // regardless of which lane minted it.
  // The attempt-ordinal grammar (`-a{N}`) is retired (ADR 0103): the path
  // constructor no longer mints it, so readers no longer parse it. A legacy
  // `{issue}-a{n}` directory minted before the constructor dropped the suffix
  // simply fails to match here and is ignored rather than crashing a reader.
  const match = normalized.match(/(?:^|\/)(?:workers|go-workers|scout-workers)\/([^/]+)\/([1-9][0-9]*)$/);
  if (!match) return null;
  const [, worker, issue] = match;
  if (!isValidWorkerId(worker)) return null;
  return { worker, issue: Number(issue), attempt: 1 };
}

/** The git worktree for a new worker, colocated directly inside its workspace. */
export function buildWorkerWorktreePath(
  root: string,
  worker: string,
  issueValue: string | number,
  attemptValue: string | number,
): string {
  return `${buildWorkerAttemptPath(root, worker, issueValue, attemptValue)}/worktree`;
}

/**
 * Strict reader for the current worker-worktree grammar. Castle-branded nested
 * paths deliberately do not match; only hygiene sweeps retain that legacy
 * knowledge through {@link parseReapableWorkerWorktreePath}.
 */
export function parseWorkerWorktreePath(path: string): WorkerAttemptIdentity | null {
  if (!path) return null;
  const normalized = path.replace(/\/$/, "");
  const match = normalized.match(
    /(?:^|\/)(?:workers|go-workers|scout-workers)\/([^/]+)\/([1-9][0-9]*)\/worktree$/,
  );
  if (!match) return null;
  const [, worker, issue] = match;
  if (!isValidWorkerId(worker)) return null;
  return { worker, issue: Number(issue), attempt: 1 };
}

/**
 * HYGIENE-ONLY worktree parser. Accepts the current `{issue}/worktree` path
 * plus castle-branded nested paths (including pre-ADR-0103 attempt suffixes)
 * so a mixed live fleet never introduces an orphan class during rollout.
 */
export function parseReapableWorkerWorktreePath(path: string): WorkerAttemptIdentity | null {
  if (!path) return null;
  const normalized = path.replace(/\/$/, "");
  const match = normalized.match(
    /(?:^|\/)(?:workers|go-workers|scout-workers)\/([^/]+)\/([1-9][0-9]*)(?:-a([1-9][0-9]*))?\/(?:worktree|\.red-castle\/worktrees\/[^/]+)$/,
  );
  if (!match) return null;
  const [, worker, issue, attempt] = match;
  if (!isValidWorkerId(worker)) return null;
  return { worker, issue: Number(issue), attempt: attempt ? Number(attempt) : 1 };
}

/**
 * HYGIENE-ONLY parser: accepts BOTH the flat `{issue}` grammar and the retired
 * legacy `{issue}-a{n}` grammar. Sweeps (orphan/cap reaps) must keep seeing
 * pre-ADR-0103 directories so they can DELETE them — identity readers use the
 * strict {@link parseWorkerAttemptPath} instead and simply ignore legacy dirs.
 */
export function parseReapableWorkerPath(path: string): WorkerAttemptIdentity | null {
  if (!path) return null;
  const normalized = path.replace(/\/$/, "");
  const match = normalized.match(
    /(?:^|\/)(?:workers|go-workers|scout-workers)\/([^/]+)\/([1-9][0-9]*)(?:-a([1-9][0-9]*))?$/,
  );
  if (!match) return null;
  const [, worker, issue, attempt] = match;
  if (!isValidWorkerId(worker)) return null;
  return { worker, issue: Number(issue), attempt: attempt ? Number(attempt) : 1 };
}

export function issueAttemptsGlob(root: string, issueValue: string | number): string {
  if (!root) throw new Error("root is required");
  const issue = asPositiveInteger(issueValue, "issue");
  return `${normalizeRoot(root)}/${workersSegment()}/*/${issue}*`;
}

export function workersGlob(root: string): string {
  if (!root) throw new Error("root is required");
  return `${normalizeRoot(root)}/${workersSegment()}/*`;
}

export function workerDir(root: string, worker: string): string {
  if (!root) throw new Error("root is required");
  if (!isValidWorkerId(worker)) throw new Error(`invalid worker id: ${worker}`);
  return `${normalizeRoot(root)}/${workersSegment()}/${worker}`;
}

export function workerPidFile(root: string, worker: string): string {
  return `${workerDir(root, worker)}/worker.pid`;
}

export function livePidsGlob(root: string): string {
  if (!root) throw new Error("root is required");
  return `${normalizeRoot(root)}/${workersSegment()}/*/worker.pid`;
}
