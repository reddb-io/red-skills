/**
 * resident-core — the primitives every resident-style daemon shares.
 *
 * ADR 0126 made the rsp resident a core behind a unix socket with every surface
 * a peer client of it. ADR 0130 adds a second daemon, `redskilled`, scoped to a
 * user session rather than a repository. Both need the same four mechanics:
 * a newline-framed request over a unix socket, an exclusive spawn lock, liveness
 * of a recorded pid, and a runtime socket directory short enough for the
 * kernel's `sun_path` limit. What travels on that socket — the framing and the
 * encoding, and the order the two ends may adopt them in — is `resident-wire`.
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
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  decodeWireFrame,
  encodeWireFrame,
  isUnintelligibleResponse,
  rememberJsonOnlyPeer,
  residentWireDialectFor,
  takeWireFrame,
  type ResidentWireDialect,
} from "./resident-wire.js";

/** The kernel's `sockaddr_un.sun_path` budget; a longer path cannot be bound. */
export const UNIX_SOCKET_PATH_LIMIT = 108;

export interface LineSocketOptions {
  socketPath: string;
  timeoutMs?: number;
  /**
   * Pin the encoding written to this peer instead of negotiating it.
   *
   * Only a test that is standing in for one side of a rollout should set this;
   * ordinary callers let `resident-wire` rule 3 choose and downgrade.
   */
  wire?: ResidentWireDialect;
}

/**
 * Send one framed request and resolve the one framed response.
 *
 * The request goes out in TOON and the response is read in whichever encoding it
 * arrives in — `resident-wire` states the full migration order. A peer that
 * proves it could not read TOON is remembered, and this call retries the same
 * request in JSON: a request the peer failed to PARSE is one it never executed,
 * so the retry cannot repeat a side effect.
 *
 * `label` names the peer in the timeout / early-close errors, so a caller's
 * diagnostics keep saying which daemon went quiet.
 */
export async function sendLineRequest<TRequest, TResponse>(
  opts: LineSocketOptions,
  request: TRequest,
  label = "resident server",
): Promise<TResponse> {
  const pinned = opts.wire;
  const dialect = pinned ?? residentWireDialectFor(opts.socketPath);
  const response = await sendFramedRequest<TRequest, TResponse>(opts, request, label, dialect);
  if (pinned || dialect === "json" || !isUnintelligibleResponse(request, response)) return response;
  rememberJsonOnlyPeer(opts.socketPath);
  return await sendFramedRequest<TRequest, TResponse>(opts, request, label, "json");
}

async function sendFramedRequest<TRequest, TResponse>(
  opts: LineSocketOptions,
  request: TRequest,
  label: string,
  dialect: ResidentWireDialect,
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
      socket.write(encodeWireFrame(request, dialect));
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const framed = takeWireFrame(buffer);
      if (!framed) return;
      buffer = framed.rest;
      finish(() => {
        try {
          resolve(decodeWireFrame(framed.frame) as TResponse);
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
 * Serve one connection: read one framed request, answer in the SAME encoding.
 *
 * Both daemons share this rather than each keeping a copy, because a copy is
 * where the two would silently disagree about what a frame is — the same reason
 * the socket mechanics live here. Answering in the caller's own dialect is
 * `resident-wire` rule 2: the daemon never guesses what its caller can read, it
 * holds the proof in the request it just parsed.
 *
 * `onFailure` is handed the frame's own dialect too, so a message that could not
 * be decoded is still answered in the encoding it plausibly came in.
 */
export function serveWireSocket<TRequest>(
  socket: Socket,
  handler: (request: TRequest, respond: (response: unknown) => void) => Promise<void>,
  onFailure: (err: unknown, request: TRequest | undefined, respond: (response: unknown) => void) => void,
): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => undefined);
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const framed = takeWireFrame(buffer);
    if (!framed) return;
    buffer = framed.rest;
    socket.pause();
    const respond = (response: unknown): void => {
      if (socket.destroyed || !socket.writable) return;
      try {
        socket.write(encodeWireFrame(response, framed.dialect));
      } catch {}
    };
    void (async () => {
      let request: TRequest | undefined;
      try {
        request = decodeWireFrame(framed.frame) as TRequest;
        await handler(request, respond);
      } catch (err) {
        onFailure(err, request, respond);
      } finally {
        socket.end();
      }
    })();
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
