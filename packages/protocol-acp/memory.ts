// memory — the `_redskills/memory_call` params and answer shapes (ADR 0152).
//
// **Memory is per Project, and the Project is not the checkout.** The daemon
// holds one store per Project at `~/.red/memory/<project-id>`, keyed by the
// Project's GitHub identity; a repository may opt in to the human checkout's
// `./.red/memory`, and the daemon opens THAT only for the two modes a human is
// standing in (ADR 0150 §1). One method carries every tool, for the same reason
// the brain wire does: the vocabulary belongs to memory, and a wire that
// restated it would be a second list to keep in step.
//
// What lives here is the WIRE: the envelope, the caller-declared mode, and the
// static core of the surface. WHICH store answers, and what a tool DOES, are
// the daemon's and stay with the daemon (ADR 0148's body-versus-control cut).
import { RequestError } from "@agentclientprotocol/sdk";

import { WORKING_MODES, type WorkingMode } from "@reddb-io/shared/working-mode.js";

/**
 * The tools the adapter publishes without ever reaching a daemon.
 *
 * This is the STATIC core, not the whole surface: memory's read-only operation
 * tools are generated from a registry that lives with the engine, so the daemon
 * is the only thing that can enumerate them. `memory_tools` is how a session
 * asks for the rest — one probe rather than a second list to keep in step.
 */
export const REDSKILLED_MEMORY_CORE_TOOLS = [
  "memory_tools",
  "memory_recall",
  "memory_store",
  "memory_store_evidence",
  "memory_search",
  "memory_traverse",
  "memory_neighbors",
  "memory_path",
  "memory_export",
  "memory_doctor",
  "memory_stats",
  "memory_conflicts",
  "memory_timeline",
  "memory_supersede",
  "memory_session_start",
  "memory_session_end",
  "memory_working_get",
  "memory_working_set",
  "memory_promote",
  "memory_autocure",
] as const;

export type RedskilledMemoryCoreTool = (typeof REDSKILLED_MEMORY_CORE_TOOLS)[number];

/**
 * The shape every memory tool name has.
 *
 * Checked rather than enumerated because the surface is PARTLY generated: the
 * read-only operations register their own `memory_*` tool names beside the core
 * above, and a wire that enumerated them would have to be regenerated every
 * time the engine grew one. The daemon still refuses a name its live registry
 * does not know — this only keeps a caller from spelling something that is not
 * a memory tool at all.
 */
const MEMORY_TOOL_NAME = /^memory_[a-z0-9]+(?:_[a-z0-9]+)*$/;

export function isRedskilledMemoryTool(value: unknown): value is string {
  return typeof value === "string" && MEMORY_TOOL_NAME.test(value);
}

/**
 * One memory tool call, as the adapter forwards it.
 *
 * `mode` is the ONE fact the daemon cannot read for itself. The daemon runs in
 * no checkout and holds no `RED_MODE`; the marker lives in the calling
 * process's environment (ADR 0150 §2), so the caller states it and the daemon
 * decides what it buys. Naming a mode can never widen past the caller's OWN
 * Project — the checkout the daemon might open is the one it already resolved
 * from that caller's `cwd`, and only when the repository opted in.
 *
 * There is deliberately no `root` field. A caller-named root is the field a
 * session would use to reopen a store of its own, which is the cost ADR 0152
 * removed.
 */
export interface RedskilledMemoryCall {
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  /** The caller's declared Working mode; absent means "no `RED_MODE` here". */
  readonly mode?: WorkingMode;
}

/**
 * What the daemon answers with.
 *
 * `root` and `scope` travel back because "which memory answered this?" is the
 * question a per-Project store with a checkout opt-in makes ambiguous: an
 * operator who opted in deserves to see whether their interactive session
 * reached the checkout or the host-scoped Project store.
 */
export interface RedskilledMemoryAnswer {
  readonly tool: string;
  /** The store root the daemon resolved and holds for this Project. */
  readonly root: string;
  /** Which of the two roots answered: the Project's own, or the checkout's. */
  readonly scope: RedskilledMemoryScope;
  readonly result: unknown;
}

/** Where a resolved memory store lives. */
export type RedskilledMemoryScope = "project" | "checkout";

/** Validate one `_redskills/memory_call` request. Rejects anything else named. */
export function parseRedskilledMemoryCall(value: unknown): RedskilledMemoryCall {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams({}, "a memory call needs one tool and its arguments");
  }
  const params = value as Record<string, unknown>;
  for (const key of Object.keys(params)) {
    if (key !== "tool" && key !== "arguments" && key !== "mode") {
      throw RequestError.invalidParams(
        {},
        `a memory call names a tool, its arguments and the caller's mode, never ` +
          `${JSON.stringify(key)} — the store root is the daemon's, not the caller's`,
      );
    }
  }
  if (!isRedskilledMemoryTool(params.tool)) {
    throw RequestError.invalidParams(
      {},
      `unknown memory tool ${JSON.stringify(params.tool)} — a memory tool is named ` +
        `memory_<verb>, and the core surface is ${REDSKILLED_MEMORY_CORE_TOOLS.join(", ")}`,
    );
  }
  const args = params.arguments ?? {};
  if (typeof args !== "object" || args == null || Array.isArray(args)) {
    throw RequestError.invalidParams({}, "memory call arguments must be an object");
  }
  const mode = parseMode(params.mode);
  return {
    tool: params.tool,
    arguments: args as Record<string, unknown>,
    ...(mode == null ? {} : { mode }),
  };
}

/**
 * An absent mode is ordinary — it says "this caller exports no `RED_MODE`".
 * An unrecognised one is refused rather than dropped: silently reading a
 * string nobody declared as "no mode" is how an unknown caller would inherit
 * the interactive answer.
 */
function parseMode(value: unknown): WorkingMode | undefined {
  if (value === undefined || value === null) return undefined;
  const found = WORKING_MODES.find((mode) => mode === value);
  if (found == null) {
    throw RequestError.invalidParams(
      {},
      `unknown Working mode ${JSON.stringify(value)} — the four are ${WORKING_MODES.join(", ")}`,
    );
  }
  return found;
}
