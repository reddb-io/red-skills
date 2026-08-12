/**
 * client-reconnect — bounded patience for an established daemon connection.
 *
 * A successful reach is session-sticky; a failure never is. That distinction
 * lets a long-lived MCP client follow socket churn without turning a genuinely
 * absent first-time daemon into a replacement wait.
 */
import { redskilledPresenceAdvice, type RedskilledPresence } from "./daemon-presence.js";

/** How long an established client follows a daemon through replacement. */
export const DEFAULT_REDSKILLED_RECONNECT_TIMEOUT_MS = 30_000;
/** The first reconnect pause; subsequent pauses double up to eight seconds. */
export const DEFAULT_REDSKILLED_RECONNECT_BACKOFF_MS = 500;
const MAX_REDSKILLED_RECONNECT_BACKOFF_MS = 8_000;

const establishedSockets = new Set<string>();

/** Transport silence: distinct from a daemon's application-level refusal. */
export class RedskilledUnreachableError extends Error {
  constructor(
    readonly socketPath: string,
    override readonly cause: unknown,
    readonly presence?: RedskilledPresence,
  ) {
    super(
      `redskilled daemon is unreachable on ${JSON.stringify(socketPath)}, so no Worker was started: ${
        cause instanceof Error ? cause.message : String(cause)
      }${presence?.kind === "held-unresponsive" ? `. ${redskilledPresenceAdvice(presence)}` : ""}`,
    );
    this.name = "RedskilledUnreachableError";
  }
}

/** Transport silence while a live pid still holds the daemon lease. */
export class RedskilledDaemonHeldError extends RedskilledUnreachableError {
  constructor(socketPath: string, override readonly presence: RedskilledPresence, cause: unknown) {
    super(socketPath, cause, presence);
    this.name = "RedskilledDaemonHeldError";
  }
}

export interface RedskilledReconnectConfig {
  /** Total patience for reconnecting through socket churn. */
  readonly reconnectTimeoutMs?: number;
  /** First exponential-backoff pause; injectable so transport tests stay fast. */
  readonly reconnectInitialBackoffMs?: number;
}

interface RedskilledReconnectOperation<T> {
  readonly socketPath: string;
  readonly config: RedskilledReconnectConfig;
  readonly attempt: (remainingMs: number) => Promise<T>;
  readonly retryable: (error: unknown, previouslyEstablished: boolean) => boolean;
  readonly exhausted?: (error: unknown, timeoutMs: number) => unknown;
}

/**
 * Run one logical client operation through a bounded exponential-backoff
 * window. Each attempt gets the remaining budget so nested reach/request work
 * cannot silently mint a fresh thirty-second window.
 */
export async function reconnectRedskilled<T>(operation: RedskilledReconnectOperation<T>): Promise<T> {
  const timeoutMs = operation.config.reconnectTimeoutMs ?? DEFAULT_REDSKILLED_RECONNECT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let backoffMs = operation.config.reconnectInitialBackoffMs ?? DEFAULT_REDSKILLED_RECONNECT_BACKOFF_MS;

  for (;;) {
    try {
      const result = await operation.attempt(Math.max(0, deadline - Date.now()));
      establishedSockets.add(operation.socketPath);
      return result;
    } catch (error) {
      if (!operation.retryable(error, establishedSockets.has(operation.socketPath))) throw error;
      if (Date.now() >= deadline) throw operation.exhausted?.(error, timeoutMs) ?? error;
      await pauseUntil(deadline, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_REDSKILLED_RECONNECT_BACKOFF_MS);
    }
  }
}

/** Preserve presence while making an exhausted replacement wait explicit. */
export function redskilledReconnectExhausted(error: unknown, timeoutMs: number): unknown {
  if (!(error instanceof RedskilledUnreachableError)) return error;
  const holder = error.presence?.kind === "held-unresponsive" ? error.presence.holder : null;
  const cause = new Error(
    `daemon replacing/booting, retrying with exponential backoff for ${timeoutMs}ms exhausted` +
      (holder == null ? "" : `; holder pid ${holder.pid}`),
    { cause: error },
  );
  return holder == null || error.presence == null
    ? new RedskilledUnreachableError(error.socketPath, cause, error.presence)
    : new RedskilledDaemonHeldError(error.socketPath, error.presence, cause);
}

async function pauseUntil(deadline: number, backoffMs: number): Promise<void> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, remainingMs)));
}
