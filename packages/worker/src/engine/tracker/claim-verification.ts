import type { AcquireClaimOptions, ClaimGh, RawClaimComment } from "./claim.js";

/**
 * Why a claim read-back never saw our own marker.
 *
 * **`propagation` is a race we lost the wait for; `infrastructure` is a read
 * that cannot be believed** — only the first is evidence about the claim. An
 * EMPTY list after we wrote a comment to that issue is an impossible world: our
 * own write is missing from a total that counts it. Conceding to it fed the
 * claim healer a conflict that never happened, and three of those quarantined
 * four healthy Tickets (#4049).
 */
export type ClaimVerificationFailure = "propagation" | "infrastructure";

export class ClaimVerificationError extends Error {
  readonly kind: ClaimVerificationFailure;

  constructor(message: string, kind: ClaimVerificationFailure = "propagation") {
    super(message);
    this.name = "ClaimVerificationError";
    this.kind = kind;
  }
}

/**
 * Classify an exhausted read-back. Zero cannot be a true count when we hold the
 * id of a comment WE wrote, so an all-empty run is infrastructure; one empty
 * answer among populated ones is still ordinary propagation.
 */
export function classifyVerificationFailure(input: {
  readonly sawPopulatedList: boolean;
  readonly lastMessage: string;
}): ClaimVerificationFailure {
  return !input.sawPopulatedList && / from 0 listed comment/.test(input.lastMessage)
    ? "infrastructure"
    : "propagation";
}

/** The sentence appended when a read-back could not be believed. */
const UNBELIEVABLE_READ_BACK_DETAIL =
  " — every read-back listed zero comments while our own claim comment existed," +
  " so this is a read that cannot be believed rather than a lost race";

const DEFAULT_VERIFY_ATTEMPTS = 4;
const DEFAULT_VERIFY_DELAY_MS = 1000;

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read the issue's claim markers back until OUR OWN marker is visible (the
 * verification step). Retries a list that has not yet propagated and a list call
 * that failed outright; throws `ClaimVerificationError` when every attempt is
 * exhausted. Never returns a list that lacks our marker — that ambiguity is what
 * made a sole claimant concede its own freshly minted issue (#2385).
 */
export async function listVerifiedClaims(
  gh: ClaimGh,
  issue: number,
  commentId: number,
  opts: AcquireClaimOptions,
): Promise<RawClaimComment[]> {
  const attempts = Math.max(1, opts.verifyAttempts ?? DEFAULT_VERIFY_ATTEMPTS);
  const delayMs = opts.verifyDelayMs ?? DEFAULT_VERIFY_DELAY_MS;
  const sleep = opts.sleep ?? realSleep;
  let lastError: unknown;
  let sawPopulatedList = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && delayMs > 0) await sleep(delayMs);
    let raw: RawClaimComment[];
    try {
      raw = await gh.listClaims(issue);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (raw.some((c) => c.id === commentId)) return raw;
    if (raw.length > 0) sawPopulatedList = true;
    lastError = new Error(`our claim comment ${commentId} was absent from ${raw.length} listed comment(s)`);
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  const kind = classifyVerificationFailure({ sawPopulatedList, lastMessage: detail });
  throw new ClaimVerificationError(
    `claim verification failed on #${issue} after ${attempts} read-back attempt(s): ${detail}` +
      (kind === "infrastructure" ? UNBELIEVABLE_READ_BACK_DETAIL : ""),
    kind,
  );
}

