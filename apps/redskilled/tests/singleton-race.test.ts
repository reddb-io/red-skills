// One machine, one daemon. Since ADR 0150 §4 no client starts one, so the race
// these checks guard is between the daemon and its own debris — a stale socket, an
// aged lease, a shipped candidate arriving at a session somebody already holds.
// ADR 0130 resolves each with an exclusive bind plus a session lease; the failure
// mode being guarded is two daemons that both believe they own the socket.
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deathLaneFileIn, readProcessDeathLane } from "@reddb-io/shared/death-record.js";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRedskilledDaemon, readRedskilledHostState } from "../src/client.js";
import { birthRedskilledDaemon } from "../src/daemon-birth.js";
import { RedskilledAlreadyRunningError, socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { redskilledServeArgv } from "../src/daemon-entry.js";
import { createRedskilledMachineClaimStore } from "../src/machine-scope.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import { createRedskilledLeaseStore } from "../src/session-lease.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");

const running: RedskilledDaemon[] = [];
const children: ChildProcess[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-race-"));
  roots.push(root);
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

function clientConfig(paths: RedskilledPaths) {
  return {
    serverCommand: process.execPath,
    serverArgs: ["--import", tsxLoader, cliEntry],
    readyTimeoutMs: 20_000,
    env: { ...process.env, REDSKILLED_SESSION: `test:${paths.runtimeDir}` },
  };
}

describe("redskilled singleton", () => {
  it("refuses a second in-process daemon on the same session socket", async () => {
    const paths = await sessionPaths();
    const first = await startRedskilledDaemon({ paths });
    running.push(first);

    await expect(startRedskilledDaemon({ paths })).rejects.toBeInstanceOf(RedskilledAlreadyRunningError);
    expect(await socketAnswers(paths.socketPath)).toBe(true);
  });

  it("lets a shipped candidate stand down without recording a daemon death", async () => {
    const paths = await sessionPaths();
    const first = await startRedskilledDaemon({ paths });
    running.push(first);
    const home = paths.runtimeDir;
    const candidate = spawn(
      process.execPath,
      ["--import", tsxLoader, cliEntry, ...redskilledServeArgv(paths)],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          HOME: home,
          REDSKILLED_SESSION: `test:${paths.runtimeDir}`,
          REDSKILLED_MACHINE_DIR: paths.runtimeDir,
        },
      },
    );
    children.push(candidate);

    const [code, signal] = await once(candidate, "exit");

    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(
      readProcessDeathLane(deathLaneFileIn(join(redskilledHomeDir(home), "state"))),
    ).toEqual([]);
  });

  it("serves concurrent clients from one owner, and refuses a second daemon", async () => {
    const paths = await sessionPaths();
    const config = clientConfig(paths);
    // Provisioning is the ONE start on the machine now, so the daemon exists
    // before any client asks — the clients only ever find it.
    await birthRedskilledDaemon(paths, config);

    const [a, b] = await Promise.all([
      ensureRedskilledDaemon(paths, config),
      ensureRedskilledDaemon(paths, config),
    ]);
    expect([a, b]).toEqual(["already-running", "already-running"]);

    const state = await readRedskilledHostState(paths, config);
    expect(state.workers).toEqual([]);

    // One owner: the pid answering the socket is the same for every client, and
    // a third daemon attempting to start is refused outright.
    const second = await readRedskilledHostState(paths, config);
    expect(second.pid).toBe(state.pid);
    await expect(startRedskilledDaemon({ paths })).rejects.toBeInstanceOf(RedskilledAlreadyRunningError);

    await sendRedskilledRequest({ socketPath: paths.socketPath }, { id: "shutdown-1", op: "shutdown" });
  });

  it("takes over socket debris a crash left behind with nothing listening", async () => {
    const paths = await sessionPaths();
    // A path that is occupied but answers nothing is exactly what a crash
    // leaves: the bind must fail once, be diagnosed as debris, and then succeed.
    await writeFile(paths.socketPath, "");
    expect(await socketAnswers(paths.socketPath)).toBe(false);

    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);
    expect(await socketAnswers(paths.socketPath)).toBe(true);
  });

  it("reclaims an aged lease from a live socketless holder so a successor can bind", async () => {
    const paths = await sessionPaths();
    const holderStart = "2026-08-05T10:00:00.000Z";
    const now = "2026-08-05T10:02:00.000Z";
    const labels = {
      machineIdHash: paths.machineIdHash,
      sessionKeyHash: paths.sessionKeyHash,
      socketPath: paths.socketPath,
    };
    const leaseStore = createRedskilledLeaseStore(paths.leasePath, labels, { clock: () => holderStart });
    const claimStore = createRedskilledMachineClaimStore(paths.machineClaimPath, labels, { clock: () => holderStart });
    const holder = { pid: process.pid, startTime: holderStart };
    const machineHolder = {
      ...holder,
      uid: typeof process.getuid === "function" ? process.getuid() : -1,
    };
    await leaseStore.acquire(holder);
    await claimStore.claim(machineHolder);

    // This is the wedge: the recorded pid is alive and owns both records, but
    // its socket has already been unlinked. Before #3401 the successor refused
    // here with "a redskilled daemon already owns <socket>" until SIGKILL.
    expect(isPidAlive(holder.pid)).toBe(true);
    expect(await socketAnswers(paths.socketPath)).toBe(false);

    const successorOwner = { pid: process.pid + 100_000, startTime: now };
    const successor = await startRedskilledDaemon({
      paths,
      clock: () => now,
      owner: successorOwner,
      machineOwner: { ...successorOwner, uid: machineHolder.uid },
    });
    running.push(successor);

    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(successor.lease.pid).toBe(successorOwner.pid);
    expect(isPidAlive(holder.pid)).toBe(true);
  });

  it("starts the daemon out of process through the shipped cli entry", async () => {
    const paths = await sessionPaths();
    const outcome = await birthRedskilledDaemon(paths, clientConfig(paths));
    expect(outcome).toBe("spawned");

    const state = await readRedskilledHostState(paths, clientConfig(paths));
    expect(state.pid).not.toBe(process.pid);
    expect(state.workers).toEqual([]);

    await sendRedskilledRequest({ socketPath: paths.socketPath }, { id: "shutdown-2", op: "shutdown" });
  });
});
