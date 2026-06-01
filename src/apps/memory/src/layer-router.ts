/**
 * Layer router (PRD #174, issue #175). Pure routing primitive that decides
 * which storage {@link MemoryLayer} a read or write should target given the
 * operation, the node being touched, and the active session — if any.
 *
 * This module never touches RedDB and never opens a store. It is the seam
 * later slices (#3, #5, #6, #7, #9) will plug their L1/L2 implementations
 * into; today every routing decision points at `L3` so existing callers keep
 * observably identical behaviour.
 *
 * Rules, in order:
 *
 * 1. An explicit `requested` layer always wins. Callers asking for a specific
 *    layer get exactly that layer back (the caller is responsible for handling
 *    an L1/L2 miss once those layers exist).
 * 2. If a node already carries a `layer` property, route reads to that layer.
 *    Writes still re-evaluate against the rest of the rules because a write
 *    may be promoting the node out of its current layer.
 * 3. Without a session, every op targets `L3`. The hot path (L1) is
 *    per-agent-turn and the session path (L2) is session-scoped; neither
 *    applies when no session is in play.
 * 4. With a session: `ephemeral` tier (or a `session` node) routes to the
 *    session-scoped path. `reasoning`/`durable` tiers route to the durable
 *    graph. Today both "hot" and "session" return `L3` because L1/L2 storage
 *    is not wired up yet — but the inputs that *will* steer them are already
 *    classified here, so downstream slices can flip a single return value.
 */
import { defaultTier, type MemoryLayer, type NodeType, type Tier } from "./schema.js";

export type LayerRouterOp = "read" | "write";

export interface LayerRouterNode {
  node_type?: NodeType;
  properties?: {
    tier?: Tier;
    layer?: MemoryLayer;
  };
}

export interface LayerRouterSession {
  /** Stable session identifier. Presence alone is enough to enter the session path. */
  id?: string;
}

export interface LayerRouteInput {
  op: LayerRouterOp;
  /** Node descriptor for the read/write. `node_type` drives tier defaulting. */
  node?: LayerRouterNode;
  /** Active session, if any. `null`/`undefined` means no session. */
  session?: LayerRouterSession | null;
  /** Explicit layer the caller is asking for. Always wins when set. */
  requested?: MemoryLayer;
}

export interface LayerRouteDecision {
  layer: MemoryLayer;
  /**
   * Which rule fired, in the order documented at the top of this file. Useful
   * for logging and for downstream slices that want to discriminate "we
   * routed L3 because there was no session" from "we routed L3 because the
   * caller asked for it explicitly".
   */
  reason:
    | "requested"
    | "node-pinned"
    | "no-session"
    | "session-hot"
    | "session-durable";
}

/**
 * Pure routing decision. Returns the structured {@link LayerRouteDecision}.
 * For callers that only want the layer, {@link routeLayer} is a thin shortcut.
 */
export function decideLayer(input: LayerRouteInput): LayerRouteDecision {
  if (input.requested) {
    return { layer: input.requested, reason: "requested" };
  }

  const pinned = input.node?.properties?.layer;
  if (input.op === "read" && pinned) {
    return { layer: pinned, reason: "node-pinned" };
  }

  if (!input.session?.id) {
    return { layer: "L3", reason: "no-session" };
  }

  const tier = resolveTier(input.node);
  if (tier === "ephemeral" || input.node?.node_type === "session") {
    // Hot/session path: future L2. Today still L3 — see file header.
    return { layer: "L3", reason: "session-hot" };
  }
  return { layer: "L3", reason: "session-durable" };
}

export function routeLayer(input: LayerRouteInput): MemoryLayer {
  return decideLayer(input).layer;
}

function resolveTier(node: LayerRouterNode | undefined): Tier {
  if (node?.properties?.tier) return node.properties.tier;
  if (node?.node_type) return defaultTier(node.node_type);
  return "durable";
}
