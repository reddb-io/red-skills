/**
 * The Ticket loop: claim → implement → gate → re-seed → publish → land, run
 * INSIDE the Worker process (issue #4020, ADR 0148, ADR 0129, ADR 0135).
 *
 * The dev bundle used to hold this arc, which meant the daemon could see a
 * Worker's birth and its death and nothing in between. ADR 0148 moved the body
 * here, so the arc moved with it — and the seam it crosses moved with the arc:
 * every write leaves as an ACP REQUEST to the parent. The Worker never holds a
 * credential, never pushes, never opens a pull request; it names the branch and
 * the commit its work produced and asks (ADR 0144 §3).
 *
 * **The loop re-seeds; it never re-queues.** A blocked gate re-instructs the
 * SAME implementer in the SAME Worktree on the SAME branch, carrying forward
 * what is already committed, because the alternative — a fresh Worker on a
 * clean checkout — pays for the work twice (ADR 0129). The budget is what stops
 * that from becoming an eternal poll: when the rounds are spent the loop stops
 * with the gate's own verdict rather than trying once more.
 *
 * **Nothing is published for work the gate refused.** Publish and land are the
 * last two stages precisely so that the gate stands between the implementer and
 * the remote. A Worker whose gate blocked returns `gate-blocked` and hands the
 * branch to nobody.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";
import { renderClaimComment } from "../engine/tracker/claim.js";
import { gateVerdict, type GateStage, type GateStageOutcome } from "../engine/gate-stage-order.js";
import { laneRunModeRefusal } from "../engine/lane-run-mode.js";
import type { WorkerPublication, WorkerPublisher, WorkerPublishOutcome } from "./publish-request.js";

/** The loop's stages, in the order one Ticket travels through them. */
export const TICKET_LOOP_STAGES = ["claim", "implement", "gate", "publish", "land"] as const;

export type TicketLoopStage = (typeof TICKET_LOOP_STAGES)[number];

/** The Ticket the daemon admitted this Worker for. */
export interface TicketLoopTicket {
  readonly number: number;
  readonly title: string;
  /** The labels the Ticket carries; the lane among them implies the run mode. */
  readonly labels: readonly string[];
  /** The trunk the pull request is opened against. */
  readonly base: string;
  /** What the implementer is told to do, composed by whoever admitted the Worker. */
  readonly handoff: string;
}

/** What one implementing round left behind. */
export interface TicketImplementOutcome {
  /** The child Agent's own stop reason; `cancelled` ends the loop unpublished. */
  readonly stopReason: PromptResponse["stopReason"];
  /** Free-form detail carried into the next re-seed's handoff. */
  readonly detail?: string;
}

/** One local gate run, already folded into the declared stage outcomes. */
export interface TicketGateRun {
  readonly stages: readonly GateStageOutcome[];
  /** What the blocking stage said, carried verbatim into the re-seed handoff. */
  readonly detail?: string;
}

export interface TicketLoopDeps {
  readonly ticket: TicketLoopTicket;
  /** This Worker's identity, as it appears in the claim marker. */
  readonly workerId: string;
  /** The public ACP session, which scopes every idempotency key the loop mints. */
  readonly sessionId: string;
  /** The runner behind the child Agent, recorded on the claim. */
  readonly runner?: string;
  /** The mode this Worker holds; the lane contract refuses a mismatch. */
  readonly runMode?: string;
  /**
   * How many times the implementer may be re-instructed IN PLACE.
   *
   * Zero is a legal answer and means "one implementing round, then the gate
   * decides". The budget is a ceiling on ROUNDS, never on wall clock: a round
   * that hangs is the child Agent's cancellation to answer, not the loop's.
   */
  readonly reseedBudget?: number;
  /** Sends one request to the ACP parent; the parent owns every credential. */
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  /** Runs one implementing round against the retained child Agent. */
  readonly implement: (handoff: string, round: number) => Promise<TicketImplementOutcome>;
  /** Runs the declared gate stages locally, in the Worktree. */
  readonly gate: (round: number) => Promise<TicketGateRun>;
  /** Asks the parent to publish what the Worktree now holds. */
  readonly publisher: WorkerPublisher;
  /** Narrates each stage as it resolves, for the Worker log. */
  readonly narrate?: (record: TicketLoopRecord) => Promise<void> | void;
  /** Test seam over the wall clock, so a record's timestamp is not a guess. */
  readonly now?: () => Date;
}

/** One stage's outcome, as the Worker log sees it. */
export interface TicketLoopRecord {
  readonly stage: TicketLoopStage;
  readonly ok: boolean;
  readonly round?: number;
  readonly detail?: string;
}

export type TicketLoopResult =
  /** Every stage passed; the branch is published and its merge is in custody. */
  | {
      readonly outcome: "landed";
      readonly publication: WorkerPublication;
      readonly pullRequest: number;
      readonly rounds: number;
      readonly records: readonly TicketLoopRecord[];
    }
  /** The lane's contract, or the daemon, refused before any work was done. */
  | {
      readonly outcome: "refused";
      readonly stage: TicketLoopStage;
      readonly detail: string;
      readonly records: readonly TicketLoopRecord[];
    }
  /** The gate blocked and the re-seed budget is spent; nothing was published. */
  | {
      readonly outcome: "gate-blocked";
      readonly failedStage: GateStage;
      readonly rounds: number;
      readonly detail?: string;
      readonly records: readonly TicketLoopRecord[];
    }
  /** The turn was cancelled mid-thought, so the commit is not offered anywhere. */
  | {
      readonly outcome: "cancelled";
      readonly rounds: number;
      readonly records: readonly TicketLoopRecord[];
    }
  /** The gate was green but the Worktree committed nothing to hand over. */
  | {
      readonly outcome: "nothing-to-publish";
      readonly rounds: number;
      readonly records: readonly TicketLoopRecord[];
    };

/**
 * Run one Ticket from claim to land, or state which stage stopped it.
 *
 * Never rejects on a stage's own refusal: a Worker that threw would cost the
 * daemon the reason as well as the work, and the reason is the only thing a
 * blocked Ticket has left to give. A dep that throws for a reason the loop did
 * not ask about — a dead child, a closed socket — still propagates, because
 * that is a Worker death and the daemon reaps those.
 */
export async function runTicketLoop(deps: TicketLoopDeps): Promise<TicketLoopResult> {
  const records: TicketLoopRecord[] = [];
  const now = deps.now ?? (() => new Date());
  const budget = Math.max(0, Math.trunc(deps.reseedBudget ?? 0));

  const note = async (record: TicketLoopRecord): Promise<TicketLoopRecord> => {
    records.push(record);
    await deps.narrate?.(record);
    return record;
  };

  // ---- claim -------------------------------------------------------------
  // The lane is checked BEFORE the claim rather than after it, because a claim
  // this Worker may not honour is one another Worker cannot take either.
  const laneRefusal = laneRunModeRefusal(deps.ticket.labels, deps.runMode);
  if (laneRefusal != null) {
    await note({ stage: "claim", ok: false, detail: laneRefusal });
    return { outcome: "refused", stage: "claim", detail: laneRefusal, records };
  }
  try {
    await deps.request(REDSKILLS_ACP_METHODS.githubWrite, {
      idempotency_key: `${deps.sessionId}:claim:${deps.ticket.number}`,
      write: {
        kind: "issue-publication",
        issue: deps.ticket.number,
        body: renderClaimComment({
          worker: deps.workerId,
          ...(deps.runner == null ? {} : { runner: deps.runner }),
          createdAt: now().toISOString(),
        }),
      },
    });
  } catch (error) {
    const detail = messageOf(error);
    await note({ stage: "claim", ok: false, detail });
    return { outcome: "refused", stage: "claim", detail, records };
  }
  await note({ stage: "claim", ok: true });

  // ---- implement / gate / re-seed ---------------------------------------
  let handoff = deps.ticket.handoff;
  let rounds = 0;
  let verdict = gateVerdict([]);
  let gateDetail: string | undefined;
  for (;;) {
    rounds += 1;
    const implemented = await deps.implement(handoff, rounds);
    await note({
      stage: "implement",
      ok: implemented.stopReason !== "cancelled",
      round: rounds,
      ...(implemented.detail == null ? {} : { detail: implemented.detail }),
    });
    if (implemented.stopReason === "cancelled") {
      return { outcome: "cancelled", rounds, records };
    }

    const run = await deps.gate(rounds);
    verdict = gateVerdict(run.stages);
    gateDetail = run.detail;
    await note({
      stage: "gate",
      ok: verdict.ok,
      round: rounds,
      ...(verdict.ok
        ? {}
        : { detail: `${verdict.failedStage} blocked${run.detail == null ? "" : `: ${run.detail}`}` }),
    });
    if (verdict.ok) break;
    // Re-seed IN PLACE: same Worker, same Worktree, same branch. The budget
    // counts rounds ALREADY SPENT, so `rounds > budget` is the round after the
    // last one the operator paid for.
    if (rounds > budget) {
      return {
        outcome: "gate-blocked",
        failedStage: verdict.failedStage ?? "feedback",
        rounds,
        ...(gateDetail == null ? {} : { detail: gateDetail }),
        records,
      };
    }
    handoff = reseedHandoff(deps.ticket, verdict.failedStage, run.detail, rounds);
  }

  // ---- publish -----------------------------------------------------------
  const published = await deps.publisher.publishTurn();
  if (published == null) {
    await note({ stage: "publish", ok: false, detail: "the Worktree committed nothing to publish" });
    return { outcome: "nothing-to-publish", rounds, records };
  }
  if (published.status === "refused") {
    await note({ stage: "publish", ok: false, detail: published.detail });
    return { outcome: "refused", stage: "publish", detail: published.detail, records };
  }
  await note({ stage: "publish", ok: true, detail: publicationDetail(published) });

  // ---- land --------------------------------------------------------------
  // Landing ARMS custody; it does not await a merge. A Worker that waited for
  // review would hold its workspace, its budget and its host slot open for it.
  try {
    const landed = await deps.request(REDSKILLS_ACP_METHODS.land, {
      idempotency_key: `${deps.sessionId}:land:${published.publication.commit}`,
      branch: published.publication.branch,
      base: deps.ticket.base,
      title: deps.ticket.title,
      body: landingBody(deps.ticket, rounds),
      owner_ticket: deps.ticket.number,
    });
    const pullRequest = pullRequestNumber(landed);
    await note({ stage: "land", ok: true, detail: `pull request ${pullRequest}` });
    return { outcome: "landed", publication: published.publication, pullRequest, rounds, records };
  } catch (error) {
    const detail = messageOf(error);
    await note({ stage: "land", ok: false, detail });
    return { outcome: "refused", stage: "land", detail, records };
  }
}

/**
 * The re-seeded handoff: CURRENT OUTSTANDING STATE, not a transcript.
 *
 * The implementer is still holding everything it did in the last round, so
 * repeating the original brief would spend the round re-reading its own work.
 * What it does not have is what the gate just refused, which is all this says.
 */
export function reseedHandoff(
  ticket: TicketLoopTicket,
  failedStage: GateStage | undefined,
  detail: string | undefined,
  round: number,
): string {
  return [
    `The ${failedStage ?? "gate"} stage blocked round ${round} of Ticket #${ticket.number}.`,
    detail == null || detail === "" ? undefined : detail,
    "Fix it in this Worktree on this branch and commit; the work already committed stands.",
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

/** The pull request body: what landed, and how many rounds it took. */
function landingBody(ticket: TicketLoopTicket, rounds: number): string {
  return [
    `Refs #${ticket.number}`,
    "",
    `Gate green after ${rounds} implementing ${rounds === 1 ? "round" : "rounds"}.`,
  ].join("\n");
}

function publicationDetail(published: Extract<WorkerPublishOutcome, { status: "requested" }>): string {
  return `${published.publication.branch}@${published.publication.commit.slice(0, 12)}`;
}

/** The pull request the daemon opened; anything else is a landing that lied. */
function pullRequestNumber(answer: unknown): number {
  const value = (answer as { pull_request?: unknown } | undefined)?.pull_request;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("the parent's landing answer named no pull request");
  }
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
