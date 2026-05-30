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
  return `${normalizeRoot(root)}/workers/${worker}/${issue}-a${attempt}`;
}

export function parseWorkerAttemptPath(path: string): WorkerAttemptIdentity | null {
  if (!path) return null;
  const normalized = path.replace(/\/$/, "");
  const match = normalized.match(/(?:^|\/)workers\/([^/]+)\/([1-9][0-9]*)-a([1-9][0-9]*)$/);
  if (!match) return null;
  const [, worker, issue, attempt] = match;
  if (!isValidWorkerId(worker)) return null;
  return { worker, issue: Number(issue), attempt: Number(attempt) };
}

export function issueAttemptsGlob(root: string, issueValue: string | number): string {
  if (!root) throw new Error("root is required");
  const issue = asPositiveInteger(issueValue, "issue");
  return `${normalizeRoot(root)}/workers/*/${issue}-a*`;
}

export function workersGlob(root: string): string {
  if (!root) throw new Error("root is required");
  return `${normalizeRoot(root)}/workers/*`;
}

export function workerDir(root: string, worker: string): string {
  if (!root) throw new Error("root is required");
  if (!isValidWorkerId(worker)) throw new Error(`invalid worker id: ${worker}`);
  return `${normalizeRoot(root)}/workers/${worker}`;
}

export function workerPidFile(root: string, worker: string): string {
  return `${workerDir(root, worker)}/worker.pid`;
}

export function livePidsGlob(root: string): string {
  if (!root) throw new Error("root is required");
  return `${normalizeRoot(root)}/workers/*/worker.pid`;
}
