import { describe, expect, test } from "vitest";
import { decideLayer, routeLayer } from "../src/layer-router.js";
import type { MemoryLayer, NodeType, Tier } from "../src/schema.js";

const NODE_TYPES: readonly NodeType[] = [
  "file",
  "import",
  "symbol",
  "concept",
  "decision",
  "problem",
  "solution",
  "fix",
  "workflow",
  "person",
  "why_note",
  "session",
  "task",
  "goal",
  "worker",
  "issue",
  "prd",
  "validation",
];

type Path = "hot" | "durable";

interface Row {
  node_type: NodeType;
  tier?: Tier;
  session: boolean;
  path: Path;
  op: "read" | "write";
  expected: MemoryLayer;
  reason: ReturnType<typeof decideLayer> extends infer R
    ? R extends { reason: infer X }
      ? X
      : never
    : never;
}

function tierForPath(node_type: NodeType, path: Path): Tier {
  if (path === "hot") return "ephemeral";
  return node_type === "why_note" || node_type === "worker" ? "reasoning" : "durable";
}

function buildMatrix(): Row[] {
  const rows: Row[] = [];
  for (const node_type of NODE_TYPES) {
    for (const session of [false, true]) {
      for (const path of ["hot", "durable"] as const) {
        for (const op of ["read", "write"] as const) {
          const tier = tierForPath(node_type, path);
          // Today's slice routes every decision at L3 — see layer-router.ts
          // header. The reason still discriminates between the four branches.
          const expected: MemoryLayer = "L3";
          const reason: Row["reason"] = !session
            ? "no-session"
            : path === "hot" || node_type === "session"
              ? "session-hot"
              : "session-durable";
          rows.push({ node_type, tier, session, path, op, expected, reason });
        }
      }
    }
  }
  return rows;
}

describe("LayerRouter — table-driven matrix (node_type × session × path)", () => {
  const rows = buildMatrix();

  for (const row of rows) {
    const label = `${row.op} ${row.node_type} tier=${row.tier} session=${row.session} path=${row.path}`;
    test(label, () => {
      const decision = decideLayer({
        op: row.op,
        node: { node_type: row.node_type, properties: { tier: row.tier } },
        session: row.session ? { id: "sess-1" } : null,
      });
      expect(decision.layer).toBe(row.expected);
      expect(decision.reason).toBe(row.reason);
    });
  }
});

describe("LayerRouter — explicit overrides and pinned nodes", () => {
  test("explicit requested layer always wins", () => {
    for (const layer of ["L1", "L2", "L3"] as const) {
      const decision = decideLayer({
        op: "read",
        node: { node_type: "decision" },
        session: { id: "s" },
        requested: layer,
      });
      expect(decision).toEqual({ layer, reason: "requested" });
    }
  });

  test("read of a node with a pinned layer routes to that layer", () => {
    const decision = decideLayer({
      op: "read",
      node: { node_type: "decision", properties: { layer: "L2" } },
    });
    expect(decision).toEqual({ layer: "L2", reason: "node-pinned" });
  });

  test("write of a node with a pinned layer still re-evaluates (allows promotion)", () => {
    const decision = decideLayer({
      op: "write",
      node: { node_type: "decision", properties: { layer: "L1" } },
    });
    expect(decision.reason).toBe("no-session");
    expect(decision.layer).toBe("L3");
  });

  test("routeLayer shortcut returns the layer field of decideLayer", () => {
    const input = { op: "read" as const, node: { node_type: "fix" as NodeType } };
    expect(routeLayer(input)).toBe(decideLayer(input).layer);
  });

  test("session node_type with no explicit tier still routes via the session-hot branch", () => {
    const decision = decideLayer({
      op: "write",
      node: { node_type: "session" },
      session: { id: "sess" },
    });
    expect(decision.reason).toBe("session-hot");
  });

  test("session present but session.id missing falls through to no-session", () => {
    const decision = decideLayer({
      op: "read",
      node: { node_type: "decision" },
      session: {},
    });
    expect(decision.reason).toBe("no-session");
  });
});
