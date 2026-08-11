/**
 * statusline-extras — the blocks that scale with Worker count, served on request.
 *
 * **A withheld fact and a missing one are opposite things** (ADR 0132 decision
 * 2). The skeleton — Workers, projects, budget — is served on every response,
 * because ADR 0130 rule 9 already entitles a session to the whole machine and
 * withholding it buys only a second round trip. What scales with Worker count
 * travels on request, and the response SAYS which blocks it left out: a Worker
 * whose vitals nobody asked for carries the same `rss_bytes: null` a Worker
 * nobody measured carries, and only `withheld` tells them apart.
 *
 * Its own module rather than a corner of the payload's, because this is a
 * different question: `statusline-payload` decides what one answer CONTAINS, and
 * this decides how much of that answer one reader asked for.
 *
 * PURE — one payload in, one payload out, nothing read and nothing stored.
 */

import type {
  RedskilledStatuslinePayload,
  RedskilledStatuslineVitals,
  RedskilledStatuslineWorkerLog,
} from "./statusline-payload.js";

/**
 * One block that scales with Worker count, and so travels on request.
 *
 * Named individually rather than as one `verbose` boolean because the surfaces
 * want different subsets: a statusline wants vitals and no logs, a dashboard
 * wants the display records, and a health probe wants none of the three.
 */
export type RedskilledStatuslineExtra = "logs" | "vitals" | "display";

/** Every extra there is, so a caller can ask for the skeleton by subtracting. */
export const REDSKILLED_STATUSLINE_EXTRAS: readonly RedskilledStatuslineExtra[] = ["logs", "vitals", "display"];

/**
 * Which extras a reader wants; an omitted flag is a block it does not need.
 *
 * A record of opt-INS rather than opt-outs: the expensive direction should be
 * the one a caller had to type.
 */
export interface RedskilledStatuslineExtrasRequest {
  readonly logs?: boolean;
  readonly vitals?: boolean;
  readonly display?: boolean;
}

/**
 * The same payload with the extras nobody asked for removed. PURE.
 *
 * **A withheld block is replaced by its own honest absence, never deleted**: the
 * shape stays total, so a consumer written against the full document renders a
 * skeleton response without a single existence check. What it must not do is
 * read the absence as a measurement — which is exactly what `withheld` is for.
 *
 * `undefined` extras means the whole document, because that is what every client
 * pinned to an older bundle asks for by saying nothing (ADR 0130 rule 3). A
 * caller that wants less says so.
 */
export function withholdStatuslineExtras(
  payload: RedskilledStatuslinePayload,
  extras: RedskilledStatuslineExtrasRequest | undefined,
): RedskilledStatuslinePayload {
  if (extras === undefined) return payload;
  const withheld = REDSKILLED_STATUSLINE_EXTRAS.filter((extra) => extras[extra] !== true);
  if (withheld.length === 0) return payload;
  const keep = (extra: RedskilledStatuslineExtra) => extras[extra] === true;
  return {
    ...payload,
    workers: payload.workers.map((worker) => ({
      ...worker,
      ...(keep("vitals") ? {} : { vitals: WITHHELD_VITALS, budget: { ...worker.budget, used_bytes: null, used_fraction: null } }),
      ...(keep("logs") ? {} : { log: WITHHELD_LOG }),
      ...(keep("display") ? {} : { display: null, display_published_at: null }),
    })),
    withheld,
  };
}

/** The vitals of a Worker nobody asked about — total in shape, empty in fact. */
const WITHHELD_VITALS: RedskilledStatuslineVitals = {
  rss_bytes: null,
  sampled_at: null,
  age_ms: null,
  fresh: false,
  rss_source: null,
};

/** The log of a Worker nobody asked about. `null`, exactly as an unpublished one. */
const WITHHELD_LOG: RedskilledStatuslineWorkerLog = {
  last_line: null,
  published_at: null,
  source: null,
};
