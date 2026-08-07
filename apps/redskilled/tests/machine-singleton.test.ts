// One `redskilled` per machine (ADR 0130 Amendment 3). The failure mode guarded
// here is the one the host budget cannot survive: two daemons, each correct
// about a total that is not the machine's. A second user session — a different
// runtime directory, a different socket, plausibly a different OS user — must
// end in ONE daemon or in a stated refusal, never in a second arbiter.
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encode } from "@reddb-io/toon";
import { ensureRedskilledDaemon, readRedskilledHostState } from "../src/client.js";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  createRedskilledMachineClaimStore,
  currentMachineOwner,
  RedskilledMachineHeldError,
  REDSKILLED_MACHINE_CLAIM_FILE,
} from "../src/machine-scope.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function machineRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-machine-"));
  roots.push(root);
  return root;
}

/** A distinct user session on ONE machine: its own runtime dir, one shared claim. */
async function sessionOnMachine(machineDir: string, label: string): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), `redskilled-${label}-`));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}` },
    runtimeDir: root,
    machineClaimPath: join(machineDir, REDSKILLED_MACHINE_CLAIM_FILE),
  });
}

describe("redskilled machine scope", () => {
  it("derives one claim path for two sessions of the same machine", async () => {
    const env = { REDSKILLED_MACHINE_DIR: await machineRoot() };
    const first = resolveRedskilledPaths({ env: { ...env, XDG_RUNTIME_DIR: "/run/user/1000" }, host: "box" });
    const second = resolveRedskilledPaths({ env: { ...env, XDG_RUNTIME_DIR: "/run/user/1001" }, host: "box" });

    expect(first.runtimeDir).not.toBe(second.runtimeDir);
    expect(first.machineClaimPath).toBe(second.machineClaimPath);
  });

  it("refuses a second daemon on another session of the same machine", async () => {
    const machineDir = await machineRoot();
    const a = await sessionOnMachine(machineDir, "a");
    const b = await sessionOnMachine(machineDir, "b");

    const first = await startRedskilledDaemon({ paths: a });
    running.push(first);

    const refusal = startRedskilledDaemon({ paths: b });
    await expect(refusal).rejects.toBeInstanceOf(RedskilledMachineHeldError);
    // The refusal names the daemon that holds the machine, so an operator is not
    // left guessing which of two sessions won.
    await expect(refusal).rejects.toThrow(a.socketPath);

    expect(await socketAnswers(a.socketPath)).toBe(true);
    expect(await socketAnswers(b.socketPath)).toBe(false);
  });

  it("joins the live daemon when the same uid resolves another runtime socket", async () => {
    const machineDir = await machineRoot();
    const a = await sessionOnMachine(machineDir, "a");
    const b = await sessionOnMachine(machineDir, "b");

    const first = await startRedskilledDaemon({ paths: a });
    running.push(first);

    await expect(ensureRedskilledDaemon(b)).resolves.toBe("joined");
    await expect(readRedskilledHostState(b)).resolves.toMatchObject({
      pid: first.hostState().pid,
      scope: { socket_path: a.socketPath, owner_uid: currentMachineOwner().uid },
    });
    expect(await socketAnswers(b.socketPath)).toBe(false);
  });

  it("still refuses a live machine claim owned by another uid", async () => {
    const machineDir = await machineRoot();
    const paths = await sessionOnMachine(machineDir, "foreign");
    const store = createRedskilledMachineClaimStore(paths.machineClaimPath, {
      machineIdHash: paths.machineIdHash,
      sessionKeyHash: "foreign-session",
      socketPath: "/tmp/foreign/redskilled.sock",
    });
    await store.claim({
      pid: process.pid,
      startTime: "2026-08-07T00:00:00.000Z",
      uid: currentMachineOwner().uid + 1,
    });

    await expect(ensureRedskilledDaemon(paths)).rejects.toBeInstanceOf(RedskilledMachineHeldError);
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  });

  it("does not let a runtime directory full of dead leases admit a second daemon", async () => {
    const machineDir = await machineRoot();
    const a = await sessionOnMachine(machineDir, "a");
    const b = await sessionOnMachine(machineDir, "b");

    // Corpses of every kind a crash leaves: a dead session lease in each runtime
    // dir, and half-written claim debris beside the claim itself.
    await writeFile(a.leasePath, encode({ version: 1, pid: 999_999, start_time: "2020-01-01T00:00:00.000Z" }));
    await writeFile(b.leasePath, encode({ version: 1, pid: 999_998, start_time: "2020-01-01T00:00:00.000Z" }));
    await writeFile(`${join(machineDir, REDSKILLED_MACHINE_CLAIM_FILE)}.999999.tmp`, "debris");

    const first = await startRedskilledDaemon({ paths: a });
    running.push(first);

    await expect(startRedskilledDaemon({ paths: b })).rejects.toBeInstanceOf(RedskilledMachineHeldError);
  });

  it("hands the machine to the next daemon once the holder is gone", async () => {
    const machineDir = await machineRoot();
    const a = await sessionOnMachine(machineDir, "a");
    const b = await sessionOnMachine(machineDir, "b");

    const first = await startRedskilledDaemon({ paths: a });
    await first.stop();

    const second = await startRedskilledDaemon({ paths: b });
    running.push(second);
    expect(await socketAnswers(b.socketPath)).toBe(true);
  });

  it("reaps a claim whose holder died without releasing it", async () => {
    const machineDir = await machineRoot();
    const claimPath = join(machineDir, REDSKILLED_MACHINE_CLAIM_FILE);
    const store = createRedskilledMachineClaimStore(claimPath, {
      machineIdHash: "aaaaaaaaaaaa",
      sessionKeyHash: "bbbbbbbbbbbb",
      socketPath: "/tmp/dead.sock",
    }, { isPidAlive: () => false });

    const dead = await store.claim({ pid: 999_999, startTime: "2020-01-01T00:00:00.000Z", uid: currentMachineOwner().uid });
    expect(dead.claimed).toBe(true);

    const live = await store.claim(currentMachineOwner());
    expect(live).toMatchObject({ claimed: true, reaped: true });
  });

  it("refuses rather than reaping a stale claim it may not remove", async () => {
    const machineDir = await machineRoot();
    const claimPath = join(machineDir, REDSKILLED_MACHINE_CLAIM_FILE);
    const store = createRedskilledMachineClaimStore(claimPath, {
      machineIdHash: "aaaaaaaaaaaa",
      sessionKeyHash: "bbbbbbbbbbbb",
      socketPath: "/tmp/dead.sock",
    }, { isPidAlive: () => false });
    await store.claim({ pid: 999_999, startTime: "2020-01-01T00:00:00.000Z", uid: currentMachineOwner().uid });

    // What a foreign uid's corpse looks like from here: readable, dead, and not
    // ours to unlink. Refusing is the answer; a second daemon is not.
    await chmod(machineDir, 0o500);
    try {
      const refused = await store.claim(currentMachineOwner());
      expect(refused).toMatchObject({ claimed: false, reason: "stale-claim-not-reapable" });
    } finally {
      await chmod(machineDir, 0o700);
    }
  });

  it("reports the scope it believes it holds", async () => {
    const machineDir = await machineRoot();
    const paths = await sessionOnMachine(machineDir, "a");
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    const state = await readRedskilledHostState(paths);
    expect(state.scope).toMatchObject({
      kind: "machine",
      claim_path: paths.machineClaimPath,
      machine_id_hash: paths.machineIdHash,
      session_key_hash: paths.sessionKeyHash,
    });
    expect(state.scope?.owner_uid).toBe(currentMachineOwner().uid);

    // The claim on disk says the same thing the daemon says it does.
    const raw = await readFile(paths.machineClaimPath, "utf8");
    expect(raw).toContain(paths.socketPath);

    await sendRedskilledRequest({ socketPath: paths.socketPath }, { id: "shutdown-scope", op: "shutdown" });
  });
});
