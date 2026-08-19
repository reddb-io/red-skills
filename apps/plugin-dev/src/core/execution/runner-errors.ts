import { isRunnerExhausted } from "../runner-spawn.js";

/** True when a sandcastle failure carries a runner exhaustion signal. */
export function isExhaustionError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const parts: string[] = [];
  collectErrorStrings(error, parts, new Set(), 0);
  return parts.some((part) => isRunnerExhausted(part));
}

/** True when a sandcastle failure is a transient transport/setup failure. */
export function isTransientRunnerError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  const parts: string[] = [];
  collectErrorStrings(error, parts, new Set(), 0);
  return parts.some((part) => RUNNER_TRANSIENT_PATTERN.test(part));
}

const RUNNER_TRANSIENT_PATTERN =
  /failed to connect to websocket|HTTP error:\s*502 Bad Gateway|HTTP error:\s*503 Service Unavailable|\b529\b|overloaded|wss:\/\/chatgpt\.com\/backend-api\/codex\/responses|thread\/start failed|failed to load configuration|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|could not lock config file/i;

type HostConfigFailure = "missing-interpreter" | "missing-cwd";

function hostConfigFailure(error: unknown): HostConfigFailure | null {
  if (error === null || error === undefined) return null;
  const parts: string[] = [];
  collectErrorStrings(error, parts, new Set(), 0);
  if (parts.some((part) => /spawn\s+sh\s+ENOENT/i.test(part))) return "missing-interpreter";
  if (parts.some((part) => /cwd does not exist/i.test(part))) return "missing-cwd";
  return null;
}

/** Permanent runner-host defects that cannot heal through cooldown or fallback. */
export function isHostConfigRunnerError(error: unknown): boolean {
  return hostConfigFailure(error) !== null;
}

export function hostConfigOperatorMessage(error: unknown): string {
  if (hostConfigFailure(error) === "missing-interpreter") {
    return "afk: fatal host configuration: required POSIX shell `sh` could not be spawned (spawn sh ENOENT). Install or restore the required shell, then rerun; this failure is not retryable.";
  }
  return "afk: fatal host configuration: the worker current directory does not exist. Restore the configured workspace/current directory, then rerun; this failure is not retryable.";
}

/** Gather strings from a bounded, potentially cyclic Effect Cause graph. */
function collectErrorStrings(value: unknown, out: string[], seen: Set<object>, depth: number): void {
  if (depth > 5) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  const rendered = String(value);
  if (rendered && rendered !== "[object Object]") out.push(rendered);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    collectErrorStrings(nested, out, seen, depth + 1);
  }
}
