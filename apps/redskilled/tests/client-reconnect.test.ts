// An established client survives daemon replacement without asking its operator
// to retry the MCP tool call. Cold-start rendezvous already waits for one ready
// window; replacement must outlive that window and keep joining with backoff.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encode, type JsonValue } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";

import { ensureRedskilledDaemon, readRedskilledHostState } from "../src/client.js";
import { handleSocket, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import type { RedskilledLease } from "../src/session-lease.js";

const running: RedskilledDaemon[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("an established client across daemon replacement", () => {
  it("joins a restart that lasts longer than one ready window", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-client-reconnect-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const first = await startRedskilledDaemon({ paths });
    running.push(first);

    const config = {
      readyTimeoutMs: 40,
      reconnectTimeoutMs: 1_000,
      reconnectInitialBackoffMs: 20,
      supervisor: { installed: () => true, start: () => undefined },
    };
    await readRedskilledHostState(paths, config);
    await first.stop();

    const replacement = new Promise<RedskilledDaemon>((resolve, reject) => {
      setTimeout(() => {
        startRedskilledDaemon({ paths }).then(resolve, reject);
      }, 150);
    });

    const after = await readRedskilledHostState(paths, config);
    const second = await replacement;
    running.push(second);

    expect(after.pid).toBe(second.lease.pid);
  });

  it("reports a live takeover holder as replacing or booting while retrying", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-client-takeover-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const server = createServer((socket) => sockets.push(socket));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socketPath, () => resolve());
    });
    const now = new Date().toISOString();
    const lease = {
      version: 1,
      pid: process.pid,
      start_time: now,
      session_key_hash: paths.sessionKeyHash,
      machine_id_hash: paths.machineIdHash,
      socket_path: paths.socketPath,
      acquired_at: now,
      renewed_at: now,
    } satisfies RedskilledLease;
    await writeFile(paths.leasePath, `${encode(lease as unknown as JsonValue)}\n`, "utf8");

    const error = await ensureRedskilledDaemon(paths, {
      readyTimeoutMs: 30,
      reconnectTimeoutMs: 600,
      reconnectInitialBackoffMs: 10,
    }).then((value) => value as never, (cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/replacing\/booting, retrying/);
    expect((error as Error).message).toContain(`pid ${process.pid}`);
    expect((error as Error).message).not.toContain("Install and start");
    expect((error as Error).message).not.toContain("redskilled provision");
  });

  it("re-probes when the daemon drops after ping but before the request answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-client-request-drop-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    let dropped = false;
    let replacement!: Promise<RedskilledDaemon>;
    const server = createServer((socket) => handleSocket(socket, async (request, respond) => {
      if (request.op === "ping") {
        respond({
          id: request.id,
          ok: true,
          value: { pong: true, protocol_version: 1, daemon_version: "replacing", pid: process.pid },
        });
        return;
      }
      dropped = true;
      socket.destroy();
      replacement = new Promise<RedskilledDaemon>((resolve, reject) => {
        server.close(() => {
          setTimeout(() => startRedskilledDaemon({ paths }).then(resolve, reject), 100);
        });
      });
    }));
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.socketPath, () => resolve());
    });

    const state = await readRedskilledHostState(paths, {
      readyTimeoutMs: 40,
      requestTimeoutMs: 100,
      reconnectTimeoutMs: 1_000,
      reconnectInitialBackoffMs: 20,
      supervisor: { installed: () => true, start: () => undefined },
    });
    const second = await replacement;
    running.push(second);

    expect(dropped).toBe(true);
    expect(state.pid).toBe(second.lease.pid);
  });
});
