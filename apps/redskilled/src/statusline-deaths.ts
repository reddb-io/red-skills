/**
 * statusline-deaths — the death block every rendering density shares.
 *
 * It sits beside the payload builder rather than inside it because the block is a
 * DOMAIN, not a field: what counts as a death, which subset a head may print, and
 * when repetition becomes a boot loop are three judgements with one owner. They
 * lived in `statusline-payload.ts` while that file was also assembling the host,
 * the Workers, the budget and the engine — and a reader looking for "why does the
 * statusline say †332" had to walk a thousand lines of unrelated assembly first.
 *
 * It imports NOTHING from the payload builder, deliberately: the observation
 * shape is a death fact, so owning it here keeps the dependency one-way and
 * spares this module the payload-consumer exception `statusline-string` would
 * otherwise have to widen for it.
 *
 * PURE: attributions in, the block a surface prints out. Nothing here reads a
 * clock, a socket or a file.
 */
import type {
  AttributionConfidence,
  DeathAttribution,
  DeathSenderClass,
} from "@reddb-io/shared/death-attribution.js";
import type { ProcessDeathKind } from "@reddb-io/shared/death-record.js";

/** Host-observed facts that enrich a generic death attribution when they exist. */
export interface RedskilledDeathObservation extends DeathAttribution {
  readonly project_label?: string;
  readonly uptime_s?: number;
  readonly detail?: string | null;
  /** The daemon witnessed an exit status or signal, rather than discovering absence in a later sweep. */
  readonly observed_exit?: boolean;
}

/** A Worker dead by this age never reached work; repeated refusals are a boot loop. */
export const REDSKILLED_BOOT_REFUSAL_MAX_UPTIME_S = 2;
/** One refusal can be incidental and two can be a retry; three establishes repetition. */
export const REDSKILLED_BOOT_LOOP_MIN_DEATHS = 3;

/** How many verdicts a payload carries before the rest are counted instead. */
export const REDSKILLED_RECENT_DEATH_LIMIT = 4;
/** A class is an alarm about the current scene, not a durable history label. */
export const REDSKILLED_DEATH_CLASS_FRESHNESS_MS = 10 * 60 * 1_000;

/**
 * One posed death, reduced to what a surface prints.
 *
 * The lane's verdict carries its whole receipt — every source consulted, every
 * line of evidence — and none of that fits a statusline. What survives here is
 * the answer to "why did it die": who ended it, how sure the reaper is, and the
 * one piece of evidence the verdict rests on. The receipt stays on the lane, and
 * `id` is the handle that reaches it.
 */
export interface RedskilledStatuslineDeath {
  readonly kind: ProcessDeathKind;
  readonly id: string;
  readonly pid: number;
  /** When the reaper concluded — NOT when the process died, which nobody saw. */
  readonly ts: string;
  /** The last moment the dead process is known to have lived. */
  readonly last_seen: string;
  readonly last_phase: string;
  readonly sender_class: DeathSenderClass;
  readonly confidence: AttributionConfidence;
  /** The signal, when a source NAMED one; never inferred from the class alone. */
  readonly signal: string | null;
  /** The first fact the verdict rests on; `null` exactly when the class is unknown. */
  readonly evidence: string | null;
}

/**
 * What this host could not explain, as of the last reaping.
 *
 * `count` is stated beside `recent` rather than left to a consumer's `.length`,
 * because the list is capped: a statusline that printed `†2` from a truncated
 * array would under-report a machine that killed a dozen processes, and "how many
 * died" is the number that decides whether an operator looks further.
 *
 * An empty block is a REAPING THAT FOUND NOTHING and is never the same fact as an
 * absent one, which is a daemon that never reaped — the distinction #3028 exists
 * to keep, carried the one hop to the surfaces.
 */
export interface RedskilledStatuslineDeaths {
  readonly count: number;
  /** Deaths in the window whose evidence names a sender; this is the statusline head's count. */
  readonly sender_attributed_count: number;
  /** The newest verdicts first, capped — `count` is the whole number. */
  readonly recent: readonly RedskilledStatuslineDeath[];
  /** The newest verdict, or `null` when the reaping attributed nothing. */
  readonly latest: RedskilledStatuslineDeath | null;
  /** The newest verdict whose evidence names a sender, independent of the capped receipt list. */
  readonly latest_sender_attributed: RedskilledStatuslineDeath | null;
  /** The sender class still current enough to alarm; `null` keeps only the aggregate. */
  readonly current_sender_attributed?: RedskilledStatuslineDeath | null;
  /** When the reaper concluded; `null` when it attributed nothing. */
  readonly reaped_at: string | null;
  /** A repeated same-project boot refusal, absent when the deaths do not establish one. */
  readonly boot_loop?: RedskilledStatuslineBootLoop;
}

/** The actionable shape hidden by a flat death count. */
export interface RedskilledStatuslineBootLoop {
  readonly project_label: string;
  readonly count: number;
  readonly span_ms: number;
  readonly latest_refusal: string;
}

/** The death block a surface prints, newest verdict first. PURE. */
export function buildDeaths(
  attributions: readonly RedskilledDeathObservation[],
  limit: number,
  options: { readonly now?: string; readonly healthyFleet?: boolean; readonly freshnessMs?: number } = {},
): RedskilledStatuslineDeaths {
  const ordered = [...attributions].sort((a, b) => (instant(b.ts) ?? 0) - (instant(a.ts) ?? 0));
  const recent = ordered.slice(0, Math.max(0, Math.floor(limit))).map(statuslineDeath);
  const senderAttributed = ordered.filter(
    (attribution) =>
      attribution.observed_exit === true ||
      (attribution.sender_class !== "unknown" && attribution.confidence !== "none"),
  );
  const latestSender = senderAttributed[0] == null ? null : statuslineDeath(senderAttributed[0]);
  const nowMs = options.now == null ? null : instant(options.now);
  const latestMs = latestSender == null ? null : instant(latestSender.ts);
  const freshnessMs = options.freshnessMs ?? REDSKILLED_DEATH_CLASS_FRESHNESS_MS;
  const bootLoop = buildBootLoop(ordered, { nowMs, freshnessMs });
  const currentSender = options.healthyFleet === true || nowMs == null || latestMs == null || nowMs - latestMs > freshnessMs
    ? null
    : latestSender;
  return {
    count: ordered.length,
    sender_attributed_count: senderAttributed.length,
    recent,
    latest: recent[0] ?? null,
    latest_sender_attributed: latestSender,
    current_sender_attributed: currentSender,
    reaped_at: recent[0]?.ts ?? null,
    ...(bootLoop == null ? {} : { boot_loop: bootLoop }),
  };
}

/** Reduce one full attribution to the receipt every rendering density shares. PURE. */
function statuslineDeath(attribution: RedskilledDeathObservation): RedskilledStatuslineDeath {
  return {
    kind: attribution.kind,
    id: attribution.id,
    pid: attribution.pid,
    ts: attribution.ts,
    last_seen: attribution.last_seen,
    last_phase: attribution.last_phase,
    sender_class: attribution.sender_class,
    confidence: attribution.confidence,
    signal: attribution.signal,
    evidence: attribution.evidence[0] ?? null,
  };
}

/** Reduce the rolling death window to its strongest same-project boot loop. PURE. */
function buildBootLoop(
  ordered: readonly RedskilledDeathObservation[],
  current: { readonly nowMs: number | null; readonly freshnessMs: number },
): RedskilledStatuslineBootLoop | null {
  const byProject = new Map<string, RedskilledDeathObservation[]>();
  for (const death of ordered) {
    if (
      death.sender_class !== "boot-refused" ||
      death.uptime_s == null ||
      death.uptime_s > REDSKILLED_BOOT_REFUSAL_MAX_UPTIME_S ||
      death.project_label == null ||
      death.project_label === "" ||
      instant(death.ts) == null
    ) continue;
    const grouped = byProject.get(death.project_label) ?? [];
    grouped.push(death);
    byProject.set(death.project_label, grouped);
  }

  const loops = [...byProject.entries()]
    .filter(([, deaths]) => deaths.length >= REDSKILLED_BOOT_LOOP_MIN_DEATHS)
    .map(([projectLabel, deaths]): RedskilledStatuslineBootLoop | null => {
      const newest = deaths[0]!;
      const newestAt = instant(newest.ts)!;
      if (current.nowMs == null || current.nowMs - newestAt > current.freshnessMs) return null;
      const oldestAt = Math.min(...deaths.map((death) => instant(death.ts)!));
      const refusal = newest.detail?.trim() || newest.evidence[0]?.trim();
      if (refusal == null || refusal === "") return null;
      return {
        project_label: projectLabel,
        count: deaths.length,
        span_ms: Math.max(0, newestAt - oldestAt),
        latest_refusal: refusal,
      };
    })
    .filter((loop): loop is RedskilledStatuslineBootLoop => loop != null)
    .sort((left, right) => right.count - left.count || right.span_ms - left.span_ms);
  return loops[0] ?? null;
}

/** True when `value` carries a death block's two load-bearing fields. PURE. */
export function isStatuslineDeaths(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const deaths = value as Record<string, unknown>;
  return Number.isInteger(deaths.count) && Array.isArray(deaths.recent);
}

/**
 * An ISO instant in milliseconds, or `null` when it is not one. PURE.
 *
 * Its own copy rather than an import from the payload builder, which holds an
 * identical one: a three-line date parse is a cheaper duplication than the
 * dependency the module header exists to avoid.
 */
function instant(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
