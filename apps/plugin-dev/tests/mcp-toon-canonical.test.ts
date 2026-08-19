import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import { encodeRedskilledMcpToon } from "../src/mcp-toon.js";

const WORKER_STATUS = {
  status: [
    {
      worker: {
        id: "hZCNL",
        pid: 439274,
        runner: "codex",
        origin: "afk",
        started_at: "2026-08-11T18:58:19.432Z",
        done: 0,
        total: 0,
        current: {
          number: 3624,
          model: "gpt-5.6-sol",
          effort: "high",
          iteration: "1",
          loc_added: 209,
          wait_kind: "",
          wait_pid: 0,
        },
      },
      live: true,
      active: true,
      renderable_live: true,
      liveness: "active",
    },
  ],
};

const CANONICAL_WORKER_STATUS =
  "status[1]{worker{id,pid,runner,origin,started_at,done,total,current{number,model,effort,iteration,loc_added,wait_kind,wait_pid}},live,active,renderable_live,liveness}:\n" +
  "  hZCNL,439274,codex,afk,\"2026-08-11T18:58:19.432Z\",0,0,3624,gpt-5.6-sol,high,\"1\",209,\"\",0,true,true,true,active";

const VALIDATION_SCHEDULE = {
  moments: [
    { moment: "iteration", state: "skip", declared: false, commands: [] },
    {
      moment: "post_done",
      state: "declared",
      declared: true,
      commands: ["pnpm typecheck", "pnpm -C apps/plugin-dev test:invariants"],
    },
    { moment: "landing", state: "skip", declared: false, commands: [] },
  ],
};

const COMPACT_VALIDATION_SCHEDULE =
  "moments[3]{moment,state,declared,commands[;]}:\n" +
  "  iteration,skip,false,\n" +
  "  post_done,declared,true,pnpm typecheck;\"pnpm -C apps/plugin-dev test:invariants\"\n" +
  "  landing,skip,false,";

const ORDERS_WITH_ITEMS = {
  orders: [
    {
      id: 1,
      items: [
        { sku: "A", qty: 2 },
        { sku: "B", qty: 1 },
      ],
    },
  ],
};

const COMPACT_ORDERS_WITH_ITEMS =
  "orders[1]{id,items{sku,qty}}:\n" +
  "  1,2\n" +
  "    A,2\n" +
  "    B,1";

describe("redskilled MCP canonical TOON", () => {
  it("pins a representative worker status payload to canonical encoder bytes", () => {
    const expected = encode(WORKER_STATUS as unknown as JsonValue);

    expect(expected).toBe(CANONICAL_WORKER_STATUS);
    expect(encodeRedskilledMcpToon(WORKER_STATUS)).toBe(expected);
  });

  it("declares primitive-array columns once for a Validation schedule", () => {
    const encoded = encodeRedskilledMcpToon(VALIDATION_SCHEDULE);

    expect(encoded).toBe(COMPACT_VALIDATION_SCHEDULE);
    expect(decode(encoded)).toEqual(VALIDATION_SCHEDULE);
  });

  it("declares object-array child tables once", () => {
    const encoded = encodeRedskilledMcpToon(ORDERS_WITH_ITEMS);

    expect(encoded).toBe(COMPACT_ORDERS_WITH_ITEMS);
    expect(decode(encoded)).toEqual(ORDERS_WITH_ITEMS);
  });
});
