// gh/band.ts — the reserved band, applied at the boundary that spends the budget.
//
// ADR 0132 Amendment 2, issue #3095. The balance is asked by ONE poller (the
// daemon's) and interpreted here, because what a call is WORTH is castle
// semantics the daemon may not carry: `issue comment` is a finished Worker's
// closing comment on one call and an optional progress note on the next, and only
// the caller can tell them apart.
//
// **Semi-offline stops being a mode discovered through a 403.** Before this, a
// spent quota announced itself by refusing a call — which meant the first thing
// to fail was whatever happened to run first, often the claim. With an
// authoritative balance the refusal is graduated and ordered: convenience reads
// are refused once the balance enters the band, and the claim, a landing and a
// finishing Worker's closing comment keep passing until the pool has nothing left
// at all.
//
// **THE CLAIM NEVER DAMS.** Claiming is three layers — local `mkdir` lock, the
// GitHub claim marker, stale-lock boot sweep — and damming the middle one leaves
// a host-local lock: safe on one machine, and two Workers on one branch the
// moment a second host drains the same backlog. So `essential` is refused only by
// a pool with nothing left, where GitHub would refuse it anyway, and a Worker
// that cannot write its claim declines the issue rather than proceeding.
//
// **Absence of a balance opens the gate, never closes it.** No daemon, no
// credential, an endpoint that changed shape — each leaves the posture `unknown`,
// and `unknown` degrades to the reactive breaker that predates this module.
// Refusing every read on an unread balance would turn a reporting failure into an
// outage.
//
// **One daemon read per cadence, never one per call.** The gate caches the
// balance for the window the balance itself asked for, so the hot path pays at
// most one socket round trip per cadence — the same reason the balance is polled
// rather than checked before each call (ADR 0084's lesson).

import {
  admitGithubOperation,
  balanceFromReport,
  createGithubCache,
  describeGithubCacheRead,
  githubBalanceCadenceMs,
  routeGithubArgs,
  tryRouteGithubArgs,
  type GithubAdmission,
  type GithubBalance,
  type GithubCallCriticality,
} from "@reddb-io/github";

/** The one key the gate keeps: this host's balance, as the daemon last read it. */
const BALANCE_CACHE_KEY = "github:balance";

/** How the gate obtains the balance the daemon polled. */
export type GhBalanceReader = () => Promise<GithubBalance | null>;

/** One refusal, carrying the numbers it turned on. */
export interface GhBandRefusal {
  readonly admission: GithubAdmission;
  /** The sentence a caller logs or parks with. */
  readonly message: string;
}

export interface GhBandGate {
  /**
   * Whether this argv may run now. Resolves to `null` when it may — the common
   * answer, and the one the hot path is optimized for.
   */
  admit(args: readonly string[], criticality: GithubCallCriticality): Promise<GhBandRefusal | null>;
}

export interface CreateGhBandGateOptions {
  readonly readBalance: GhBalanceReader;
  /** The clock the cache ages against; the real one when absent. */
  readonly nowIso?: () => string;
  /** The band's fraction; the package default when absent. */
  readonly reservedFraction?: number;
}

/**
 * A gate over one balance reader, caching the answer for the cadence the balance
 * itself asked for.
 *
 * The cache is what keeps this off the hot path: the balance moves at the
 * daemon's poll rate, so reading it per call would spend a socket round trip to
 * learn a number that cannot have changed.
 */
export function createGhBandGate(options: CreateGhBandGateOptions): GhBandGate {
  const nowIso = options.nowIso ?? (() => new Date().toISOString());
  // The shared cache, not a private one: a kept value must travel with its age,
  // and a second staleness implementation here is how two surfaces come to
  // disagree about how old the same number is (#3095).
  const cache = createGithubCache({ freshMs: 30_000, capacity: 1 });
  let inFlight: Promise<GithubBalance | null> | null = null;

  async function balance(): Promise<GithubBalance | null> {
    const kept = cache.read<GithubBalance | null>(BALANCE_CACHE_KEY, { now: nowIso() });
    if (kept.outcome === "fresh") return kept.value ?? null;
    if (inFlight != null) return await inFlight;
    inFlight = options
      .readBalance()
      .catch(() => null)
      .then((answer) => {
        // The freshness window comes from the balance itself, so a tight balance
        // is re-read often and a roomy one is left alone — the same adaptation
        // the poller makes, applied to the reader rather than to the ask.
        const freshMs = answer == null ? 30_000 : githubBalanceCadenceMs(answer, { now: nowIso() });
        cache.put({ key: BALANCE_CACHE_KEY, kind: "github-balance", value: answer, fetchedAt: nowIso(), freshMs });
        return answer;
      })
      .finally(() => {
        inFlight = null;
      });
    return await inFlight;
  }

  /** How old the balance a refusal turned on is — rendered, never assumed. */
  function keptAge(): string {
    return describeGithubCacheRead(cache.read(BALANCE_CACHE_KEY, { now: nowIso() }));
  }

  return {
    async admit(args, criticality): Promise<GhBandRefusal | null> {
      // An operation nobody classified is not this module's to refuse: the
      // routing table raises on it where a human can name it, and a gate that
      // swallowed it would turn a missing table line into a silent throttle.
      if (tryRouteGithubArgs(args) == null) return null;
      const answer = await balance();
      if (answer == null) return null;
      const admission = admitGithubOperation({
        balance: answer,
        operation: routeGithubArgs(args),
        criticality,
        ...(options.reservedFraction === undefined ? {} : { reservedFraction: options.reservedFraction }),
      });
      if (admission.admitted) return null;
      return { admission, message: renderBandRefusal(args, admission, keptAge()) };
    },
  };
}

/**
 * The sentence a refusal carries — the threshold and the AGE, not just the
 * verdict. PURE.
 *
 * The age is in the sentence because a refusal is a judgement on a kept number:
 * an operator reading "refused" deserves to know whether the balance behind it
 * was read a second ago or a poll ago.
 */
export function renderBandRefusal(
  args: readonly string[],
  admission: GithubAdmission,
  balanceAge?: string,
): string {
  return (
    `gh ${args.join(" ")} was not issued: ${admission.reason}` +
    (balanceAge ? ` [balance ${balanceAge}]` : "") +
    (admission.posture === "spent"
      ? ""
      : ` — the band exists so the claim, a landing and a finishing Worker's closing comment still pass`)
  );
}

/** A gate that admits everything, for a caller with no balance to consult. PURE. */
export const OPEN_GH_BAND_GATE: GhBandGate = {
  async admit(): Promise<GhBandRefusal | null> {
    return null;
  },
};

/**
 * Read the balance the daemon already polled, off the statusline payload.
 *
 * **The project never asks GitHub for it.** One poller host-wide is the whole
 * decision: a second asker would double the request count and would answer a
 * question the daemon has already answered for every project on the machine. A
 * daemon that is absent, older than the balance poller, or holding no credential
 * yields `null`, and `null` opens the gate.
 */
export function daemonGhBalanceReader(): GhBalanceReader {
  return async (): Promise<GithubBalance | null> => {
    try {
      const { readRedskilledStatuslinePayload } = await import("@reddb-io/redskilled/client");
      const { resolveRedskilledPaths } = await import("@reddb-io/redskilled/paths");
      const payload = await readRedskilledStatuslinePayload(resolveRedskilledPaths({}));
      const report = payload.github_balance;
      if (report == null) return null;
      return balanceFromReport(report);
    } catch {
      // No daemon, no socket, no balance — and no refusal either. The reactive
      // breaker that predates this module still applies.
      return null;
    }
  };
}

let defaultGate: GhBandGate | null = null;

/**
 * The gate a call runs under, defaulting to the DAEMON-BACKED one.
 *
 * Injection stays available for tests; ABSENCE of injection does not mean absence
 * of the band. That is the whole lesson of #2800 — an opt-in safety primitive
 * whose only populator is a test ships as a green suite over a binary with no
 * protection at all — and it applies exactly as much to a budget gate as it did
 * to quota backoff. The default is a process-wide singleton so the balance is
 * read once per cadence for the whole process rather than once per call site.
 */
export function resolveGhBandGate(injected?: GhBandGate): GhBandGate {
  if (injected) return injected;
  defaultGate ??= createGhBandGate({ readBalance: daemonGhBalanceReader() });
  return defaultGate;
}
