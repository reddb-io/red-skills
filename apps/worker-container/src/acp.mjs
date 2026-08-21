/**
 * The container's ACP client — twenty lines of JSON-RPC over a pipe, because
 * that is all the daemon's launch edge is.
 *
 * `red-skills-redskilled acp` is transport and nothing else: it pipes this
 * process's stdio into the daemon's ACP socket (`runRedskillsAcpAdapter`). So a
 * client that speaks newline-delimited JSON-RPC 2.0 to that child is speaking
 * to the daemon's control plane directly, with no path resolution, no socket
 * rendezvous and no dependency on repository source the image does not carry.
 *
 * **The framing half is pure**, so its failure modes are testable without a
 * daemon: {@link createJsonRpcClient} owns ids, pending promises and line
 * decoding, and is handed a `send` that writes somewhere. The spawning half
 * below is the only part that needs a machine.
 */

import { REDSKILLS_ACP_METHODS, REDSKILLS_WIRE_MAJOR } from "./protocol.mjs";

/**
 * A JSON-RPC 2.0 client over line-delimited frames. PURE apart from `send`.
 *
 * A response with no pending request is DROPPED rather than thrown on: the
 * daemon notifies session updates on the same pipe, and a client that treated
 * every unmatched frame as a protocol error would die of the daemon narrating.
 */
export function createJsonRpcClient({ send }) {
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  let closed = null;

  const settle = (id, resolve, reject) => pending.set(id, { resolve, reject });

  return {
    request(method, params = {}) {
      if (closed != null) return Promise.reject(closed);
      const id = nextId++;
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      return new Promise((resolve, reject) => {
        settle(id, resolve, reject);
        try {
          send(`${frame}\n`);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },

    /** Feed raw bytes; complete lines are decoded, a partial tail is kept. */
    receive(chunk) {
      buffer += String(chunk);
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        cut = buffer.indexOf("\n");
        if (line === "") continue;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        const held = frame?.id == null ? undefined : pending.get(frame.id);
        if (held == null) continue;
        pending.delete(frame.id);
        if (frame.error != null) {
          held.reject(new Error(`${frame.error.code ?? "?"}: ${frame.error.message ?? "ACP request failed"}`));
        } else {
          held.resolve(frame.result);
        }
      }
    },

    /**
     * The pipe died. Every request still in flight is answered with the reason,
     * because a promise that never settles is how a supervisor hangs forever.
     */
    fail(error) {
      closed = error instanceof Error ? error : new Error(String(error));
      for (const [, held] of pending) held.reject(closed);
      pending.clear();
    },
  };
}

/**
 * Open one Project ACP session against the daemon.
 *
 * The connection binds ONE project, resolved by the daemon from the session's
 * `cwd` (`resolveAcpProjectIdentity`) — which is why this takes a clone
 * directory and why a container draining two repositories opens two of these.
 */
export async function openProjectSession({ spawn, argv, cwd, env, name, version, onLine = () => {} }) {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], env });
  const client = createJsonRpcClient({ send: (frame) => child.stdin.write(frame) });

  // A write to a pipe whose reader is gone raises on the stream, not at the
  // call: unhandled, that `EPIPE` takes the whole container down at exactly the
  // moment the daemon died, hiding the death behind a crash of our own.
  child.stdin.on("error", (error) => client.fail(error));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => client.receive(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => onLine(String(chunk).trimEnd()));
  child.on("error", (error) => client.fail(error));
  child.on("close", (code) => client.fail(new Error(`the ACP launch edge exited with ${code ?? "a signal"}`)));

  await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name, version },
    _meta: { redskills: { wireMajor: REDSKILLS_WIRE_MAJOR } },
  });
  const session = await client.request("session/new", { cwd, mcpServers: [] });

  return {
    sessionId: session?.sessionId,
    drain: (request) => client.request(REDSKILLS_ACP_METHODS.projectDrain, request),
    stop: () => client.request(REDSKILLS_ACP_METHODS.projectStop, {}),
    status: () => client.request(REDSKILLS_ACP_METHODS.projectStatus, {}),
    close() {
      client.fail(new Error("the container closed this ACP session"));
      child.kill("SIGTERM");
    },
  };
}
