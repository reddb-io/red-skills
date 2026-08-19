// The `rs_brain` tool surface: schemas, and the daemon method behind them.
//
// The schemas live HERE, in the adapter, so MCP discovery costs no round trip —
// a host that mounts `rs_brain` can list tools before the daemon has been
// reached at all. What it may NOT hold is anything that answers one: no store,
// no RedDB, no channel bridge, no root resolution. Every call is forwarded
// whole to the daemon, which holds the user's one brain (ADR 0152).
//
// The published names are the ones the brain MCP has always published. A rename
// here would be a rename of every skill and habit built on them, which is a
// different decision from moving where the store lives.
import { z } from "zod/v3";
import {
  ARTIFACT_KINDS,
  CONNECTION_KINDS,
} from "@reddb-io/brain-store/schema.js";
import {
  REDSKILLED_BRAIN_TOOLS,
  REDSKILLS_ACP_METHODS,
  type RedskilledBrainTool,
} from "@reddb-io/protocol-acp";

/** The published name of the brain plugin's own MCP (ADR 0147 rule 2). */
export const RS_BRAIN_MCP_SERVER_NAME = "rs_brain";

/** The daemon method every tool forwards to. Named from the shared registry. */
export const RS_BRAIN_CALL_METHOD = REDSKILLS_ACP_METHODS.brainCall;

/** One published tool: what it is called, what it says, and what it takes. */
export interface RsBrainTool {
  readonly name: RedskilledBrainTool;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodType>;
}

const identifier = z.union([z.string(), z.number()]);

const searchShape = {
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
};

/**
 * Declare the `rs_brain` surface.
 *
 * `brain_init` and `brain_status` answer the same thing on purpose: since the
 * store is the host's and the daemon opens it, there is nothing left for a
 * session to initialise — `brain_init` survives as the name an operator already
 * reaches for, and reports where the one brain is.
 */
export function createRsBrainTools(): RsBrainTool[] {
  return [
    {
      name: "brain_init",
      title: "Locate the host Brain",
      description:
        "Report the host Brain the daemon holds — its root, its config path and its status. " +
        "The store is the user's, at ~/.red/brain, opened once per machine; a session " +
        "initialises nothing of its own.",
      inputSchema: {},
    },
    {
      name: "brain_status",
      title: "Read Brain status",
      description: "Return the host Brain's status: where it lives and what it holds.",
      inputSchema: {},
    },
    {
      name: "brain_capture",
      title: "Capture a Brain artifact",
      description:
        "MUTATING: capture a durable artifact in the host Brain. `source_path` records where " +
        "the capture came from; the adapter fills it with the session's directory when the " +
        "caller names none.",
      inputSchema: {
        title: z.string().min(1),
        content: z.string().min(1),
        kind: z.enum(ARTIFACT_KINDS as unknown as [string, ...string[]]).optional(),
        tags: z.array(z.string()).optional(),
        source_agent: z.string().optional(),
        source_session: z.string().optional(),
        source_path: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      },
    },
    {
      name: "brain_search",
      title: "Search the Brain",
      description: "Search Brain artifacts and return scored hits.",
      inputSchema: searchShape,
    },
    {
      name: "brain_think",
      title: "Synthesise over Brain hits",
      description:
        "Return a deterministic cited synthesis over Brain search hits, including citations, " +
        "confidence, and missing evidence.",
      inputSchema: searchShape,
    },
    {
      name: "brain_get",
      title: "Read one Brain artifact",
      description: "Read a Brain artifact by rid or id.",
      inputSchema: { id: identifier },
    },
    {
      name: "brain_link",
      title: "Link two Brain artifacts",
      description: "MUTATING: create a typed connection between two Brain artifacts.",
      inputSchema: {
        from: identifier,
        to: identifier,
        kind: z.enum(CONNECTION_KINDS as unknown as [string, ...string[]]).optional(),
        reason: z.string().optional(),
      },
    },
    {
      name: "brain_backlinks",
      title: "List incoming connections",
      description: "List incoming connections for a Brain artifact.",
      inputSchema: { id: identifier },
    },
    {
      name: "brain_act",
      title: "Send to a channel target",
      description:
        "MUTATING: send a message to a channel target through the ChannelBridge, outbound-only " +
        "(no gateway daemon; channel tokens only). The bridge is the daemon's, so a session " +
        "starts none of its own.",
      inputSchema: { target: z.string().min(1), message: z.string().min(1) },
    },
    {
      name: "brain_kpis",
      title: "Aggregate Brain events",
      description:
        "Compute time-windowed KPI aggregations over kind:event artifacts (counts and per-window " +
        "series), shaped for a dashboard. No metrics store; derived from the artifact graph.",
      inputSchema: {
        interval: z.enum(["hour", "day", "week", "month"]).optional(),
        group_by: z.enum(["platform", "event_type", "target"]).optional(),
        time_field: z.enum(["event", "ingested"]).optional(),
        from: identifier.optional(),
        to: identifier.optional(),
        platform: z.string().optional(),
        event_type: z.string().optional(),
        target: z.string().optional(),
      },
    },
  ];
}

/**
 * The declared surface covers the wire's surface, exactly.
 *
 * Asserted as a FUNCTION rather than trusted, because the two lists are read by
 * different processes: a tool published here and unknown to the daemon is a
 * call that fails on the far side of a socket, and a tool the daemon serves and
 * this never publishes is a capability no host can reach.
 */
export function rsBrainToolCoverage(tools: readonly RsBrainTool[]): {
  readonly missing: readonly string[];
  readonly extra: readonly string[];
} {
  const published = new Set<string>(tools.map((tool) => tool.name));
  return {
    missing: REDSKILLED_BRAIN_TOOLS.filter((tool) => !published.has(tool)),
    extra: [...published].filter((tool) => !(REDSKILLED_BRAIN_TOOLS as readonly string[]).includes(tool)),
  };
}
