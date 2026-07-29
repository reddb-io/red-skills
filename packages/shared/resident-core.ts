/**
 * resident-core — the primitives every resident-style daemon shares.
 *
 * ADR 0126 made the rsp resident a core behind a unix socket with every surface
 * a peer client of it. ADR 0130 adds a second daemon, `redskilled`, scoped to a
 * user session rather than a repository. Both need the same four mechanics:
 * a newline-framed request over a unix socket, an exclusive spawn lock, liveness
 * of a recorded pid, and a runtime socket directory short enough for the
 * kernel's `sun_path` limit.
 *
 * Those mechanics live HERE so the second daemon consumes the infrastructure
 * rather than a copy of it — a copy is where the two would silently disagree
 * about what "the socket is dead" means. Everything above them (what a request
 * says, what the daemon owns) stays with each daemon's own protocol module.
 *
 * Pure of process globals where it can be: the socket-dir builder takes an
 * explicit `env` and `uid`, so it is testable without touching the host.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The kernel's `sockaddr_un.sun_path` budget; a longer path cannot be bound. */
export const UNIX_SOCKET_PATH_LIMIT = 108;

export interface LineSocketOptions {
  socketPath: string;
  timeoutMs?: number;
}

/**
 * Send one newline-framed JSON request and resolve the one response line.
 *
 * `label` names the peer in the timeout / early-close errors, so a caller's
 * diagnostics keep saying which daemon went quiet.
 */
export async function sendLineRequest<TRequest, TResponse>(
  opts: LineSocketOptions,
  request: TRequest,
  label = "resident server",
): Promise<TResponse> {
  const timeoutMs = opts.timeoutMs ?? 1_000;
  return await new Promise<TResponse>((resolve, reject) => {
    const socket = createConnection(opts.socketPath);
    let settled = false;
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`${label} timed out`)));
      socket.destroy();
    }, timeoutMs);

    function finish(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn();
    }

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      finish(() => {
        try {
          resolve(JSON.parse(line) as TResponse);
        } catch (err) {
          reject(err);
        }
      });
      socket.end();
    });
    socket.on("error", (err) => finish(() => reject(err)));
    socket.on("close", () => {
      if (!settled) finish(() => reject(new Error(`${label} closed without response`)));
    });
  });
}

/**
 * Take the spawn lock, or report that someone else holds it.
 *
 * `O_CREAT | O_EXCL` is the whole mechanism: exactly one concurrent caller gets
 * a handle, every other gets `null` and must wait for the winner rather than
 * start a second daemon.
 */
export async function tryAcquireExclusiveLock(lockPath: string): Promise<FileHandle | null> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return null;
  }
}

/** True when `pid` names a process this user can still signal. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM, then SIGKILL after `graceMs`. Returns once the pid is gone or killed. */
export async function terminatePid(pid: number, graceMs = 1_000): Promise<void> {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

export interface RuntimeSocketDirOptions {
  /** The scope the socket belongs to — a repo root for rsp, a session key for redskilled. */
  key: string;
  /** The socket file that will live in the returned directory; only its length matters. */
  socketFileName: string;
  env?: NodeJS.ProcessEnv;
  uid?: number | string;
}

/**
 * The runtime directory for a scope's socket, preferring `XDG_RUNTIME_DIR`.
 *
 * The `XDG_RUNTIME_DIR` candidate is used only when the resulting socket path
 * still fits `sun_path`; otherwise the shorter `tmpdir()` form wins, because a
 * path the kernel refuses to bind is not an option, it is an outage.
 */
export function runtimeSocketDir(options: RuntimeSocketDirOptions): string {
  const env = options.env ?? process.env;
  const hash = createHash("sha256").update(options.key).digest("hex").slice(0, 20);
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg) {
    const candidate = join(xdg, "red-skills", hash);
    if (join(candidate, options.socketFileName).length < UNIX_SOCKET_PATH_LIMIT) return candidate;
  }
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : "nouid");
  return join(tmpdir(), `red-skills-${uid}`, hash);
}
