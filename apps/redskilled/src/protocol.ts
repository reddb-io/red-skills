/**
 * protocol — the `redskilled` wire contract.
 *
 * ADR 0130 rule 3: **the contract is minimal and frozen.** That is what lets one
 * daemon serve checkouts pinned to different bundle versions — version skew
 * stops being managed and stops existing. So every addition here is a deliberate
 * widening of a frozen surface, not a convenience: the daemon carries no castle
 * semantics, and an op that needed to know what a Ticket or a Gate is would
 * belong to the per-project bundle instead.
 *
 * This slice ships the two ops a daemon needs to be *reachable and honest about
 * its own life*: `ping` and `host-state`. Worker birth arrives later and widens
 * this union; nothing here presumes its shape.
 */
import { sendLineRequest } from "@reddb-io/shared/resident-core.js";
import type { RedskilledHostState } from "./host-state.js";

/** The wire version. A daemon states it; a client that cannot read it must not proceed. */
export const REDSKILLED_PROTOCOL_VERSION = 1;

export type RedskilledRequest =
  | { id: string; op: "ping" }
  | { id: string; op: "host-state" }
  | { id: string; op: "shutdown" };

export type RedskilledResponse =
  | { id: string; ok: true; value: unknown }
  | { id: string; ok: false; error: string };

export interface RedskilledPong {
  readonly pong: true;
  readonly protocol_version: number;
  readonly daemon_version: string;
  readonly pid: number;
}

export interface RedskilledClientOptions {
  socketPath: string;
  timeoutMs?: number;
}

/** One request, one response — errors surface as thrown, never as a silent default. */
export async function sendRedskilledRequest(
  opts: RedskilledClientOptions,
  request: RedskilledRequest,
): Promise<RedskilledResponse> {
  return await sendLineRequest<RedskilledRequest, RedskilledResponse>(opts, request, "redskilled daemon");
}

export function isRedskilledPong(value: unknown): value is RedskilledPong {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const pong = value as Record<string, unknown>;
  return pong.pong === true &&
    typeof pong.protocol_version === "number" &&
    typeof pong.daemon_version === "string" &&
    Number.isInteger(pong.pid);
}

export type { RedskilledHostState };
