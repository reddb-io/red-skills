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
 * The canonical worker-lane namespaces under `.red/tmp/`. The `/afk` fleet lives
 * in `workers`, a `/go` dispatch in `go-workers`, a `--scout` run in
 * `scout-workers`. Each RUN-TIME write path stays scoped to its single
 * {@link workersSegment} lane (via `RED_AFK_WORKERS_NAMESPACE`), but the
 * read-only observability surfaces (statusline/monitor/dashboard) must UNION
 * over all of these — a live `/go` or `--scout` worker is one more live worker.
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
 * The worker-tree segment under the tmp root. Defaults to `workers` (the `/afk`
 * fleet). A `/go` dispatch sets `RED_AFK_WORKERS_NAMESPACE=go-workers` in its
 * own process so its worker dir + worktree land under `.red/tmp/go-workers/`,
 * never colliding with the fleet's `.red/tmp/workers/`. The override is read
 * per-call so it is process-scoped: the fleet supervisor (no env) keeps seeing
 * `workers/` and never manages a `/go` worker, preserving lane isolation. Only
 * a `[A-Za-z0-9_-]+` value is honoured; anything else falls back to `workers`.
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
  attemptValue: string | number,
): string {
  if (!root) throw new Error("root is required");
  if (!isValidWorkerId(worker)) throw new Error(`invalid worker id: ${worker}`);
  const issue = asPositiveInteger(issueValue, "issue");
  const attempt = asPositiveInteger(attemptValue, "attempt");
  return `${normalizeRoot(root)}/${workersSegment()}/${worker}/${issue}-a${attempt}`;
}

export function parseWorkerAttemptPath(path: string): WorkerAttemptIdentity | null {
  if (!path) return null;
  const normalized = path.replace(/\/$/, "");
  // Accept every worker-lane segment so a parked-attempt path reverses
  // regardless of which lane minted it.
  const match = normalized.match(/(?:^|\/)(?:workers|go-workers|scout-workers)\/([^/]+)\/([1-9][0-9]*)-a([1-9][0-9]*)$/);
  if (!match) return null;
  const [, worker, issue, attempt] = match;
  if (!isValidWorkerId(worker)) return null;
  return { worker, issue: Number(issue), attempt: Number(attempt) };
}

export function issueAttemptsGlob(root: string, issueValue: string | number): string {
  if (!root) throw new Error("root is required");
  const issue = asPositiveInteger(issueValue, "issue");
  return `${normalizeRoot(root)}/${workersSegment()}/*/${issue}-a*`;
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
