// brain — the `_redskills/brain_call` params and answer shapes (ADR 0152).
//
// **A second repository is not a second brain.** The store is the USER's, held
// once per host by the daemon at `~/.red/brain`, so a session does not open one
// — it names a tool and forwards its arguments. One method carries every tool
// rather than ten methods carrying one each: the vocabulary belongs to the
// brain, and a wire that restated it would be a second list to keep in step.
//
// What lives here is the WIRE: which tools exist, and the envelope that names
// one. What a tool DOES, and which store answers it, are the daemon's and stay
// with the daemon (ADR 0148's body-versus-control cut).
import { RequestError } from "@agentclientprotocol/sdk";

/** Every tool the brain surface publishes. A name absent here is not a tool. */
export const REDSKILLED_BRAIN_TOOLS = [
  "brain_init",
  "brain_status",
  "brain_capture",
  "brain_search",
  "brain_think",
  "brain_get",
  "brain_link",
  "brain_backlinks",
  "brain_act",
  "brain_kpis",
] as const;

export type RedskilledBrainTool = (typeof REDSKILLED_BRAIN_TOOLS)[number];

export function isRedskilledBrainTool(value: unknown): value is RedskilledBrainTool {
  return (REDSKILLED_BRAIN_TOOLS as readonly string[]).includes(value as string);
}

/**
 * One brain tool call, as the adapter forwards it.
 *
 * The envelope names a tool and its arguments and NOTHING else — no root, no
 * connection string, no checkout. A caller-named root is the field a session
 * would use to reopen a store of its own, which is the cost ADR 0152 removed.
 */
export interface RedskilledBrainCall {
  readonly tool: RedskilledBrainTool;
  readonly arguments: Readonly<Record<string, unknown>>;
}

/**
 * What the daemon answers with.
 *
 * `root` is carried back because "which brain answered this?" is the question
 * a host-scoped store makes ambiguous: an operator with a checkout that still
 * holds an old store deserves to see which one their capture landed in.
 */
export interface RedskilledBrainAnswer {
  readonly tool: RedskilledBrainTool;
  /** The host-scoped store root the daemon resolved and holds. */
  readonly root: string;
  readonly result: unknown;
}

/** Validate one `_redskills/brain_call` request. Rejects anything else named. */
export function parseRedskilledBrainCall(value: unknown): RedskilledBrainCall {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams({}, "a brain call needs one tool and its arguments");
  }
  const params = value as Record<string, unknown>;
  for (const key of Object.keys(params)) {
    if (key !== "tool" && key !== "arguments") {
      throw RequestError.invalidParams(
        {},
        `a brain call names a tool and its arguments, never ${JSON.stringify(key)} — ` +
          "the store root is the daemon's, not the caller's",
      );
    }
  }
  if (!isRedskilledBrainTool(params.tool)) {
    throw RequestError.invalidParams(
      {},
      `unknown brain tool ${JSON.stringify(params.tool)} — the surface is ` +
        `${REDSKILLED_BRAIN_TOOLS.join(", ")}`,
    );
  }
  const args = params.arguments ?? {};
  if (typeof args !== "object" || args == null || Array.isArray(args)) {
    throw RequestError.invalidParams({}, "brain call arguments must be an object");
  }
  return { tool: params.tool, arguments: args as Record<string, unknown> };
}
