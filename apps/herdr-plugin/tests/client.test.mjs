/**
 * A daemon this test owns, speaking the frozen contract of
 * `apps/redskilled/src/protocol.ts`: one TOON frame in, one TOON frame out. It
 * exists because the client's failure modes are the ones that matter — a socket
 * that is not there, a daemon that refuses, one that never answers — and none of
 * them can be exercised against a real host.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRedskilledClient, readRedskilledSnapshot, RedskilledRequestError, RedskilledUnreachableError } from "../src/redskilled/client.mjs";
import { decodeFrame, encodeFrame, takeFrame } from "../src/redskilled/wire.mjs";
import { hostState, statuslinePayload } from "./fixtures.mjs";

async function withDaemon(handler, run) {
  const dir = await mkdtemp(join(tmpdir(), "red-skills-sock-"));
  const socketPath = join(dir, "redskilled.sock");
  const seen = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let framed = takeFrame(buffer); framed; framed = takeFrame(buffer)) {
        buffer = framed.rest;
        const request = decodeFrame(framed.frame);
        seen.push(request);
        const response = handler(request);
        if (response !== undefined) socket.write(encodeFrame(response));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await run({ socketPath, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("a read carries the ops the daemon publishes, and unwraps ok:true", async () => {
  await withDaemon(
    (request) => {
      if (request.op === "ping") {
        return { id: request.id, ok: true, value: { pong: true, protocol_version: 1, daemon_version: "0.4.1", pid: 4242 } };
      }
      if (request.op === "statusline-payload") return { id: request.id, ok: true, value: statuslinePayload() };
      if (request.op === "host-state") return { id: request.id, ok: true, value: hostState() };
      return { id: request.id, ok: false, error: `unknown op ${request.op}` };
    },
    async ({ socketPath, seen }) => {
      const client = createRedskilledClient({ socketPath });
      const pong = await client.ping();
      assert.equal(pong.daemon_version, "0.4.1");

      const snapshot = await readRedskilledSnapshot(client, { sessionProject: "reddb-io/red-skills" });
      assert.equal(snapshot.reachable, true);
      assert.equal(snapshot.payload.host.worker_count, 2);
      assert.equal(snapshot.hostState.registrations.length, 1);

      const payloadRequest = seen.find((request) => request.op === "statusline-payload");
      assert.equal(payloadRequest.session_project, "reddb-io/red-skills");
      assert.ok(typeof payloadRequest.id === "string" && payloadRequest.id.length > 0, "every request carries its own id");
    },
  );
});

test("a refusal keeps the daemon's own sentence", async () => {
  await withDaemon(
    (request) => ({ id: request.id, ok: false, error: "reach refused: this session may not read that" }),
    async ({ socketPath }) => {
      const client = createRedskilledClient({ socketPath });
      await assert.rejects(() => client.hostState(), (error) => {
        assert.ok(error instanceof RedskilledRequestError);
        assert.match(error.message, /reach refused/);
        return true;
      });
    },
  );
});

test("a socket that is not there is unreachable, never an idle host", async () => {
  const client = createRedskilledClient({ socketPath: join(tmpdir(), "red-skills-absent.sock"), timeoutMs: 300 });
  await assert.rejects(() => client.ping(), (error) => {
    assert.ok(error instanceof RedskilledUnreachableError);
    return true;
  });

  const snapshot = await readRedskilledSnapshot(client);
  assert.equal(snapshot.reachable, false);
  assert.equal(snapshot.payload, null, "an unreachable daemon yields no payload to render zeros from");
  assert.match(snapshot.error.message, /not reachable/);
});

test("a daemon that never answers times out rather than hanging a pane", async () => {
  await withDaemon(
    () => undefined,
    async ({ socketPath }) => {
      const client = createRedskilledClient({ socketPath, timeoutMs: 200 });
      await assert.rejects(() => client.ping(), (error) => {
        assert.ok(error instanceof RedskilledUnreachableError);
        assert.match(error.message, /did not answer within 200ms/);
        return true;
      });
    },
  );
});

test("this client never sends an op that changes the machine", async () => {
  await withDaemon(
    (request) => ({ id: request.id, ok: true, value: request.op === "host-state" ? hostState() : statuslinePayload() }),
    async ({ socketPath, seen }) => {
      const client = createRedskilledClient({ socketPath });
      await readRedskilledSnapshot(client);
      await client.statuslineString(undefined, { mode: "global" }).catch(() => {});
      const writes = seen.filter((request) =>
        ["worker-start", "worker-command", "worker-heartbeat", "project-register", "project-renew", "project-deregister", "shutdown"].includes(request.op),
      );
      assert.deepEqual(writes, [], "reach is asymmetric: this plugin is entirely on the reading half");
    },
  );
});
