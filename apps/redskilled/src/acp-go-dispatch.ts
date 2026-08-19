// acp-go-dispatch — the daemon side of the `go_dispatch` method (ADR 0150 §3).
//
// `/go` becomes thin here. The client sends a demand; the daemon mints the
// disposable Ticket in the isolated go lane, admits one Worker against exactly
// that Ticket, and answers with the Worker id. Nothing in the sequence reads a
// client checkout, which is the whole point: the boot phases `/go` used to run
// project-side become daemon admission or they die (ADR 0144 §5).
//
// The Ticket is minted into `lane:go` and NEVER into `ready-for-agent`, so the
// running drain cannot claim a Ticket a dedicated Worker already owns.
import { RequestError } from "@agentclientprotocol/sdk";
import {
  GO_DISPATCH_SCHEMA,
  REDSKILLS_ACP_METHODS,
  goDispatchParams,
  type GoDispatchAnswer,
  type GoDispatchParams,
} from "@reddb-io/protocol-acp";

import { randomUUID } from "node:crypto";

import { GO_DISPATCH_LANE, type AcpTargetedDispatchIntent } from "./acp-dispatch-intent.js";
import { bindAcpProjectGithubWrite } from "./acp-github.js";
import {
  redskillsAcpMethod,
  type RedskillsAcpMethodContext,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";

export { GO_DISPATCH_LANE };
export const REDSKILLED_GO_DISPATCH_METHOD = REDSKILLS_ACP_METHODS.goDispatch;

/** The disposable Ticket one demand becomes. */
export interface GoTicketSpec {
  readonly title: string;
  readonly body: string;
  /** The isolated go lane, and nothing that would put it in the drain's queue. */
  readonly labels: readonly string[];
}

/**
 * The Ticket tracker, as the daemon needs it and no wider.
 *
 * A port rather than the gateway itself: `go_dispatch` needs a Ticket number
 * and a way to take it back, and a handler that could reach the whole forge
 * client would be one refactor away from doing the rest of `/go` here too.
 */
export interface GoTicketTracker {
  mint(spec: GoTicketSpec): Promise<number>;
  /** Take the Ticket back when no Worker was born to own it. Optional: a
   * tracker with no close authority is better than a silent pretend-close. */
  dispose?(ticket: number): Promise<void>;
}

/** What admission reports back about the Worker it just admitted. */
export interface GoWorkerAdmission {
  readonly worker_id: string;
  /** The public ACP session carrying this Worker's updates, when it has one. */
  readonly session_id?: string;
}

export interface AcpGoDispatchDeps {
  readonly tracker: GoTicketTracker;
  /** Admit exactly one Worker against the minted Ticket. */
  admit(
    dispatch: AcpTargetedDispatchIntent,
    context: RedskillsAcpMethodContext<GoDispatchParams>,
  ): Promise<GoWorkerAdmission>;
}

/**
 * Build the disposable Ticket for a demand.
 *
 * The only routing label is the isolated go lane. The body says what the
 * Ticket is, because a human who finds it in the tracker three weeks later
 * needs to know it was minted by a dispatch and closes with its PR.
 */
export function buildGoTicket(demand: string): GoTicketSpec {
  const text = demand.trim();
  if (text === "") throw RequestError.invalidParams({}, "go_dispatch requires a non-empty demand");
  const headline = (text.split("\n", 1)[0] ?? "").trim();
  return {
    title: `/go: ${headline.slice(0, 72) || "dispatch"}`,
    body: [
      "## Demand",
      "",
      text,
      "",
      "---",
      "",
      `🤖 Disposable dispatch Ticket, minted by \`${REDSKILLS_ACP_METHODS.goDispatch}\` into the`,
      `isolated \`${GO_DISPATCH_LANE}\` lane — never \`ready-for-agent\`, so the running drain`,
      "cannot claim it. Its dedicated Worker owns it, and it closes with that Worker's PR.",
    ].join("\n"),
    labels: [GO_DISPATCH_LANE],
  };
}

/**
 * Bind `go_dispatch` to a tracker and an admission authority.
 *
 * Mint, then admit, then answer — and if admission refuses, take the Ticket
 * back before the refusal reaches the caller. A minted Ticket whose Worker was
 * never born is litter no one is watching for: it carries no `ready-for-agent`,
 * so the drain will not clear it, and it names a lane no human reads.
 */
export function bindAcpGoDispatch(deps: AcpGoDispatchDeps) {
  return async (context: RedskillsAcpMethodContext<GoDispatchParams>): Promise<GoDispatchAnswer> => {
    const spec = buildGoTicket(context.params.demand);
    const ticket = await deps.tracker.mint(spec);
    if (!Number.isInteger(ticket) || ticket <= 0) {
      throw new Error(`the Ticket tracker answered ${String(ticket)} instead of a Ticket number`);
    }
    const dispatch: AcpTargetedDispatchIntent = {
      version: 1,
      workerKind: "go",
      ticket,
      selector: { kind: "issues", numbers: [ticket], lane: GO_DISPATCH_LANE },
    };
    let admission: GoWorkerAdmission;
    try {
      admission = await deps.admit(dispatch, context);
    } catch (error) {
      try {
        await deps.tracker.dispose?.(ticket);
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          `Worker admission failed and disposable Ticket #${ticket} could not be closed`,
        );
      }
      throw error;
    }
    return {
      version: 1,
      worker_id: admission.worker_id,
      ticket,
      lane: GO_DISPATCH_LANE,
      ...(admission.session_id == null ? {} : { session_id: admission.session_id }),
    };
  };
}

/** The go domain: one method, validated against the published wire schema. */
export function goDispatchMethodDomain(deps: AcpGoDispatchDeps): RedskillsAcpMethodDomain {
  return {
    domain: "go",
    bindings: [redskillsAcpMethod(REDSKILLS_ACP_METHODS.goDispatch, goDispatchParams, bindAcpGoDispatch(deps))],
    capability: {
      goDispatch: {
        version: GO_DISPATCH_SCHEMA.version,
        methods: [REDSKILLS_ACP_METHODS.goDispatch],
        lane: GO_DISPATCH_LANE,
      },
    },
  };
}

/**
 * The production tracker: the Project-bound GitHub gateway, and nothing else.
 *
 * `dispose` is deliberately ABSENT. The daemon's write authority opens Tickets
 * and publishes comments; it cannot yet close one, and a `dispose` that
 * published "never mind" while leaving the Ticket open would report a cleanup
 * that did not happen. The minted Ticket carries only the isolated go lane and
 * never `ready-for-agent`, so an orphan is inert rather than claimable — it
 * waits for a human, which is the honest state until closure is a write kind.
 */
export function createAcpGithubGoTicketTracker(
  gateway: RedskilledGithubGatewayRegistration | undefined,
  scopedProject: () => AcpProjectWorkspace,
): GoTicketTracker {
  const write = bindAcpProjectGithubWrite(gateway, scopedProject);
  return {
    async mint(spec: GoTicketSpec): Promise<number> {
      const answer = await write({
        params: {
          idempotency_key: `go-dispatch:${randomUUID()}`,
          write: {
            kind: "issue-publication",
            title: spec.title,
            body: spec.body,
            labels: [...spec.labels],
          },
        },
      });
      return ticketNumber(answer.value);
    },
  };
}

/** Read the Ticket number out of the tracker's own answer, or refuse. */
function ticketNumber(value: unknown): number {
  const number = value != null && typeof value === "object"
    ? (value as { readonly number?: unknown }).number
    : undefined;
  if (!Number.isInteger(number) || Number(number) <= 0) {
    throw new Error("the Ticket tracker published no Ticket number for this dispatch");
  }
  return Number(number);
}
