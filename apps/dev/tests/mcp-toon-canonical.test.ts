import { encode, type JsonValue } from "@reddb-io/toon";
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

describe("redskilled MCP canonical TOON", () => {
  it("pins a representative worker status payload to canonical encoder bytes", () => {
    const expected = encode(WORKER_STATUS as unknown as JsonValue);

    expect(expected).toBe(CANONICAL_WORKER_STATUS);
    expect(encodeRedskilledMcpToon(WORKER_STATUS)).toBe(expected);
  });
});
