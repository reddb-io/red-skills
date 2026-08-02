/**
 * watch — the notification half, and the only long-lived process this plugin has.
 *
 * herdr's startup hook fires once per enabled plugin after the session is
 * restored, which is exactly the wrong shape for a poller: the hook must return,
 * and the loop must not. So `--detach` re-executes this command as a detached
 * child and returns immediately, and the child holds a **single-instance lock**
 * — a herdr restart, a second session, and a hand-run `watch` must never become
 * three processes racing to tell an operator the same thing three times.
 *
 * The loop reads and never writes. It cannot start the daemon, and it stays
 * quiet while one is absent beyond the single "no host answered" it opens with.
 */
import { decode, encode } from "@reddb-io/toon";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedskilledClient, readRedskilledSnapshot } from "../redskilled/client.mjs";
import { isHostEvent, readEventLane } from "../redskilled/event-lane.mjs";
import { resolveRedskilledPaths } from "../redskilled/paths.mjs";
import { stateDir } from "../config.mjs";
import { notify } from "../herdr.mjs";
import { detectSignals, snapshotState, throttle } from "../watch/signals.mjs";

const LOCK_FILE = "watch.lock";
const STATE_FILE = "watch-state.toon";

/**
 * The file `--detach` re-executes, which is whichever entry is RUNNING.
 *
 * `process.argv[1]` answers that in both layouts this plugin has: the checkout's
 * `bin/red-skills-herdr.mjs`, and the single-file bundle an install materializes
 * over it (issue #3060). Deriving it from this module's own URL was right for
 * only the first — bundled, this module IS the entry, and `../../bin/…` resolves
 * to a path outside the plugin root, so the detached child never started.
 */
export function watcherEntry(argv = process.argv) {
  const running = argv[1];
  if (typeof running === "string" && running.endsWith(".mjs") && existsSync(running)) return running;
  return fileURLToPath(new URL("../../bin/red-skills-herdr.mjs", import.meta.url));
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/**
 * Take the single-instance lock, or report who holds it.
 *
 * A pid alone is not an identity — the OS reuses them — so the lock carries the
 * instant it was taken too, and a lock whose pid is dead is reaped rather than
 * treated as an opening that must never be used.
 */
export async function acquireWatchLock(dir) {
  const path = join(dir, LOCK_FILE);
  await mkdir(dir, { recursive: true });
  try {
    const held = decode(await readFile(path, "utf8"));
    if (alive(held.pid)) return { acquired: false, held, path };
    await rm(path, { force: true });
  } catch {
    // No lock, or a lock this process cannot read: either way it holds nobody.
  }
  const record = { pid: process.pid, taken_at: new Date().toISOString() };
  await writeFile(path, encode(record));
  return { acquired: true, held: record, path };
}

async function readState(dir) {
  try {
    return decode(await readFile(join(dir, STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

async function writeState(dir, state) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, STATE_FILE), encode(state));
}

/** One poll: read, compare, emit. Returns the signals it sent. */
export async function watchOnce({ config, socket, client, dir, now = new Date().toISOString() }) {
  const stored = (await readState(dir)) ?? { previous: null, sentAt: {} };
  const snapshot = await readRedskilledSnapshot(client);
  const lane = await readEventLane(socket.eventLanePath, { limit: 200 }).catch(() => ({ records: [] }));
  const events = (lane.records ?? []).filter(isHostEvent);

  const current = snapshotState(snapshot, { events });
  const detected = detectSignals({
    previous: stored.previous,
    current,
    snapshot,
    events,
    config,
    now,
  });
  const { signals, sentAt } = throttle(detected, stored.sentAt ?? {}, {
    renotifyMs: config.notifications.renotifyMs,
    now,
  });

  for (const signal of signals) {
    await notify(signal.title, {
      body: signal.body,
      position: config.notifications.position,
      sound: signal.sound ?? config.notifications.sound,
    });
  }

  await writeState(dir, { previous: current, sentAt, updated_at: now });
  return signals;
}

export async function runWatch({ config, flags = {} }) {
  const dir = stateDir();

  if (flags.detach) {
    // The hook must return; the loop must not. Re-exec detached, and hand the
    // child a stdio that cannot keep herdr's own pipes open.
    const child = spawn(process.execPath, [watcherEntry(), "watch"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    process.stdout.write(`red-skills-herdr: watcher started (pid ${child.pid})\n`);
    return 0;
  }

  if (config.notifications.enabled === false) {
    process.stdout.write("red-skills-herdr: notifications are disabled in config; watcher exiting\n");
    return 0;
  }

  const socket = resolveRedskilledPaths({ socketPath: flags.socket ?? config.socketPath });
  const client = createRedskilledClient({ socketPath: socket.socketPath, timeoutMs: config.timeoutMs });

  if (flags.once) {
    const signals = await watchOnce({ config, socket, client, dir });
    process.stdout.write(`red-skills-herdr: ${signals.length} signal(s)\n${signals.map((s) => `  ${s.kind} ${s.title}\n`).join("")}`);
    return 0;
  }

  const lock = await acquireWatchLock(dir);
  if (!lock.acquired) {
    process.stdout.write(`red-skills-herdr: a watcher is already running (pid ${lock.held.pid}); this one is exiting\n`);
    return 0;
  }

  let stopping = false;
  const release = async () => {
    if (stopping) return;
    stopping = true;
    await rm(lock.path, { force: true }).catch(() => {});
  };
  process.on("SIGINT", async () => {
    await release();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await release();
    process.exit(0);
  });

  const interval = Math.max(2_000, config.notifications.pollMs);
  while (!stopping) {
    if (!herdrStillThere()) {
      process.stdout.write("red-skills-herdr: herdr is gone; the watcher has nothing to notify and is exiting\n");
      break;
    }
    try {
      await watchOnce({ config, socket, client, dir });
    } catch (error) {
      process.stderr.write(`red-skills-herdr: watch tick failed: ${error?.message ?? error}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  await release();
  return 0;
}

/**
 * True while the herdr that started this watcher is still up.
 *
 * The docs are explicit that "startup hooks are one-shot initialization
 * commands, not supervised daemons", so nothing on herdr's side will ever stop
 * this process. A poller that outlived the terminal it belongs to would keep
 * reading a socket forever to raise notifications no one can see — so it bounds
 * its own life by the one thing it exists to speak to.
 *
 * A hand-run watcher (no `HERDR_SOCKET_PATH`) is not bounded this way: an
 * operator who started it in a terminal owns when it stops.
 */
function herdrStillThere() {
  const socketPath = process.env.HERDR_SOCKET_PATH;
  if (!socketPath) return true;
  return existsSync(socketPath);
}
