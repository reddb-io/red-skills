/**
 * demand-producer — the per-project runtime, after it stopped managing processes.
 *
 * ADR 0130 draws one seam: **authority over the process is the daemon's,
 * authority over the work is the project's.** This module is the project's side
 * of it. It keeps everything that is knowledge about work — trunk mirror
 * refresh, queue depth sampling, elastic target resolution, runner directives,
 * claim reconciliation and lifecycle hooks — and it holds nothing that is
 * knowledge about processes: no slot table, no growing or shrinking to a target,
 * no birth, no reaping, no respawn, no half-open probe of its own and no
 * resource sampling. It says "I want N Workers with this profile" and consumes
 * what the host grants, **which may be fewer**.
 *
 * A smaller grant is an ordinary answer, not an error. The host is the only
 * authority that can see every project at once, so a producer that treated a
 * refusal as a fault would be arguing with the one party that knows. It records
 * the shortfall with the host's own reason and ends the tick — after a refusal
 * the next request would be asked only to be refused, and asking anyway is how a
 * client turns a full machine into a busy loop.
 *
 * **There is exactly one producer per project.** With Fleet gone there is no
 * reason for more than one and no way for two to share a budget without an
 * arbiter, so several selectors are an *ordered priority inside one producer*
 * rather than several competing loops. The registry refuses a second producer
 * for a project instead of serialising it, because a second loop is a bug to
 * surface, never a queue to drain.
 */
import type { RedskilledHostEvent } from "./event-lane.js";
import {
  expireLapsedReservations,
  heldBackReason,
  INTERACTIVE_RESERVATION_TTL_MS,
  NO_INTERACTIVE_RESERVATIONS,
  releaseInteractiveSlot,
  reserveInteractiveSlot,
  reservedSlotCount,
  type InteractiveReservationState,
} from "./interactive-reservation.js";
import type { RedskilledWorkerStarted } from "./protocol.js";
import {
  isSelectorParked,
  PROJECT_BREAKER_DEFAULTS,
  recordWorkerDeath,
  recordWorkerSurvival,
  selectorParkReason,
  type ProjectBreakerConfig,
  type ProjectBreakerState,
  type WorkerDeathReport,
} from "./project-breaker.js";
import type { RedskilledWorkerSpec } from "./worker-launch.js";

/**
 * One source of demand — a queue the project draws work from.
 *
 * `desired` is how many Workers this selector would take right now; the producer
 * decides how many of them the project's target can actually afford, and the
 * host decides how many of *those* the machine can. Three answers, each from the
 * only party that can give it.
 */
export interface DemandSelector {
  readonly selector_id: string;
  readonly desired: number;
  /**
   * Whether this selector carries interactive work. An interactive selector may
   * spend a slot reserved for it; an autonomous one is held back from it, which
   * is the whole of soft preemption — see `interactive-reservation.ts`.
   */
  readonly interactive?: boolean;
  /** Builds the spec for one Worker; the runner directive arrives as data. */
  readonly spec: (input: { readonly index: number; readonly runner: string | null }) => RedskilledWorkerSpec;
}

export interface DemandRequest {
  readonly selector_id: string;
  readonly index: number;
  readonly spec: RedskilledWorkerSpec;
}

export interface SkippedSelector {
  readonly selector_id: string;
  readonly reason: string;
}

export interface DemandPlan {
  readonly requests: readonly DemandRequest[];
  readonly skipped: readonly SkippedSelector[];
  /** Autonomous selectors that had room but yielded it to a reservation. */
  readonly held_back: readonly SkippedSelector[];
}

export interface PlanProjectDemandInput {
  /** In priority order, highest first. */
  readonly selectors: readonly DemandSelector[];
  /** Workers this project already holds on the host. */
  readonly live: number;
  /** How many Workers the project wants in total, once elasticity resolved it. */
  readonly target: number;
  readonly breaker: ProjectBreakerState;
  readonly nowMs: number;
  readonly runner: string | null;
  /** Slots claimed by interactive dispatches; withheld from autonomous demand. */
  readonly reserved?: number;
}

/**
 * Turn several selectors into one ordered list of requests.
 *
 * Priority is an **order over one budget, not a share of it**: the first
 * selector takes what it wants, and a lower one gets whatever room survives —
 * possibly none. That is the property a share-based split would lose, and the
 * reason one producer can serve every selector without them racing. PURE.
 *
 * A reservation narrows that budget for autonomous selectors only, so the next
 * slot the machine frees goes to the interactive dispatch. **Nothing here can
 * end a Worker**: the planner's only output is births it declines to ask for.
 */
export function planProjectDemand(input: PlanProjectDemandInput): DemandPlan {
  const requests: DemandRequest[] = [];
  const skipped: SkippedSelector[] = [];
  const heldBack: SkippedSelector[] = [];
  let room = Math.max(0, input.target - input.live);
  let reserved = Math.max(0, input.reserved ?? 0);

  for (const selector of input.selectors) {
    if (isSelectorParked(input.breaker, selector.selector_id, input.nowMs)) {
      skipped.push({
        selector_id: selector.selector_id,
        reason: selectorParkReason(input.breaker, selector.selector_id, input.nowMs) ??
          `selector ${JSON.stringify(selector.selector_id)} is parked`,
      });
      continue;
    }
    const interactive = selector.interactive === true;
    let taken = 0;
    for (let index = 0; index < selector.desired; index += 1) {
      // An autonomous selector may only spend room that no reservation claims.
      const affordable = interactive ? room : room - reserved;
      if (affordable <= 0) break;
      requests.push({
        selector_id: selector.selector_id,
        index,
        spec: selector.spec({ index, runner: input.runner }),
      });
      room -= 1;
      taken += 1;
      // The interactive dispatch spends the slot that was being kept for it.
      if (interactive && reserved > 0) reserved -= 1;
    }
    if (!interactive && taken < selector.desired && reserved > 0 && room > 0) {
      heldBack.push({ selector_id: selector.selector_id, reason: heldBackReason(reserved) });
    }
  }
  return { requests, skipped, held_back: heldBack };
}

/** What the producer tells its host about, in order, as a tick unfolds. */
export interface DemandLifecycleEvent {
  readonly event:
    | "worker-granted"
    | "worker-refused"
    | "selector-parked"
    | "selector-held-back"
    | "tick-complete";
  readonly project_label: string;
  readonly selector_id: string | null;
  readonly worker_id: string | null;
  readonly detail: string | null;
}

export interface GrantedWorker {
  readonly selector_id: string;
  readonly worker_id: string;
  readonly pid: number;
  readonly warnings: readonly string[];
}

export interface DemandProductionResult {
  readonly project_label: string;
  readonly queue_depth: number;
  readonly target: number;
  readonly live: number;
  readonly requested: number;
  readonly granted: readonly GrantedWorker[];
  /** Requests the host did not grant. Zero when the machine had the room. */
  readonly shortfall: number;
  /** The host's own words for the refusal that ended the tick, if one did. */
  readonly refusal: string | null;
  readonly skipped: readonly SkippedSelector[];
  readonly held_back: readonly SkippedSelector[];
  /** Slots this tick kept for interactive dispatches, after lapses were dropped. */
  readonly reserved: number;
  readonly runner: string | null;
}

export interface DemandProducerOptions {
  readonly projectLabel: string;
  /** In priority order, highest first. */
  readonly selectors: readonly DemandSelector[];
  /** Asks the host for one Worker. A refusal throws — the client never spawns. */
  readonly startWorker: (spec: RedskilledWorkerSpec) => Promise<RedskilledWorkerStarted>;
  /** How many Workers this project already holds; the host is asked, not guessed. */
  readonly liveWorkers?: () => Promise<number> | number;
  readonly refreshTrunkMirror?: () => Promise<void> | void;
  readonly sampleQueueDepth?: () => Promise<number> | number;
  readonly resolveElasticTarget?: (queueDepth: number) => Promise<number> | number;
  readonly resolveRunnerDirective?: () => Promise<string | null> | string | null;
  /** Reconciles the claims of Workers the host reported dead since the last tick. */
  readonly reconcileClaims?: (deaths: readonly WorkerDeathReport[]) => Promise<void> | void;
  readonly onLifecycle?: (event: DemandLifecycleEvent) => Promise<void> | void;
  readonly breakerConfig?: ProjectBreakerConfig;
  /** How long an unwithdrawn interactive reservation survives. */
  readonly reservationTtlMs?: number;
  readonly clock?: () => number;
}

export interface DemandProducer {
  readonly projectLabel: string;
  /** One tick: resolve the demand, ask the host, live with the answer. */
  produce(): Promise<DemandProductionResult>;
  /** A death the daemon reported. The project decides what it means. */
  reportDeath(report: WorkerDeathReport): void;
  /** A Worker of this selector is working — the half-open circuit closes. */
  reportSurvival(selectorId: string): void;
  /**
   * Claim the next slot for an interactive dispatch. Autonomous demand is held
   * back from that slot; **no live Worker is terminated to free it**.
   */
  reserveInteractive(input: { readonly reservation_id: string; readonly reason?: string | null }): void;
  /** Withdraw a claim, so a slot cannot be held past the request that wanted it. */
  releaseInteractive(reservationId: string): void;
  /** The claims still standing, lapsed ones already dropped. */
  reservations(): InteractiveReservationState;
  breakerState(): ProjectBreakerState;
  /** Releases the project's producer slot; a new producer may then be created. */
  close(): void;
}

/** Raised when a project already has a producer — a second loop, not a queue. */
export class DemandProducerConflictError extends Error {
  constructor(readonly projectLabel: string) {
    super(
      `project ${JSON.stringify(projectLabel)} already has a demand producer; several selectors are an ordered priority inside one producer, never competing loops`,
    );
    this.name = "DemandProducerConflictError";
  }
}

/** Raised when a tick is asked for while this producer's tick is still running. */
export class DemandProducerBusyError extends Error {
  constructor(readonly projectLabel: string) {
    super(`the demand producer for project ${JSON.stringify(projectLabel)} is already producing a tick`);
    this.name = "DemandProducerBusyError";
  }
}

const producers = new Map<string, DemandProducer>();

/** The one producer for this project. Throws when the project already has one. */
export function createDemandProducer(options: DemandProducerOptions): DemandProducer {
  if (producers.has(options.projectLabel)) throw new DemandProducerConflictError(options.projectLabel);

  const clock = options.clock ?? (() => Date.now());
  const breakerConfig = options.breakerConfig ?? PROJECT_BREAKER_DEFAULTS;
  const reservationTtlMs = options.reservationTtlMs ?? INTERACTIVE_RESERVATION_TTL_MS;
  let breaker: ProjectBreakerState = {};
  let reserved: InteractiveReservationState = NO_INTERACTIVE_RESERVATIONS;
  let pendingDeaths: WorkerDeathReport[] = [];
  let ticking = false;

  const emit = async (event: DemandLifecycleEvent): Promise<void> => {
    try {
      await options.onLifecycle?.(event);
    } catch {
      // A hook is a notification, never a veto: a project that stopped
      // producing because its own hook threw would be down for a reason that
      // has nothing to do with the work or the host.
    }
  };

  const producer: DemandProducer = {
    projectLabel: options.projectLabel,

    reportDeath(report) {
      breaker = recordWorkerDeath(breaker, report, breakerConfig);
      pendingDeaths.push(report);
    },

    reportSurvival(selectorId) {
      breaker = recordWorkerSurvival(breaker, selectorId);
    },

    reserveInteractive(input) {
      reserved = reserveInteractiveSlot(reserved, {
        reservation_id: input.reservation_id,
        at_ms: clock(),
        reason: input.reason ?? null,
      });
    },

    releaseInteractive(reservationId) {
      reserved = releaseInteractiveSlot(reserved, reservationId);
    },

    reservations() {
      reserved = expireLapsedReservations(reserved, clock(), reservationTtlMs);
      return reserved;
    },

    breakerState() {
      return breaker;
    },

    close() {
      if (producers.get(options.projectLabel) === producer) producers.delete(options.projectLabel);
    },

    async produce() {
      if (ticking) throw new DemandProducerBusyError(options.projectLabel);
      ticking = true;
      try {
        await callQuietly(options.refreshTrunkMirror);
        const deaths = pendingDeaths;
        pendingDeaths = [];
        if (deaths.length > 0) await callQuietly(() => options.reconcileClaims?.(deaths));

        const queueDepth = (await options.sampleQueueDepth?.()) ?? 0;
        const target = (await options.resolveElasticTarget?.(queueDepth)) ?? 0;
        const runner = (await options.resolveRunnerDirective?.()) ?? null;
        const live = (await options.liveWorkers?.()) ?? 0;

        const nowMs = clock();
        reserved = expireLapsedReservations(reserved, nowMs, reservationTtlMs);
        const reservedSlots = reservedSlotCount(reserved, nowMs, reservationTtlMs);

        const plan = planProjectDemand({
          selectors: options.selectors,
          live,
          target,
          breaker,
          nowMs,
          runner,
          reserved: reservedSlots,
        });
        for (const skip of plan.skipped) {
          await emit({
            event: "selector-parked",
            project_label: options.projectLabel,
            selector_id: skip.selector_id,
            worker_id: null,
            detail: skip.reason,
          });
        }
        for (const held of plan.held_back) {
          await emit({
            event: "selector-held-back",
            project_label: options.projectLabel,
            selector_id: held.selector_id,
            worker_id: null,
            detail: held.reason,
          });
        }

        const granted: GrantedWorker[] = [];
        let refusal: string | null = null;
        for (const request of plan.requests) {
          let started: RedskilledWorkerStarted;
          try {
            started = await options.startWorker(request.spec);
          } catch (err) {
            // The host said no, or said nothing at all. Both mean the same to a
            // producer — no Worker — and both end the tick.
            refusal = err instanceof Error ? err.message : String(err);
            await emit({
              event: "worker-refused",
              project_label: options.projectLabel,
              selector_id: request.selector_id,
              worker_id: null,
              detail: refusal,
            });
            break;
          }
          granted.push({
            selector_id: request.selector_id,
            worker_id: started.worker.worker_id,
            pid: started.worker.pid,
            warnings: started.warnings,
          });
          await emit({
            event: "worker-granted",
            project_label: options.projectLabel,
            selector_id: request.selector_id,
            worker_id: started.worker.worker_id,
            detail: started.admission.reason,
          });
        }

        const result: DemandProductionResult = {
          project_label: options.projectLabel,
          queue_depth: queueDepth,
          target,
          live,
          requested: plan.requests.length,
          granted,
          shortfall: plan.requests.length - granted.length,
          refusal,
          skipped: plan.skipped,
          held_back: plan.held_back,
          reserved: reservedSlots,
          runner,
        };
        await emit({
          event: "tick-complete",
          project_label: options.projectLabel,
          selector_id: null,
          worker_id: null,
          detail: `granted ${granted.length} of ${plan.requests.length} requested`,
        });
        return result;
      } finally {
        ticking = false;
      }
    },
  };

  producers.set(options.projectLabel, producer);
  return producer;
}

/** The project's producer, if it has one. */
export function demandProducerFor(projectLabel: string): DemandProducer | undefined {
  return producers.get(projectLabel);
}

/** Releases every producer. For a host tearing a session down, and for tests. */
export function closeAllDemandProducers(): void {
  producers.clear();
}

export interface DeathReportContext {
  readonly selector_id: string;
  /** The Worker's birth timestamp, as the host reported it. */
  readonly started_at: string;
}

/**
 * Read a death report off the host event the daemon appended.
 *
 * The lane already carries the whole fact; what it cannot carry is which
 * selector's demand produced the Worker, because that is work knowledge and the
 * daemon holds none. So the project supplies exactly that one field and reads
 * the rest. PURE.
 */
export function deathReportFromHostEvent(
  event: RedskilledHostEvent,
  context: DeathReportContext,
): WorkerDeathReport {
  const diedAt = Date.parse(event.ts);
  const bornAt = Date.parse(context.started_at);
  const atMs = Number.isNaN(diedAt) ? 0 : diedAt;
  return {
    worker_id: event.worker_id,
    selector_id: context.selector_id,
    kind: event.event === "worker-budget-kill" ? "worker-budget-kill" : "worker-death",
    lived_ms: Number.isNaN(diedAt) || Number.isNaN(bornAt) ? 0 : Math.max(0, diedAt - bornAt),
    at_ms: atMs,
    detail: event.detail,
    exit_code: event.exit_code,
  };
}

async function callQuietly(fn: (() => Promise<unknown> | unknown) | undefined): Promise<void> {
  if (fn == null) return;
  try {
    await fn();
  } catch {
    // Work knowledge is best-effort per tick: a mirror that would not refresh
    // is a stale read, and refusing to produce over it would idle the project
    // for a fact the next tick is likely to have.
  }
}

export type { InteractiveReservationState, ProjectBreakerState, WorkerDeathReport };
