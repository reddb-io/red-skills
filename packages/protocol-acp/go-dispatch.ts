// go-dispatch — the wire shape of `_redskills/go_dispatch` (ADR 0150 §3).
//
// `/go` used to be a client PROGRAM: mint a disposable Ticket with `gh`,
// compose an engine argv, spawn the Worker. Every one of those steps read the
// human's checkout — the input ADR 0144 §5 forbids — so the method replaces the
// program with ONE call: the daemon mints the Ticket, admits the Worker, and
// answers with the Worker id. The client carries a demand and nothing else.
//
// What lives here is the WIRE and only the wire: what a caller may name, what
// it may read back, and the published schema both ends validate against. Which
// lane the Ticket is minted into, which tracker mints it, and which Worker is
// admitted stay with the daemon, per ADR 0148's body-versus-control cut.
import { RequestError } from "@agentclientprotocol/sdk";

import { REDSKILLS_ACP_METHODS } from "./methods.js";

/**
 * Everything a `/go` caller may name.
 *
 * Exactly one field, deliberately: a demand. Lane, tracker, Worker kind,
 * budget and placement are the daemon's verdicts, and a params shape that let
 * a caller name one of them would be a client boot phase wearing a wire.
 */
export interface GoDispatchParams {
  readonly demand: string;
}

/** What one accepted `go_dispatch` produced. */
export interface GoDispatchAnswer {
  readonly version: 1;
  /** The admitted Worker, named by the daemon that admitted it. */
  readonly worker_id: string;
  /** The Ticket the daemon minted for this demand. */
  readonly ticket: number;
  /** The lane label the Ticket was minted into. */
  readonly lane: string;
  /** The public ACP session carrying this Worker's updates, when it has one. */
  readonly session_id?: string;
}

/**
 * Longest demand the wire accepts.
 *
 * A demand becomes the body of a Ticket a forge must accept, so an unbounded
 * one fails on the far side of the daemon, after the mint has been attempted.
 * Refusing it here fails closed, in the caller's own error.
 */
export const GO_DISPATCH_DEMAND_MAX_LENGTH = 16_000;

/** The published params schema; the daemon and every client read this one. */
export const GO_DISPATCH_PARAMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["demand"],
  properties: {
    demand: {
      type: "string",
      minLength: 1,
      maxLength: GO_DISPATCH_DEMAND_MAX_LENGTH,
      description: "The one-off demand this dispatch exists to satisfy.",
    },
  },
} as const;

/** The published answer schema. */
export const GO_DISPATCH_ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "worker_id", "ticket", "lane"],
  properties: {
    version: { const: 1 },
    worker_id: { type: "string", minLength: 1 },
    ticket: { type: "integer", minimum: 1 },
    lane: { type: "string", minLength: 1 },
    session_id: { type: "string", minLength: 1 },
  },
} as const;

/** The whole published contract of `_redskills/go_dispatch`, in one value. */
export const GO_DISPATCH_SCHEMA = {
  version: 1,
  method: REDSKILLS_ACP_METHODS.goDispatch,
  params: GO_DISPATCH_PARAMS_SCHEMA,
  answer: GO_DISPATCH_ANSWER_SCHEMA,
} as const;

/**
 * Validate `_redskills/go_dispatch` params against the published schema.
 *
 * `additionalProperties: false` is enforced rather than described: a caller
 * that smuggles a `lane`, a `ticket` or a `runner` past this validator is
 * naming a daemon verdict, and a silently ignored field reads to its author as
 * a field that worked.
 */
export function goDispatchParams(value: unknown): GoDispatchParams {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams({}, "go_dispatch requires an object naming exactly a demand");
  }
  const named = Object.keys(value);
  const unknownFields = named.filter((key) => key !== "demand");
  if (unknownFields.length > 0) {
    throw RequestError.invalidParams(
      { unknown_fields: unknownFields },
      "go_dispatch accepts no caller-named lane, Ticket, Worker kind or budget",
    );
  }
  const demand = (value as { readonly demand?: unknown }).demand;
  if (typeof demand !== "string" || demand.trim() === "") {
    throw RequestError.invalidParams({}, "go_dispatch requires a non-empty demand");
  }
  if (demand.length > GO_DISPATCH_DEMAND_MAX_LENGTH) {
    throw RequestError.invalidParams(
      { max_length: GO_DISPATCH_DEMAND_MAX_LENGTH },
      "go_dispatch refuses a demand longer than a Ticket body can carry",
    );
  }
  return { demand };
}
