/**
 * The daemon this container supervises.
 *
 * **ADR 0150 §4: the daemon is the only thing that births a Worker, and a
 * client that finds no daemon fails closed rather than spawning one.** A
 * container has no init system to install a unit into, so the entrypoint IS the
 * supervisor: it execs `red-skills-redskilled serve` as its one long-lived
 * child, and everything else in the container is a client of that singleton.
 *
 * Nothing here is a second birth authority. The daemon's own launch path spawns
 * Workers; when no cgroup driver is reachable — the ordinary case inside an
 * unprivileged container — placement degrades to an unisolated native spawn and
 * SAYS so, which is the honest answer for a process whose isolation is already
 * the container around it.
 */

/** Start the daemon and hand back its handle. The caller owns its lifetime. */
export function startRedskilledDaemon({ spawn, argv, env, log }) {
  const child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], env });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk) => {
      const text = String(chunk).trimEnd();
      if (text !== "") log(`redskilled: ${text}`);
    });
  }
  let exited = null;
  // A daemon that could not be spawned at all is a daemon that exited: the
  // readiness wait reads one field and must not have to know the difference
  // between "died" and "never started".
  child.on("error", (error) => {
    log(`redskilled could not be started: ${error.message}`);
    exited ??= { code: null, signal: null, error };
  });
  child.on("close", (code, signal) => {
    exited = { code, signal };
  });
  return {
    child,
    exited: () => exited,
    stop(signal = "SIGTERM") {
      if (exited == null) child.kill(signal);
    },
  };
}

/**
 * DECLARED WAIT — subject: the daemon's ACP socket answering a session.
 * Deadline: {@link DAEMON_READY_TIMEOUT_MS}. Escalation: throw, so the
 * entrypoint stops the daemon and exits non-zero instead of polling a socket
 * that is never coming up.
 *
 * A boot is retried rather than probed once because the socket appears some
 * hundreds of milliseconds after `serve` starts, and the first client to arrive
 * legitimately loses that race.
 */
export const DAEMON_READY_TIMEOUT_MS = 120_000;

export async function awaitDaemonSession({
  open,
  sleep,
  now = () => Date.now(),
  timeoutMs = DAEMON_READY_TIMEOUT_MS,
  pollMs = 1_000,
  daemon,
  log,
}) {
  const deadline = now() + timeoutMs;
  let lastError;
  for (;;) {
    const dead = daemon?.exited?.();
    if (dead != null) {
      throw new Error(
        `redskilled serve exited with ${dead.error?.message ?? dead.code ?? dead.signal} before it served a session`,
      );
    }
    try {
      return await open();
    } catch (error) {
      lastError = error;
    }
    if (now() >= deadline) {
      throw new Error(
        `redskilled did not serve an ACP session within ${timeoutMs}ms: ${lastError?.message ?? "no reason given"}`,
      );
    }
    log?.(`waiting for the daemon's ACP socket (${lastError?.message ?? "not up yet"})`);
    await sleep(pollMs);
  }
}
