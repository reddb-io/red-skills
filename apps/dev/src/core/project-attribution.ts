/**
 * project-attribution — deciding which live Workers are THIS project's (#3081).
 *
 * **The join is on one id, and the whole defect was that there were two.** The
 * daemon owns birth, so the id it minted is the Worker's identity; the project
 * adopts that string from `RED_AFK_WORKER_ID` and files its worker directory,
 * its claim comment and every project-side surface under it. When the launch
 * env never reached the process, the project minted a second id instead, and
 * this predicate compared one id space against the other — false for every
 * Worker, always. `project_status` then rendered a project whose two Workers
 * were mid-review as `live_workers: []` with `busy: 0`.
 *
 * **A predicate that matches nothing is reported, never rendered as calm.** The
 * disjoint case and the genuinely-foreign case produce the same empty list, and
 * only one of them is a working system: a host holding Workers for this project
 * while none of the live Workers matches any of them is the structural failure,
 * and it says so in the answer rather than looking like an idle repository.
 *
 * PURE: every input is passed in, the host's answer included.
 */

/** What this module needs of a live Worker: the one id it is filed under. */
export interface AttributableWorker {
  readonly state: { readonly worker_id: string };
}

export interface ProjectAttributionInput<W extends AttributableWorker> {
  /** Every Worker this checkout can see running, whoever owns it. */
  readonly workers: readonly W[];
  /**
   * The Workers the HOST says belong to this project, or `null` when it did not
   * answer. `null` and `[]` are different facts: an unreachable daemon knows
   * nothing about ownership, while an empty list is a host stating this project
   * holds none.
   */
  readonly hostWorkerIds: readonly string[] | null;
  /**
   * When the host says each of its Workers was born, by id.
   *
   * Supplied so "the host counts a Worker this checkout sees no trace of" can be
   * told apart from the ordinary newborn window, where a Worker legitimately
   * holds its slot before it has written any project-side state. Omitted means
   * the caller cannot date them, and the disagreement stays unreported rather
   * than guessed at — a false alarm on every birth would be the louder defect.
   */
  readonly hostWorkerBirths?: Readonly<Record<string, string>>;
  /** The instant to date those births against; `Date.now()` when unstated. */
  readonly nowMs?: number;
  /** How long a newborn is exempt; {@link NEWBORN_ATTRIBUTION_GRACE_MS} by default. */
  readonly newbornGraceMs?: number;
}

/**
 * How long a host Worker is too young for its absence here to mean anything.
 *
 * A Worker holds its slot from the instant the daemon births it, and writes its
 * project-side state a moment later. Inside this window "the host holds one and
 * we see none" is a birth in progress; past it, it is a record outliving its
 * Worker (#3123).
 */
export const NEWBORN_ATTRIBUTION_GRACE_MS = 60_000;

export interface ProjectAttribution<W extends AttributableWorker> {
  /** Workers the host attributes to this project. */
  readonly live: readonly W[];
  /** Workers of another project, or carrying no id the host holds. */
  readonly unattributed: readonly W[];
  /** How many slots are occupied — the host's count, which owns birth. */
  readonly busy: number;
  /** What went structurally wrong, in sentences an operator can act on. */
  readonly warnings: readonly string[];
}

/**
 * Split the live Workers into this project's and everyone else's. PURE.
 *
 * `busy` comes from the HOST's list rather than from the matched Workers,
 * because the host is what occupies a slot: a Worker born a moment ago holds
 * its slot before it has written any project-side state, and a slot count that
 * waited for that file would read free while the daemon refused to fill it.
 */
/**
 * True when every held Worker is old enough for its absence to mean something.
 *
 * Undatable is treated as NEWBORN, not settled: a caller that supplied no births
 * — or a host record missing one — has given no evidence, and inventing an alarm
 * out of no evidence is how a warning teaches an operator to ignore it. PURE.
 */
function allSettled<W extends AttributableWorker>(
  input: ProjectAttributionInput<W>,
  held: readonly string[],
): boolean {
  const births = input.hostWorkerBirths;
  if (births == null) return false;
  const nowMs = input.nowMs ?? Date.now();
  const graceMs = input.newbornGraceMs ?? NEWBORN_ATTRIBUTION_GRACE_MS;
  return held.every((id) => {
    const bornMs = Date.parse(births[id] ?? "");
    return Number.isFinite(bornMs) && nowMs - bornMs >= graceMs;
  });
}

export function attributeProjectWorkers<W extends AttributableWorker>(
  input: ProjectAttributionInput<W>,
): ProjectAttribution<W> {
  const held = input.hostWorkerIds;
  const ourWorkerIds = new Set(held ?? []);
  const ours = (worker: W): boolean => ourWorkerIds.has(worker.state.worker_id);
  const live = input.workers.filter(ours);
  const unattributed = input.workers.filter((worker) => !ours(worker));
  const warnings: string[] = [];
  if (held == null) {
    warnings.push(
      "the redskilled daemon did not answer, so no live Worker could be attributed to this project: every one of " +
        "them is listed as unattributed because ownership is the host's answer, never a guess made from a pid",
    );
  } else if (held.length > 0 && input.workers.length === 0 && allSettled(input, held)) {
    // The #3123 signature: the host counts Workers this checkout can see no trace
    // of, and none of them is young enough for a birth in progress to explain it.
    // Silence here is what let `live_workers: []` sit beside `busy: 1` for two
    // hours while a queue went undrained — the two surfaces described the same
    // machine and disagreed, and neither said so.
    warnings.push(
      `the host holds ${held.length} Worker(s) for this project (${[...ourWorkerIds].slice(0, 3).join(", ")}) and ` +
        "not one of them is running here: the daemon's count and this project's own read disagree, which is a record " +
        "outliving its Worker — the host's liveness sweep reaps it, and `worker_stop <id>` releases it now (#3123)",
    );
  } else if (held.length > 0 && input.workers.length > 0 && live.length === 0) {
    // The #3081 signature, stated where it is read. Two disjoint id spaces and a
    // genuinely-foreign Worker set produce the same empty list, and reporting
    // neither is how a project came to render its own busy fleet as idle.
    warnings.push(
      `the host holds ${held.length} Worker(s) for this project and ${input.workers.length} live Worker(s) are ` +
        `running here, and not one of them matches: the host ids ` +
        `(${[...ourWorkerIds].slice(0, 3).join(", ")}) and the project ids ` +
        `(${input.workers.slice(0, 3).map((w) => w.state.worker_id).join(", ")}) are disjoint, which means a Worker ` +
        `was born without the \`RED_AFK_WORKER_ID\` its launch declared and minted a second identity (#3081)`,
    );
  }
  return {
    live,
    unattributed,
    // An unreachable host states no occupancy at all, and a live Worker this
    // checkout can see is NOT evidence of an occupied slot of ours — it may be
    // another project's entirely. The zero rides with the warning above, which
    // is what keeps it from reading as an idle project.
    busy: held?.length ?? 0,
    warnings,
  };
}
