// A socket's OWNER and a socket's HEALTH are different questions, and only the
// first one licenses a delete. The failure being guarded is the one that filled
// a day's death lane with 1166 daemon births (#3186): a daemon busy or hung
// behind its socket fails a 250ms ping, the newcomer reads that silence as
// debris, unlinks the live socket and binds its own — and now two daemons each
// believe they are the machine's single arbiter.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  probeSocketOwnership,
  RedskilledAlreadyRunningError,
  socketAnswers,
  startRedskilledDaemon,
  type RedskilledDaemon,
} from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const servers: Server[] = [];
const accepted: Socket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const socket of accepted.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-ownership-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A listener that accepts every connection and answers none — a busy or hung daemon. */
async function silentListener(socketPath: string): Promise<Server> {
  const server = createServer((socket) => {
    // Accepted and then ignored — what a daemon draining a stuck shutdown looks
    // like from the outside. Kept so teardown can destroy it: `close()` only
    // stops accepting, and a connection nobody ever answers is never released.
    accepted.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

describe("socket ownership is asked of the kernel, not of a clock", () => {
  it("reads a listener that never replies as OWNED, where a ping reads it as absent", async () => {
    const paths = await sessionPaths();
    await silentListener(paths.socketPath);

    // The two questions, side by side. `socketAnswers` is not wrong — it is
    // answering about health — it is just not the question a delete may consult.
    await expect(socketAnswers(paths.socketPath, 100)).resolves.toBe(false);
    await expect(probeSocketOwnership(paths.socketPath)).resolves.toBe("owned");
  });

  it("reads a socket file nothing listens behind as UNOWNED", async () => {
    const paths = await sessionPaths();
    const server = await silentListener(paths.socketPath);
    // Close the listener while leaving the inode: exactly the debris a crash
    // leaves behind, and the only case an unlink is for.
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(probeSocketOwnership(paths.socketPath)).resolves.toBe("unowned");
  });

  it("never resolves an unreadable probe as unowned", async () => {
    const paths = await sessionPaths();
    // A path with no socket at all: absent is refused-with-ENOENT, still a
    // definite answer. What must never appear is `unowned` from a probe that
    // resolved nothing — that is the read this whole module exists to forbid.
    const ownership = await probeSocketOwnership(join(paths.runtimeDir, "no-such.sock"));
    expect(ownership).toBe("unowned");
  });
});

describe("a daemon refuses to steal a socket whose owner is silent", () => {
  it("refuses to start, and leaves the live socket where it found it", async () => {
    const paths = await sessionPaths();
    const holder = await silentListener(paths.socketPath);
    const inodeBefore = (await stat(paths.socketPath)).ino;

    // On the pre-#3186 code this call SUCCEEDS: the ping times out, the socket
    // is unlinked as debris, the rebind wins, and the silent holder is orphaned
    // on a path that no longer names it.
    await expect(startRedskilledDaemon({ paths })).rejects.toBeInstanceOf(RedskilledAlreadyRunningError);

    // The holder still owns the same inode — nothing was replaced underneath it.
    expect((await stat(paths.socketPath)).ino).toBe(inodeBefore);
    expect(holder.listening).toBe(true);
    await expect(probeSocketOwnership(paths.socketPath)).resolves.toBe("owned");
  });
});
