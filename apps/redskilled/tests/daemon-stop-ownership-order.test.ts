// A stop must surrender its lease before its socket. The reverse order creates
// a live, socketless lease holder that refuses every supervised successor.
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { createRedskilledLeaseStore, readRedskilledLeaseFile } from "../src/session-lease.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("redskilled stop ownership order", () => {
  it("finishes after closing an active client connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-stop-connected-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const daemon = await startRedskilledDaemon({ paths });
    const client = connect(paths.socketPath);
    await once(client, "connect");

    const stopped = daemon.stop().then(() => "stopped");
    const outcome = await Promise.race([
      stopped,
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ]);

    client.destroy();
    expect(outcome).toBe("stopped");
  });

  it("keeps the socket bound until the lease is released", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-stop-order-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const leases = createRedskilledLeaseStore(paths.leasePath, {
      sessionKeyHash: paths.sessionKeyHash,
      machineIdHash: paths.machineIdHash,
      socketPath: paths.socketPath,
    });
    let releaseLease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    let markReleaseStarted!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      markReleaseStarted = resolve;
    });
    const daemon = await startRedskilledDaemon({
      paths,
      leaseStore: {
        ...leases,
        async release(owner) {
          markReleaseStarted();
          await releaseGate;
          return await leases.release(owner);
        },
      },
    });
    running.push(daemon);

    const stopping = daemon.stop();
    await releaseStarted;
    const socketStayedBound = await socketAnswers(paths.socketPath);
    const leaseStayedHeld = await readRedskilledLeaseFile(paths.leasePath);
    releaseLease();
    await stopping;

    expect(socketStayedBound).toBe(true);
    expect(leaseStayedHeld).toBeDefined();
    expect(await socketAnswers(paths.socketPath)).toBe(false);
    expect(await readRedskilledLeaseFile(paths.leasePath)).toBeUndefined();
  });
});
