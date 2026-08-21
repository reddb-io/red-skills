import { describe, expect, it } from "vitest";

import { createJsonRpcClient } from "../src/acp.mjs";

function client() {
  const sent = [];
  const rpc = createJsonRpcClient({ send: (frame) => sent.push(JSON.parse(frame)) });
  return { rpc, sent };
}

describe("the container's JSON-RPC framing over the ACP launch edge", () => {
  it("frames one request per line with an incrementing id", () => {
    const { rpc, sent } = client();

    rpc.request("initialize", { protocolVersion: 1 });
    rpc.request("_redskills/project_status", {});

    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } },
      { jsonrpc: "2.0", id: 2, method: "_redskills/project_status", params: {} },
    ]);
  });

  it("resolves a response that arrives split across chunks", async () => {
    const { rpc } = client();
    const answer = rpc.request("_redskills/project_status");

    rpc.receive('{"jsonrpc":"2.0","id":1,"resu');
    rpc.receive('lt":{"drain_intent":"draining"}}\n');

    await expect(answer).resolves.toEqual({ drain_intent: "draining" });
  });

  it("rejects with the daemon's own words rather than a bare failure", async () => {
    const { rpc } = client();
    const answer = rpc.request("_redskills/project_drain");

    rpc.receive('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"target must be a non-negative integer"}}\n');

    await expect(answer).rejects.toThrow(/target must be a non-negative integer/);
  });

  it("drops notifications and unparseable lines instead of dying of narration", async () => {
    const { rpc } = client();
    const answer = rpc.request("_redskills/project_status");

    rpc.receive('{"jsonrpc":"2.0","method":"session/update","params":{}}\n');
    rpc.receive("not json at all\n");
    rpc.receive('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n');

    await expect(answer).resolves.toEqual({ ok: true });
  });

  it("answers every request in flight when the pipe dies, so nothing hangs forever", async () => {
    const { rpc } = client();
    const answer = rpc.request("_redskills/project_status");

    rpc.fail(new Error("the ACP launch edge exited with 1"));

    await expect(answer).rejects.toThrow(/exited with 1/);
    await expect(rpc.request("_redskills/project_status")).rejects.toThrow(/exited with 1/);
  });
});
