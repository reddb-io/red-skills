// deadline.ts — every GitHub call this package issues is bounded, and a stall
// becomes a loud error instead of a quiet forever.
//
// **A hang is not a slow success.** Node's `fetch` applies no total-request
// deadline: a socket that stops answering after the request is written leaves the
// promise pending until undici's own five-minute header timeout, and octokit's
// retry plugin then pays that cost again per attempt. The observed shape (#3768)
// was a fifteen-minute freeze that finally returned the right answer — nothing in
// the process was broken, nothing logged, and every liveness surface read the
// caller as healthy, because a patient wait and a wedged one are the same
// observation from outside.
//
// **The bound belongs to the transport, not to each call site.** A deadline
// spelled at one call site is a deadline missing from the next one written, so
// the timed fetch wraps whatever `fetch` the client was given and every request
// inherits it — including the ones this package does not know about yet.
//
// **A joiner inherits the bound too.** The second half of that freeze was a
// single-flight cache: one stalled balance ask, and every later caller awaited
// the same dead promise having issued nothing itself. `withGithubDeadline` is
// what a coalescing reader wraps its shared promise in, so joining a stalled
// leader costs the joiner its own deadline rather than the leader's patience.

/** How long one GitHub request may take before it is a failure. */
export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/** How long a balance ask may take. Shorter: an unknown balance is a legal answer. */
export const DEFAULT_GITHUB_BALANCE_TIMEOUT_MS = 10_000;

/** The operator's override, in milliseconds. `0` disables the bound entirely. */
export const GITHUB_REQUEST_TIMEOUT_ENV = "RED_GITHUB_REQUEST_TIMEOUT_MS";

/**
 * One GitHub call that passed its deadline.
 *
 * The message carries the subject and the bound, because the operator reading it
 * is deciding whether the network is slow or the bound is wrong, and cannot tell
 * those apart from the word "timeout".
 */
export class GithubTimeoutError extends Error {
  readonly subject: string;
  readonly timeoutMs: number;

  constructor(subject: string, timeoutMs: number, options?: { readonly cause?: unknown }) {
    super(
      `GitHub ${subject} passed its ${timeoutMs}ms deadline and was abandoned; ` +
        `raise ${GITHUB_REQUEST_TIMEOUT_ENV} if this host is genuinely this slow`,
      options,
    );
    this.name = "GithubTimeoutError";
    this.subject = subject;
    this.timeoutMs = timeoutMs;
  }
}

/** True when `error` is this package's own deadline refusal. */
export function isGithubTimeoutError(error: unknown): error is GithubTimeoutError {
  return error instanceof GithubTimeoutError;
}

/**
 * The request bound this process runs under. PURE given `env`.
 *
 * An unreadable or negative override is the default rather than an error: this
 * is read on the hot path, and a typo in an env var must not be the thing that
 * takes GitHub reads down.
 */
export function githubRequestTimeoutMs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[GITHUB_REQUEST_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
  return Math.trunc(parsed);
}

/**
 * Run `work` under a deadline, without waiting for `work` to notice.
 *
 * The abandoned promise may still settle later — a transport with no cancellation
 * surface cannot be recalled — so a caller must commit state only from THIS
 * promise's value, never from inside `work`. A rejection the abandoned work
 * produces afterwards is swallowed here, because an unhandled rejection from a
 * call nobody is waiting for is noise that reads as a second failure.
 */
export async function withGithubDeadline<T>(
  subject: string,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GithubTimeoutError(subject, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  const running = Promise.resolve().then(work);
  running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface CreateTimedGithubFetchOptions {
  /** The transport to bound; the platform `fetch` when absent. */
  readonly fetchImpl?: typeof fetch;
  /** The bound; the env-tunable process default when absent. */
  readonly timeoutMs?: number;
}

/**
 * `fetch`, bounded — the shape every GitHub transport in this package is built on.
 *
 * **The signal and the race are both required, and they do different jobs.** The
 * signal is the cancellation: aborting tears the socket down, so an abandoned
 * request stops holding a connection and stops counting against the pool. The
 * race is the guarantee: a transport that does not honour its signal — a shim, a
 * mock, an interceptor written before signals existed — would otherwise turn a
 * bounded call back into a forever, which is the exact defect this module exists
 * to end. A bound that only works when the transport cooperates is not a bound.
 *
 * A caller that brought its own signal keeps it — both are honoured, and only the
 * deadline's own abort is renamed, so a caller that cancelled deliberately never
 * reads its own cancellation as a timeout.
 */
export function createTimedGithubFetch(options: CreateTimedGithubFetchOptions = {}): typeof fetch {
  const call = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? githubRequestTimeoutMs();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return call;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const caller = init?.signal ?? null;
    const signal = caller == null ? deadline : AbortSignal.any([caller, deadline]);
    const subject = describeRequest(input);
    try {
      return await withGithubDeadline(subject, timeoutMs, async () =>
        await call(input, { ...(init ?? {}), signal }));
    } catch (error) {
      if (isGithubTimeoutError(error)) throw error;
      if (deadline.aborted && caller?.aborted !== true) {
        throw new GithubTimeoutError(subject, timeoutMs, { cause: error });
      }
      throw error;
    }
  }) as typeof fetch;
}

/** The subject a timeout names: the route, never the token-bearing headers. */
function describeRequest(input: Parameters<typeof fetch>[0]): string {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
    ? input.href
    : typeof (input as { url?: unknown }).url === "string"
    ? (input as { url: string }).url
    : "request";
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
