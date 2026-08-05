// balance.ts — the token's remaining budget, ASKED rather than counted.
//
// ADR 0132 Amendment 2. The predecessor design was a ledger the daemon
// **accumulates**: every caller reports its calls, the daemon totals them. That
// ledger would have been born blind. The daemon is host-scoped by construction —
// one per machine, and ADR 0130 deliberately extinguished the cross-host view —
// while GitHub's quota is per **token**, therefore cross-host. An operator
// running four machines on one token would have had four daemons each counting
// its own share and each reporting three quarters of a fiction: *"I have spent
// 2000 of 5000"* while the token already sat at zero.
//
// **The fix is not federation. It is to stop counting and start asking.** `GET
// /rate_limit` returns the true remaining budget for the whole token across every
// machine, and it costs nothing — measured, six consecutive calls moved `core` by
// exactly zero. The daemon does not need to know the operator's other machines
// exist; it sees their effect in the balance.
//
// Three properties follow, and each is enforced here rather than asked for in
// prose:
//
//   **The balance carries its origin in its type.** {@link GithubBalance.origin}
//   is the literal `"asked"`, so a well-meaning local accumulator cannot produce
//   one without saying, in the type, that it did not ask. The companion ratchet
//   (`asked-balance-guard.ts`) refuses the accumulator itself.
//
//   **The cadence is a function of the balance.** Because asking is free, cadence
//   is derived rather than fixed: rare above half, tightening as the balance
//   falls, continuous once spent — when the only event that still matters is the
//   reset. A fixed cadence forces a choice between being slow at the edge and
//   wasting polls in the middle; an adaptive one does not choose. **One poller,
//   the daemon's, never a check before each call** — that would double the
//   request count and put a synchronous round trip in every hot path, which is
//   ADR 0084's lesson paid twice.
//
//   **A stated fraction is reserved.** With an authoritative balance in hand the
//   breaker stops being reactive: convenience reads are refused once the balance
//   enters the reserved band, while the claim, a landing and a finishing Worker's
//   closing comment still pass. Semi-offline stops being a mode discovered
//   through a 403 and becomes a posture entered at a threshold an operator sees.
//
// **A caveat, stated rather than assumed:** `GET /rate_limit` is free of
// *primary* quota only. GitHub also enforces secondary limits on request rate and
// concurrency across every endpoint, so the cadence must stay a cadence — seconds,
// never a poll per operation. {@link GITHUB_BALANCE_MIN_CADENCE_MS} is that floor,
// and the ceiling it defends was deliberately not probed.
//
// PURE, apart from `fetchGithubBalance` and `createGithubBalanceTransport`, whose
// transport is injected.

import type { GithubApiSurface, GithubOperation, GithubRateBudget } from "./surface.js";

/**
 * The gh argv this ask is equivalent to: `gh api rate_limit`.
 *
 * Stated as an argv so the surface is a lookup in the shared routing table rather
 * than a second opinion about it — the table already classifies any `gh api <path>`
 * that is not `graphql` as a single REST request.
 */
export const GITHUB_RATE_LIMIT_ARGV: readonly string[] = ["api", "rate_limit"];

/** The REST path the balance comes from, named once. */
export const GITHUB_RATE_LIMIT_PATH = "rate_limit";

/**
 * The endpoint's own name for each pool this repo budgets.
 *
 * GitHub calls the request-metered pool `core`; this repo calls it `rest`, after
 * the API that draws it. Both names travel, because an operator reading GitHub's
 * documentation and an operator reading a payload here must be able to line the
 * two up.
 */
export const GITHUB_POOL_RESOURCES: Readonly<Record<GithubRateBudget, string>> = {
  rest: "core",
  graphql: "graphql",
  search: "search",
};

/** Every pool a call can draw from, in the order a report lists them. */
export const GITHUB_POOLS: readonly GithubRateBudget[] = ["rest", "graphql", "search"];

/** One pool's balance, exactly as the endpoint reported it. */
export interface GithubPoolBalance {
  readonly pool: GithubRateBudget;
  /** GitHub's own name for this pool, so the two vocabularies line up. */
  readonly resource: string;
  readonly limit: number;
  readonly remaining: number;
  /** The endpoint's own `used`, echoed — never `limit - remaining` recomputed. */
  readonly used: number;
  readonly reset_at: string;
  /** `remaining / limit`, the number every threshold here is stated against. */
  readonly fraction: number;
}

/**
 * Whether this document is an answer or the absence of one.
 *
 * `unanswered` is its own outcome rather than an empty `asked`, because the
 * failure this whole amendment was written about surfaced as a plausible number
 * rather than as an error. A balance nobody could ask for is not a full budget
 * and is not a spent one.
 */
export type GithubBalanceOutcome = "asked" | "unanswered";

/** The token's remaining budget, across every machine that shares the token. */
export interface GithubBalance {
  readonly version: 1;
  /**
   * How this balance was obtained — and the literal type is the point.
   *
   * There is no second member. A path that derived a balance by counting its own
   * calls could not construct this document without declaring an origin that does
   * not exist, so the regression this module exists to prevent fails to compile
   * before it fails a test.
   */
  readonly origin: "asked";
  readonly outcome: GithubBalanceOutcome;
  /** The authoritative source, named so nobody has to guess which one answered. */
  readonly source: "GET /rate_limit";
  readonly asked_at: string;
  /** How many requests this ask cost. One when it happened, zero when it did not. */
  readonly request_count: number;
  /** Each pool's balance, or `null` for a pool the endpoint did not report. */
  readonly pools: Readonly<Record<GithubRateBudget, GithubPoolBalance | null>>;
  /** Pools the answer carried nothing for — an absence, never a zero. */
  readonly unreported_pools: readonly GithubRateBudget[];
  readonly detail: string;
}

/** The document a daemon that has asked nothing holds: honest, and empty. */
export function unaskedGithubBalance(at: string, detail?: string): GithubBalance {
  return {
    version: 1,
    origin: "asked",
    outcome: "unanswered",
    source: "GET /rate_limit",
    asked_at: at,
    request_count: 0,
    pools: { rest: null, graphql: null, search: null },
    unreported_pools: [...GITHUB_POOLS],
    detail: detail ?? "no balance has been asked for yet, so none is known",
  };
}

/**
 * One step of the adaptive cadence, as data so a test can pin the shape of the
 * curve rather than one of its values.
 *
 * Read as a ladder: the first step whose `at_or_below_fraction` the tightest pool
 * is at or under decides the window. The steps are the argument — rare above
 * half, tightening as the balance falls, continuous once spent — and the exact
 * milliseconds are merely their instance.
 */
export interface GithubBalanceCadenceStep {
  readonly at_or_below_fraction: number;
  readonly every_ms: number;
  readonly why: string;
}

/**
 * The floor under every window.
 *
 * `GET /rate_limit` is free of PRIMARY quota; GitHub's secondary limits on
 * request rate and concurrency apply to it like any other endpoint. This is what
 * keeps the adaptive cadence a cadence — seconds, never a poll per operation.
 */
export const GITHUB_BALANCE_MIN_CADENCE_MS = 15_000;

/**
 * The fraction of each pool held for work that must not fail.
 *
 * Declared as a fraction rather than as a count because the three pools are
 * metered differently — 5000 requests, 5000 node points, 30 searches a minute —
 * and a reserve stated in absolute terms would mean three different postures.
 *
 * Declared BEFORE the cadence ladder, which names it: the band and the step that
 * watches it must be one number, or the poller would ask least often at exactly
 * the fraction where the posture changes.
 */
export const GITHUB_RESERVED_FRACTION = 0.15;

/** The adaptive cadence, tightest step first. */
export const GITHUB_BALANCE_CADENCE: readonly GithubBalanceCadenceStep[] = [
  {
    at_or_below_fraction: 0,
    every_ms: GITHUB_BALANCE_MIN_CADENCE_MS,
    why: "spent: the only event that still matters is the reset, so watch for it",
  },
  {
    at_or_below_fraction: GITHUB_RESERVED_FRACTION,
    every_ms: 30_000,
    why: "inside the reserved band: the posture can change between two calls",
  },
  {
    at_or_below_fraction: 0.5,
    every_ms: 120_000,
    why: "below half: tightening, because the band is now reachable inside one window",
  },
  {
    at_or_below_fraction: 1,
    every_ms: 600_000,
    why: "above half: rare, because nothing this balance decides is anywhere close",
  },
];

/**
 * What posture the balance puts a pool in.
 *
 * `unknown` is not a fourth degree of scarcity — it is the absence of an answer,
 * and it degrades to the reactive behaviour that predates this module rather than
 * to a refusal. Refusing every convenience read because `GET /rate_limit` changed
 * shape would turn a reporting failure into an outage.
 */
export type GithubBalancePosture = "open" | "reserved" | "spent" | "unknown";

/**
 * What a call is worth, stated by the caller that knows.
 *
 * The daemon executes and the project decides (ADR 0132 Amendment 1), so this
 * never becomes a table here: `issue comment` is the closing comment of a
 * finished Worker on one call and an optional progress note on the next, and only
 * the caller can tell them apart. What this module owns is what the two words
 * MEAN once said.
 *
 * - `essential`   — the claim, a landing, a finished Worker's closing comment.
 *                   Refused only by a pool with nothing left at all.
 * - `convenience` — a read that can be answered from cache, later, or not at all.
 */
export type GithubCallCriticality = "essential" | "convenience";

/** One stable rung of the preferred-to-fallback routing ramp. */
export type GithubDiversionBand = "none" | "low" | "high" | "full";

export interface GithubDiversionBandDefinition {
  /** Source-pool pressure that enters this rung. */
  readonly enter_pressure: number;
  /** Lower pressure that must be crossed before leaving this rung. */
  readonly leave_pressure: number;
  /** Destination-budget share to spend before pricing the operation itself. */
  readonly budget_share: number;
}

/**
 * The routing ramp, expressed as budget shares rather than call shares.
 *
 * Entry and exit differ deliberately. A balance moving around 70% or 90% must
 * not alternate surfaces on every ask and discard both surfaces' warm caches.
 */
export const GITHUB_DIVERSION_BANDS: Readonly<Record<GithubDiversionBand, GithubDiversionBandDefinition>> = {
  none: { enter_pressure: 0, leave_pressure: 0, budget_share: 0 },
  low: { enter_pressure: 0.7, leave_pressure: 0.65, budget_share: 0.25 },
  high: { enter_pressure: 0.9, leave_pressure: 0.85, budget_share: 0.6 },
  full: { enter_pressure: 1, leave_pressure: 0.98, budget_share: 1 },
};

/** GitHub's REST and GraphQL primary pools both reset on an hourly window. */
const GITHUB_PRIMARY_RATE_WINDOW_MS = 60 * 60_000;

export interface GithubDiversionInput {
  readonly balance: GithubBalance | null;
  readonly operation: GithubOperation;
  /** The decision instant, explicit so replaying a Worker is deterministic. */
  readonly now: string;
  /** Stable identity of the concrete read, such as operation + repository. */
  readonly routingKey: string;
  /** Number of fallback-pool units this read is projected to consume. */
  readonly projectedDestinationCost: number;
  /** Last rung observed for this route, when a caller retains hysteresis state. */
  readonly previousBand?: GithubDiversionBand;
}

export interface GithubDiversionDecision {
  readonly surface: GithubApiSurface;
  readonly preferred: GithubApiSurface;
  readonly fallback: GithubApiSurface | null;
  readonly diverted: boolean;
  readonly band: GithubDiversionBand;
  readonly source_pressure: number | null;
  /** Call share after the destination cost has priced the budget share. */
  readonly diversion_share: number;
  readonly projected_destination_cost: number;
  readonly reason: string;
}

/** One admission verdict, with everything an operator needs to argue with it. */
export interface GithubAdmission {
  readonly admitted: boolean;
  readonly posture: GithubBalancePosture;
  readonly pool: GithubRateBudget;
  readonly criticality: GithubCallCriticality;
  readonly remaining: number | null;
  /** The count below which convenience reads are refused; `null` when unknown. */
  readonly reserved_floor: number | null;
  readonly reset_at: string | null;
  readonly reason: string;
}

/** The balance report a surface renders: posture, age, and the next ask. */
export interface GithubBalanceReport {
  readonly version: 1;
  readonly origin: "asked";
  readonly outcome: GithubBalanceOutcome;
  readonly asked_at: string | null;
  readonly age_ms: number | null;
  readonly threshold_ms: number;
  readonly stale: boolean;
  /** The worst posture across every reported pool — the one that governs. */
  readonly posture: GithubBalancePosture;
  readonly reserved_fraction: number;
  readonly next_poll_ms: number;
  readonly pools: readonly GithubPoolBalance[];
  readonly unreported_pools: readonly GithubRateBudget[];
  readonly reason: string;
}

/**
 * How old a balance may be before a report calls it stale, as a multiple of the
 * cadence that balance itself asked for.
 *
 * Two windows, for the same reason the memory sampler uses two of its own: one
 * missed interval is the jitter of a busy host, and two is a poller that stopped.
 */
export const GITHUB_BALANCE_STALENESS_FACTOR = 2;

/**
 * Read one `GET /rate_limit` answer. PURE.
 *
 * Every number comes straight out of the payload, including `used` — recomputing
 * it as `limit - remaining` would be the first derivation, and the first
 * derivation is how a document stops being an answer and starts being an opinion.
 */
export function parseGithubBalance(payload: unknown, options: { readonly askedAt: string }): GithubBalance {
  const root = asRecord(payload);
  const resources = asRecord(root.resources);
  const pools: Record<GithubRateBudget, GithubPoolBalance | null> = { rest: null, graphql: null, search: null };
  const unreported: GithubRateBudget[] = [];

  for (const pool of GITHUB_POOLS) {
    const resource = GITHUB_POOL_RESOURCES[pool];
    const node = resources[resource];
    const parsed = readPool(pool, resource, node);
    pools[pool] = parsed;
    if (parsed == null) unreported.push(pool);
  }

  const answered = GITHUB_POOLS.length - unreported.length;
  return {
    version: 1,
    origin: "asked",
    outcome: answered > 0 ? "asked" : "unanswered",
    source: "GET /rate_limit",
    asked_at: options.askedAt,
    request_count: 1,
    pools,
    unreported_pools: unreported,
    detail: answered > 0
      ? `the token's own answer for ${answered} of ${GITHUB_POOLS.length} pools`
      : "the answer carried no pool this repo budgets, so nothing about the token is known",
  };
}

/** How a balance ask reaches GitHub; injected so nothing here opens a socket. */
export type GithubBalanceTransport = () => Promise<unknown>;

export interface FetchGithubBalanceInput {
  readonly transport: GithubBalanceTransport;
  readonly now: string;
}

/**
 * Ask once. One request, and never more than one.
 *
 * A transport that throws comes back as `unanswered` carrying the thrown sentence
 * rather than as an empty balance: a refusal that read as a full budget would
 * admit every convenience read at exactly the moment the token stopped answering.
 */
export async function fetchGithubBalance(input: FetchGithubBalanceInput): Promise<GithubBalance> {
  try {
    const payload = await input.transport();
    return parseGithubBalance(payload, { askedAt: input.now });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...unaskedGithubBalance(input.now, `the balance ask failed before the token answered: ${reason}`),
      request_count: 1,
    };
  }
}

/**
 * The tightest reported pool — the one whose scarcity governs. PURE.
 *
 * Returns `null` when no pool was reported, which is the difference between "the
 * roomiest pool is empty" and "nothing answered".
 */
export function tightestGithubPool(balance: GithubBalance): GithubPoolBalance | null {
  let tightest: GithubPoolBalance | null = null;
  for (const pool of GITHUB_POOLS) {
    const candidate = balance.pools[pool];
    if (candidate == null) continue;
    if (tightest == null || candidate.fraction < tightest.fraction) tightest = candidate;
  }
  return tightest;
}

/**
 * How long until the next ask. PURE.
 *
 * Driven by the TIGHTEST pool rather than by an average or by `core`: the pool
 * about to run out is the one whose crossing changes a decision, and the balance
 * that measured `2200 GraphQL points spent while core sat at 5000/5000` is
 * precisely the shape an average would have called healthy.
 */
export function githubBalanceCadenceMs(balance: GithubBalance, options: { readonly now: string }): number {
  const tightest = tightestGithubPool(balance);
  if (tightest == null) {
    // Blind is not full. Ask again on the band's window — often enough to
    // recover quickly, never often enough to become a poll per operation.
    return stepFor(GITHUB_RESERVED_FRACTION).every_ms;
  }
  const step = stepFor(tightest.fraction);
  if (tightest.remaining > 0) return step.every_ms;
  // Spent: the reset is the only event left, so never sleep past it — and never
  // under the floor either, because the secondary limits do not reset with the
  // primary ones.
  const untilReset = msBetween(options.now, tightest.reset_at);
  if (untilReset == null) return step.every_ms;
  return Math.max(GITHUB_BALANCE_MIN_CADENCE_MS, Math.min(step.every_ms, untilReset));
}

/** The count below which convenience reads are refused for a pool. PURE. */
export function githubReservedFloor(
  pool: GithubPoolBalance,
  reservedFraction: number = GITHUB_RESERVED_FRACTION,
): number {
  return Math.ceil(pool.limit * reservedFraction);
}

/** What posture one pool is in. PURE. */
export function githubBalancePosture(
  balance: GithubBalance,
  pool: GithubRateBudget,
  reservedFraction: number = GITHUB_RESERVED_FRACTION,
): GithubBalancePosture {
  const reported = balance.pools[pool];
  if (reported == null) return "unknown";
  if (reported.remaining <= 0) return "spent";
  return reported.remaining < githubReservedFloor(reported, reservedFraction) ? "reserved" : "open";
}

export interface AdmitGithubCallInput {
  readonly balance: GithubBalance | null;
  readonly pool: GithubRateBudget;
  readonly criticality: GithubCallCriticality;
  readonly reservedFraction?: number;
}

/**
 * Whether this call may be made now. PURE.
 *
 * Graduated by construction: a spent pool refuses everything because GitHub would
 * anyway, a pool inside the band refuses only what can wait, and an open pool
 * refuses nothing. The verdict carries the numbers it turned on, so an operator
 * reading a refusal never has to reconstruct the threshold that produced it.
 */
export function admitGithubCall(input: AdmitGithubCallInput): GithubAdmission {
  const reservedFraction = input.reservedFraction ?? GITHUB_RESERVED_FRACTION;
  const reported = input.balance?.pools[input.pool] ?? null;
  if (input.balance == null || reported == null) {
    return {
      admitted: true,
      posture: "unknown",
      pool: input.pool,
      criticality: input.criticality,
      remaining: null,
      reserved_floor: null,
      reset_at: null,
      reason:
        `no authoritative balance names the ${input.pool} pool, so this call is admitted and the reactive breaker ` +
        `still decides: refusing on an unread balance would turn a reporting failure into an outage`,
    };
  }

  const floor = githubReservedFloor(reported, reservedFraction);
  const posture = githubBalancePosture(input.balance, input.pool, reservedFraction);
  const base = {
    pool: input.pool,
    criticality: input.criticality,
    remaining: reported.remaining,
    reserved_floor: floor,
    reset_at: reported.reset_at,
  } as const;

  if (posture === "spent") {
    return {
      ...base,
      admitted: false,
      posture,
      reason:
        `the ${input.pool} pool is spent, so not even ${input.criticality} work can be issued until the quota ` +
        `resets at ${reported.reset_at}`,
    };
  }
  if (posture === "reserved" && input.criticality === "convenience") {
    return {
      ...base,
      admitted: false,
      posture,
      reason:
        `${reported.remaining} of ${reported.limit} left in the ${input.pool} pool is inside the reserved band of ` +
        `${floor}, which is held for the claim, a landing and a finishing Worker's closing comment; this read can ` +
        `wait, be answered from cache, or not happen at all`,
    };
  }
  return {
    ...base,
    admitted: true,
    posture,
    reason: posture === "reserved"
      ? `${reported.remaining} of ${reported.limit} left in the ${input.pool} pool is inside the reserved band of ` +
        `${floor}, and essential work is exactly what the band is held for`
      : `${reported.remaining} of ${reported.limit} left in the ${input.pool} pool, above the reserved band of ${floor}`,
  };
}

/**
 * Whether a CLASSIFIED operation may be made now. PURE.
 *
 * The pool comes from the routing table rather than from the caller, so a call
 * site cannot state a surface and then be admitted against a different pool's
 * balance — which is the same class of mistake as classifying every `--json` read
 * as GraphQL and then measuring REST.
 */
export function admitGithubOperation(input: {
  readonly balance: GithubBalance | null;
  readonly operation: GithubOperation;
  readonly criticality: GithubCallCriticality;
  readonly reservedFraction?: number;
}): GithubAdmission {
  return admitGithubCall({
    balance: input.balance,
    pool: input.operation.budget,
    criticality: input.criticality,
    ...(input.reservedFraction === undefined ? {} : { reservedFraction: input.reservedFraction }),
  });
}

/**
 * Choose between a read's preferred surface and its declared fallback. PURE.
 *
 * Raw source pressure only opens a rung when the observed burn rate projects
 * exhaustion before reset. A nearly-spent pool twenty seconds from reset
 * therefore stays preferred, while the same balance early in its window starts
 * spending the idle fallback. Partial rungs are priced in destination budget:
 * a five-page REST collection gets one fifth the call share of a one-page read.
 */
export function githubDiversionDecision(input: GithubDiversionInput): GithubDiversionDecision {
  const preferred = input.operation.surface;
  const fallback = input.operation.fallback ?? null;
  const base = {
    preferred,
    fallback,
    projected_destination_cost: input.projectedDestinationCost,
  } as const;
  const stay = (
    reason: string,
    sourcePressure: number | null = null,
  ): GithubDiversionDecision => ({
    ...base,
    surface: preferred,
    diverted: false,
    band: "none",
    source_pressure: sourcePressure,
    diversion_share: 0,
    reason,
  });

  if (fallback == null) {
    return stay(
      `${input.operation.key} has no fallback surface, so balance cannot divert it`,
    );
  }
  if (input.operation.kind !== "read" || input.operation.budget === "search") {
    return stay(`${input.operation.key} is not eligible for diverted read traffic`);
  }

  const destinationPoolName = budgetForSurface(fallback);
  const source = input.balance?.pools[input.operation.budget] ?? null;
  const destination = input.balance?.pools[destinationPoolName] ?? null;
  if (source == null || destination == null) {
    return stay(
      `the ${source == null ? input.operation.budget : destinationPoolName} pool is unknown; an unread ledger is not evidence of a free fallback`,
    );
  }

  const sourcePressure = pressureOf(source);
  if (!Number.isFinite(input.projectedDestinationCost) || input.projectedDestinationCost <= 0) {
    return stay("the projected destination cost is not a positive finite budget amount", sourcePressure);
  }
  if (destination.remaining < input.projectedDestinationCost) {
    return stay(
      `the ${destinationPoolName} fallback has ${destination.remaining} left, below this read's projected cost of ${input.projectedDestinationCost}`,
      sourcePressure,
    );
  }
  if (pressureOf(destination) >= sourcePressure) {
    return stay(
      `the ${destinationPoolName} fallback is not healthier than the ${input.operation.budget} preferred pool`,
      sourcePressure,
    );
  }

  const spent = source.remaining <= 0 || sourcePressure >= 1;
  if (!spent && !projectsExhaustionBeforeReset(source, input.now)) {
    return stay(
      `the ${input.operation.budget} pool does not project exhaustion before its reset at ${source.reset_at}`,
      sourcePressure,
    );
  }

  const band = diversionBand(sourcePressure, input.previousBand);
  if (band === "none") {
    return stay(
      `the ${input.operation.budget} pool is below the first diversion entry band`,
      sourcePressure,
    );
  }

  const budgetShare = GITHUB_DIVERSION_BANDS[band].budget_share;
  const diversionShare = band === "full"
    ? 1
    : Math.min(1, budgetShare / input.projectedDestinationCost);
  const bucket = stableDiversionBucket(`${input.operation.key}\u0000${input.routingKey}`);
  const diverted = bucket < diversionShare;
  return {
    ...base,
    surface: diverted ? fallback : preferred,
    diverted,
    band,
    source_pressure: sourcePressure,
    diversion_share: diversionShare,
    reason:
      `${input.operation.budget} pressure ${sourcePressure.toFixed(3)} entered the ${band} ramp; ` +
      `${input.projectedDestinationCost} projected ${destinationPoolName} budget unit(s) price ` +
      `the ${budgetShare.toFixed(2)} budget share as a ${diversionShare.toFixed(3)} call share; ` +
      `stable bucket ${bucket.toFixed(3)} ${diverted ? "selects" : "does not select"} the fallback`,
  };
}

function budgetForSurface(surface: GithubApiSurface): GithubRateBudget {
  return surface;
}

function pressureOf(pool: GithubPoolBalance): number {
  if (pool.limit <= 0) return pool.remaining <= 0 ? 1 : 0;
  return Math.max(0, Math.min(1, pool.used / pool.limit));
}

function projectsExhaustionBeforeReset(pool: GithubPoolBalance, now: string): boolean {
  if (pool.remaining <= 0) return true;
  if (pool.used <= 0) return false;
  const nowMs = Date.parse(now);
  const resetMs = Date.parse(pool.reset_at);
  if (!Number.isFinite(nowMs) || !Number.isFinite(resetMs) || resetMs <= nowMs) return false;
  const untilResetMs = Math.min(GITHUB_PRIMARY_RATE_WINDOW_MS, resetMs - nowMs);
  const elapsedMs = Math.max(1, GITHUB_PRIMARY_RATE_WINDOW_MS - untilResetMs);
  const projectedAdditionalSpend = (pool.used / elapsedMs) * untilResetMs;
  return projectedAdditionalSpend >= pool.remaining;
}

function diversionBand(pressure: number, previous: GithubDiversionBand | undefined): GithubDiversionBand {
  if (pressure >= GITHUB_DIVERSION_BANDS.full.enter_pressure) return "full";
  if (pressure >= GITHUB_DIVERSION_BANDS.high.enter_pressure) return "high";
  if (pressure >= GITHUB_DIVERSION_BANDS.low.enter_pressure) return "low";

  if (previous === "full" || previous === "high") {
    if (pressure >= GITHUB_DIVERSION_BANDS.high.leave_pressure) return "high";
  }
  if (previous !== undefined && previous !== "none") {
    if (pressure >= GITHUB_DIVERSION_BANDS.low.leave_pressure) return "low";
  }
  return "none";
}

/** FNV-1a mapped to [0, 1), stable across processes and JavaScript runtimes. */
function stableDiversionBucket(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

/**
 * Date the balance so the consumer renders the age instead of inventing it. PURE.
 *
 * The report exists so `"the queue looks empty"` and `"we are out of quota"` are
 * never the same screen: a surface that holds only counts has no way to tell
 * them apart, and the posture printed beside the counts is what separates them.
 */
export function buildGithubBalanceReport(input: {
  readonly balance: GithubBalance | null;
  readonly now: string;
  readonly stalenessMs?: number;
  readonly reservedFraction?: number;
}): GithubBalanceReport {
  const reservedFraction = input.reservedFraction ?? GITHUB_RESERVED_FRACTION;
  const balance = input.balance;
  if (balance == null) {
    return {
      version: 1,
      origin: "asked",
      outcome: "unanswered",
      asked_at: null,
      age_ms: null,
      threshold_ms: stepFor(reservedFraction).every_ms * GITHUB_BALANCE_STALENESS_FACTOR,
      stale: false,
      posture: "unknown",
      reserved_fraction: reservedFraction,
      next_poll_ms: stepFor(reservedFraction).every_ms,
      pools: [],
      unreported_pools: [...GITHUB_POOLS],
      reason: "this daemon has asked for no balance, so the token's budget is unknown rather than full",
    };
  }

  const nextPollMs = githubBalanceCadenceMs(balance, { now: input.now });
  const threshold = input.stalenessMs ?? nextPollMs * GITHUB_BALANCE_STALENESS_FACTOR;
  const ageMs = msBetween(balance.asked_at, input.now);
  const stale = balance.outcome === "asked" && (ageMs == null || ageMs > threshold);
  const pools = GITHUB_POOLS.map((pool) => balance.pools[pool]).filter((pool): pool is GithubPoolBalance => pool != null);
  const posture = worstPosture(balance, reservedFraction);
  const tightest = tightestGithubPool(balance);

  return {
    version: 1,
    origin: "asked",
    outcome: balance.outcome,
    asked_at: balance.asked_at,
    age_ms: ageMs,
    threshold_ms: threshold,
    stale,
    posture,
    reserved_fraction: reservedFraction,
    next_poll_ms: nextPollMs,
    pools,
    unreported_pools: balance.unreported_pools,
    reason: stale
      ? `this balance is stale: asked ${ageMs == null ? "at an unreadable instant" : `${ageMs}ms ago`}, past the ` +
        `${threshold}ms window, so the posture below is the last one the token confirmed and not the current one`
      : describePosture(posture, tightest, balance, reservedFraction),
  };
}

/**
 * The balance a report was built from. PURE.
 *
 * A report travels on the wire and a balance is what an admission turns on, so a
 * consumer that received the first and needs the second must not rebuild it by
 * hand: the pools are the same objects, only re-keyed. Nothing is invented here —
 * a pool the report did not carry stays `null`.
 */
export function balanceFromReport(report: GithubBalanceReport): GithubBalance {
  const pools: Record<GithubRateBudget, GithubPoolBalance | null> = { rest: null, graphql: null, search: null };
  for (const pool of report.pools) pools[pool.pool] = pool;
  return {
    version: 1,
    origin: "asked",
    outcome: report.outcome,
    source: "GET /rate_limit",
    asked_at: report.asked_at ?? "",
    request_count: report.outcome === "asked" ? 1 : 0,
    pools,
    unreported_pools: report.unreported_pools,
    detail: report.reason,
  };
}

/**
 * True when `value` is a complete balance report — a client's fail-closed check.
 *
 * A consumer that accepted a partial report would render a posture it cannot
 * trust, and the whole point of the posture is that an operator can act on it.
 */
export function isGithubBalanceReport(value: unknown): value is GithubBalanceReport {
  if (!isRecord(value)) return false;
  const report = value as Record<string, unknown>;
  return report.version === 1 &&
    report.origin === "asked" &&
    (report.outcome === "asked" || report.outcome === "unanswered") &&
    (report.asked_at === null || typeof report.asked_at === "string") &&
    (report.age_ms === null || typeof report.age_ms === "number") &&
    typeof report.threshold_ms === "number" &&
    typeof report.stale === "boolean" &&
    typeof report.posture === "string" &&
    typeof report.reserved_fraction === "number" &&
    typeof report.next_poll_ms === "number" &&
    Array.isArray(report.pools) &&
    Array.isArray(report.unreported_pools) &&
    typeof report.reason === "string";
}

function describePosture(
  posture: GithubBalancePosture,
  tightest: GithubPoolBalance | null,
  balance: GithubBalance,
  reservedFraction: number,
): string {
  if (tightest == null) return balance.detail;
  const floor = githubReservedFloor(tightest, reservedFraction);
  switch (posture) {
    case "spent":
      return `the ${tightest.pool} pool is spent and resets at ${tightest.reset_at}: work is not queued, it is refused`;
    case "reserved":
      return `the ${tightest.pool} pool has ${tightest.remaining} of ${tightest.limit} left, inside the reserved band ` +
        `of ${floor}: convenience reads are refused and the claim, a landing and a closing comment still pass`;
    default:
      return `the ${tightest.pool} pool is the tightest at ${tightest.remaining} of ${tightest.limit}, above the ` +
        `reserved band of ${floor}`;
  }
}

function worstPosture(balance: GithubBalance, reservedFraction: number): GithubBalancePosture {
  let worst: GithubBalancePosture = "unknown";
  for (const pool of GITHUB_POOLS) {
    if (balance.pools[pool] == null) continue;
    const posture = githubBalancePosture(balance, pool, reservedFraction);
    if (posture === "spent") return "spent";
    if (posture === "reserved" || worst === "unknown") worst = posture;
  }
  return worst;
}

function stepFor(fraction: number): GithubBalanceCadenceStep {
  for (const step of GITHUB_BALANCE_CADENCE) {
    if (fraction <= step.at_or_below_fraction) return step;
  }
  return GITHUB_BALANCE_CADENCE[GITHUB_BALANCE_CADENCE.length - 1]!;
}

function readPool(pool: GithubRateBudget, resource: string, value: unknown): GithubPoolBalance | null {
  if (!isRecord(value)) return null;
  const limit = integer(value.limit);
  const remaining = integer(value.remaining);
  const used = integer(value.used);
  const reset = integer(value.reset);
  if (limit == null || limit <= 0 || remaining == null) return null;
  return {
    pool,
    resource,
    limit,
    remaining,
    used: used ?? 0,
    reset_at: reset == null ? "" : new Date(reset * 1000).toISOString(),
    fraction: remaining / limit,
  };
}

/**
 * The GitHub balance transport, built around one token.
 *
 * `fetch` is injected so a test never opens a socket. An HTTP refusal throws
 * rather than returning an empty body, because an empty body read as a balance is
 * the failure mode this whole module was written about.
 */
export function createGithubBalanceTransport(options: {
  readonly token: string;
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
}): GithubBalanceTransport {
  const origin = options.origin ?? "https://api.github.com";
  const call = options.fetchImpl ?? fetch;
  return async (): Promise<unknown> => {
    const response = await call(`${origin}/${GITHUB_RATE_LIMIT_PATH}`, {
      method: "GET",
      headers: {
        authorization: `bearer ${options.token}`,
        accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) {
      throw new Error(`the balance ask was refused with HTTP ${response.status}`);
    }
    return await response.json();
  };
}

function msBetween(from: string, to: string): number | null {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.max(0, toMs - fromMs);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
