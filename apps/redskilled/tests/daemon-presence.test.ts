// "I could not reach it" is not "it is not there" (#3092).
//
// Every client refused a daemon that was alive, listening and actively working,
// and reported it as one that never started — then advised provisioning it. The
// mechanism was a correctly-functioning singleton: the client's own redundant
// spawn was refused because a live pid held the lease, and that `exit 1` was
// rendered as "the daemon did not start". The healthy path and the broken path
// printed the same sentence.
//
// These checks pin the four facts that keep them apart:
//
//   1. the classifier separates answering / held-unresponsive / absent, and only
//      the last one is an absence to provision;
//   2. a client facing a socket a live pid holds does NOT spawn a rival, and its
//      refusal names that pid and socket rather than "did not start";
//   3. a live daemon stays reachable from every surface no matter how old its
//      lease record is — no freshness check may reject a working host;
//   4. the operator advice a project prints never says "provision" when the reach
//      established that a daemon is running.
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encode, type JsonValue } from "@reddb-io/toon";
import {
  describeRedskilledPresence,
  ensureRedskilledDaemon,
  formatUptime,
  probeRedskilledPresence,
  readRedskilledHostState,
  readRedskilledStatuslinePayload,
  RedskilledDaemonHeldError,
  RedskilledUnreachableError,
  stopRedskilledDaemon,
} from "../src/client.js";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import type { RedskilledLease } from "../src/session-lease.js";

const running: RedskilledDaemon[] = [];
const servers: Server[] = [];
const openSockets: Socket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  // Connections first: a wedged daemon's whole point is that it never replies, so
  // every probe left a socket open and `close()` alone would wait for them.
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-presence-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function lease(paths: RedskilledPaths, overrides: Partial<RedskilledLease> = {}): RedskilledLease {
  return {
    version: 1,
    pid: process.pid,
    start_time: "2026-08-02T17:04:25.362Z",
    session_key_hash: paths.sessionKeyHash,
    machine_id_hash: paths.machineIdHash,
    socket_path: paths.socketPath,
    acquired_at: "2026-08-02T17:04:25.362Z",
    renewed_at: "2026-08-02T17:04:25.362Z",
    ...overrides,
  };
}

async function writeLease(paths: RedskilledPaths, record: RedskilledLease): Promise<void> {
  await writeFile(paths.leasePath, `${encode(record as unknown as JsonValue)}\n`, "utf8");
}

/** A socket that accepts a connection and never answers — the wedged daemon. */
async function silentSocket(socketPath: string): Promise<Server> {
  const server = createServer((socket) => openSockets.push(socket));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

describe("the three silences a redskilled client can meet", () => {
  it("separates answering, held-unresponsive and absent", () => {
    const socketPath = "/run/user/1000/red-skills/abc/redskilled.sock";
    const record = {
      version: 1,
      pid: 900_870,
      start_time: "2026-08-02T17:04:25.362Z",
      session_key_hash: "aaa",
      machine_id_hash: "bbb",
      socket_path: socketPath,
      acquired_at: "2026-08-02T17:04:25.362Z",
      renewed_at: "2026-08-02T17:04:25.362Z",
    } as const satisfies RedskilledLease;
    const now = "2026-08-02T21:47:51.362Z";

    const answering = describeRedskilledPresence({ socketPath, answers: true, lease: record, holderAlive: true, now });
    expect(answering.kind).toBe("answering");

    const held = describeRedskilledPresence({ socketPath, answers: false, lease: record, holderAlive: true, now });
    expect(held.kind).toBe("held-unresponsive");
    expect(held.holder).toMatchObject({ pid: 900_870, socket_path: socketPath });
    // The pid, the socket and the uptime — what the operator acts on.
    expect(held.reason).toContain("900870");
    expect(held.reason).toContain(socketPath);
    expect(held.reason).toContain("4h43m");
    // And never the repair for the state this is not.
    expect(held.repair).toContain("Do not provision");
    expect(held.repair).not.toContain("provision`");

    const dead = describeRedskilledPresence({ socketPath, answers: false, lease: record, holderAlive: false, now });
    expect(dead.kind).toBe("absent");
    expect(dead.repair).toContain("provision");

    const bare = describeRedskilledPresence({ socketPath, answers: false, now });
    expect(bare.kind).toBe("absent");
    expect(bare.holder).toBeNull();

    // A lease on ANOTHER socket names a daemon this client is not talking to.
    const elsewhere = describeRedskilledPresence({
      socketPath,
      answers: false,
      lease: { ...record, socket_path: "/run/user/1000/other.sock" },
      holderAlive: true,
      now,
    });
    expect(elsewhere.kind).toBe("absent");
  });

  it("reads uptime the way an operator does", () => {
    expect(formatUptime(4 * 3_600_000 + 43 * 60_000)).toBe("4h43m");
    expect(formatUptime(90_000)).toBe("1m30s");
    expect(formatUptime(9_000)).toBe("9s");
  });

  it("never spawns a rival, and names the live holder instead of 'did not start'", async () => {
    const paths = await sessionPaths();
    // A daemon that is alive and listening — and does not answer. Exactly the
    // host in #3092: a raw client connects, a ping gets nothing back.
    await silentSocket(paths.socketPath);
    await writeLease(paths, lease(paths));
    expect(await socketAnswers(paths.socketPath)).toBe(false);

    const probed = await probeRedskilledPresence(paths);
    expect(probed.kind).toBe("held-unresponsive");

    const error = await ensureRedskilledDaemon(paths, {
      // A spawn would run this and fail loudly, which is how "nothing was
      // spawned" is an observation rather than an assumption.
      serverCommand: process.execPath,
      serverArgs: ["-e", "process.exit(1)"],
      readyTimeoutMs: 400,
    }).then((outcome) => outcome as never, (err: unknown) => err);

    expect(error).toBeInstanceOf(RedskilledDaemonHeldError);
    expect(error).toBeInstanceOf(RedskilledUnreachableError);
    const message = (error as Error).message;
    expect(message).toContain(String(process.pid));
    expect(message).toContain(paths.socketPath);
    expect(message).not.toContain("did not start");
    expect(message).toContain("Do not provision");
  });

  it("keeps a live daemon reachable from every surface however old its lease is", async () => {
    const paths = await sessionPaths();
    // Renewal off, then the record backdated by a week: past any staleness
    // threshold anyone could reasonably invent.
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000, leaseRenewMs: 0 });
    running.push(daemon);
    await writeLease(paths, lease(paths, {
      pid: process.pid,
      start_time: daemon.lease.start_time,
      acquired_at: "2026-07-26T09:00:00.000Z",
      renewed_at: "2026-07-26T09:00:00.000Z",
    }));

    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(await ensureRedskilledDaemon(paths, { readyTimeoutMs: 2_000 })).toBe("already-running");
    expect((await probeRedskilledPresence(paths)).kind).toBe("answering");
    expect((await readRedskilledHostState(paths)).pid).toBe(process.pid);
    expect((await readRedskilledStatuslinePayload(paths)).version).toBeGreaterThan(0);

    const stopped = await stopRedskilledDaemon(paths, { detail: "presence probe" });
    expect(stopped.stopped).toBe(true);
  }, 30_000);

  it("reports a genuinely absent daemon as absent", async () => {
    const paths = await sessionPaths();
    const presence = await probeRedskilledPresence(paths);
    expect(presence.kind).toBe("absent");
    expect(presence.holder).toBeNull();
    expect(presence.repair).toContain("provision");
  });
});
