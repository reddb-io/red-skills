/**
 * ETag conditional-polling core (#2514, Spec #2511 slice 3) — the PURE half of
 * the polling transport. GitHub REST reads are made conditional with
 * `If-None-Match`; a 304 is free against the rate limit and produces no
 * events. Check-run transitions are derived by snapshot diffing so one
 * completed check emits exactly one `check.completed` delivery, and the poll
 * cadence honors the server's `X-Poll-Interval`.
 *
 * Rate-limit budget: with E armed endpoints and a cadence of max(60,
 * X-Poll-Interval) seconds, steady state costs E requests/minute of which
 * unchanged ones are 304s (not counted against the core limit) — the warm
 * resident answers PR-state questions from the lane instead of fresh `gh`
 * spawns.
 */

export interface ConditionalResponse {
  /** HTTP status: 200 (changed), 304 (unchanged), anything else = error. */
  readonly status: number;
  readonly etag?: string;
  /** Server-requested minimum poll interval in seconds (X-Poll-Interval). */
  readonly pollIntervalS?: number;
  /** Epoch ms at which the rate-limit window resets (`x-ratelimit-reset`, sent
   * by GitHub in epoch SECONDS). */
  readonly resetAtMs?: number;
  /** The `retry-after` directive in seconds, when the response carries one. */
  readonly retryAfterS?: number;
  /** Parsed JSON body when status is 200. */
  readonly body?: unknown;
}

/** Parse a raw `gh api -i` response (headers + blank line + body). */
export function parseConditionalResponse(raw: string): ConditionalResponse {
  const separator = raw.indexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const cut = raw.indexOf(separator);
  const head = cut >= 0 ? raw.slice(0, cut) : raw;
  const bodyText = cut >= 0 ? raw.slice(cut + separator.length).trim() : "";
  const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(head);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const etagMatch = /^etag:\s*(.+)$/im.exec(head);
  const pollMatch = /^x-poll-interval:\s*(\d+)$/im.exec(head);
  const resetMatch = /^x-ratelimit-reset:\s*(\d+)$/im.exec(head);
  const retryAfterMatch = /^retry-after:\s*(\d+)$/im.exec(head);
  let body: unknown;
  if (status === 200 && bodyText !== "") {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = undefined;
    }
  }
  return {
    status,
    ...(etagMatch ? { etag: etagMatch[1]!.trim() } : {}),
    ...(pollMatch ? { pollIntervalS: Number(pollMatch[1]) } : {}),
    ...(resetMatch ? { resetAtMs: Number(resetMatch[1]) * 1000 } : {}),
    ...(retryAfterMatch ? { retryAfterS: Number(retryAfterMatch[1]) } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

/** The server-supplied pacing carried by a rate-limited response. */
export interface RateLimitPacing {
  /** Epoch ms at which the exhausted window resets. */
  readonly resetAtMs?: number;
  /** The `retry-after` directive in seconds. */
  readonly retryAfterS?: number;
}

/**
 * Delay before the next poll after a RATE-LIMITED response: sleep until the
 * reset instant the response supplied, else honour its `retry-after`
 * directive, else fall back to the floor. Never shorter than the floor —
 * polling a quota at zero is what this replaces — and never longer than
 * `capMs`, so a bogus far-future reset cannot turn the loop into a hang.
 */
export function rateLimitDelayMs(
  pacing: RateLimitPacing,
  nowMs: number,
  floorS: number,
  capMs: number,
): number {
  const requestedMs =
    pacing.resetAtMs !== undefined
      ? pacing.resetAtMs - nowMs
      : pacing.retryAfterS !== undefined
        ? pacing.retryAfterS * 1000
        : 0;
  return Math.min(Math.max(requestedMs, floorS * 1000), capMs);
}

/** Next poll delay: the server's X-Poll-Interval always wins when larger than
 * the configured floor; absent, the floor applies. */
export function nextPollDelayMs(pollIntervalS: number | undefined, floorS: number): number {
  return Math.max(floorS, pollIntervalS ?? 0) * 1000;
}

/** Per-check snapshot for one PR head: check name → `status/conclusion`. */
export type CheckSnapshot = Readonly<Record<string, string>>;

export interface CheckDelivery {
  readonly event: "check_run";
  readonly action: "completed";
  readonly pr: number;
  readonly check: string;
  readonly conclusion: string;
}

/** Snapshot a check-runs API body (`{check_runs: [{name,status,conclusion}]}`). */
export function snapshotCheckRuns(body: unknown): CheckSnapshot {
  const runs =
    body && typeof body === "object" && Array.isArray((body as { check_runs?: unknown[] }).check_runs)
      ? ((body as { check_runs: unknown[] }).check_runs as {
          name?: string;
          status?: string;
          conclusion?: string | null;
        }[])
      : [];
  const snapshot: Record<string, string> = {};
  for (const run of runs) {
    if (!run || typeof run.name !== "string") continue;
    snapshot[run.name] = `${run.status ?? ""}/${run.conclusion ?? ""}`;
  }
  return snapshot;
}

/** Exactly one `check.completed` delivery per check that TRANSITIONED to
 * completed since the previous snapshot — an unchanged completed check never
 * re-emits. */
export function diffCheckRuns(
  pr: number,
  previous: CheckSnapshot,
  next: CheckSnapshot,
): CheckDelivery[] {
  const deliveries: CheckDelivery[] = [];
  for (const [check, state] of Object.entries(next)) {
    const [status, conclusion] = state.split("/");
    if (status !== "completed") continue;
    if (previous[check] === state) continue;
    deliveries.push({
      event: "check_run",
      action: "completed",
      pr,
      check,
      conclusion: conclusion ?? "",
    });
  }
  return deliveries;
}
