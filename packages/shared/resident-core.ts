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
import { mkdir, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
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
  MAX_WIRE_FRAME_BYTES,
  WireFrameOverflowError,
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
    if (!framed) {
      // No delimiter to resync on past the ceiling: refuse the connection
      // instead of holding its bytes for as long as the peer stays quiet.
      if (buffer.length > MAX_WIRE_FRAME_BYTES) socket.destroy(new WireFrameOverflowError(buffer.length));
      return;
    }
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
 *
 * **The raw primitive: it attributes nothing and reaps nothing.** A caller that
 * can be blocked forever by a lock its owner never released wants
 * {@link acquireSpawnLock} instead; this stays for the wake-marker case, where
 * the file is a deliberate once-per-window token rather than a held lock.
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

/**
 * How long a spawn lock is believed before the next spawner reaps it.
 *
 * Six times the ready window a client gives a booting daemon, so a spawn that is
 * merely slow is never robbed of its lock, and one whose owner vanished is not
 * believed for an afternoon (#3123).
 */
export const DEFAULT_SPAWN_LOCK_MAX_AGE_MS = 60_000;

/** Who took a spawn lock and when — read back off the lock file itself. */
export interface SpawnLockHolder {
  readonly pid: number;
  readonly takenAt: string;
}

/** One lock this acquisition refused to obey, and the reason it did not. */
export interface SpawnLockReaping {
  readonly lockPath: string;
  /**
   * `holder-dead` — the pid on the lock is gone.
   * `aged-out` — a live holder has held it past `maxAgeMs`.
   * `unattributed` — the lock names nobody, and is older than `maxAgeMs`.
   */
  readonly reason: "holder-dead" | "aged-out" | "unattributed";
  readonly holder: SpawnLockHolder | null;
  readonly ageMs: number;
}

export interface SpawnLockTaken {
  readonly acquired: true;
  readonly lockPath: string;
  readonly handle: FileHandle;
  /** The stale locks cleared on the way in; empty on an uncontended take. */
  readonly reaped: readonly SpawnLockReaping[];
}

export interface SpawnLockHeld {
  readonly acquired: false;
  readonly lockPath: string;
  /** Null when the lock names nobody — the shape an older bundle's lock has. */
  readonly holder: SpawnLockHolder | null;
  /** Null when the lock's age could not be established at all. */
  readonly ageMs: number | null;
}

export type SpawnLockOutcome = SpawnLockTaken | SpawnLockHeld;

export interface SpawnLockOptions {
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly pid?: number;
  readonly isPidAlive?: (pid: number) => boolean;
  /** Called for every lock reaped, so the reaping is never silent. */
  readonly onReap?: (reaping: SpawnLockReaping) => void;
}

/** The lock file's one line. Deliberately not TOON: an operator `cat`s this. */
const SPAWN_LOCK_MAGIC = "resident-spawn-lock v1";

/** How many times an acquisition will reap and retry before reporting held. */
const SPAWN_LOCK_REAP_ATTEMPTS = 3;

/**
 * Take the spawn lock, saying who took it, and reap one nobody released.
 *
 * **A lock that names no owner and no instant is a lock nothing can decide is
 * stale**, which is how a zero-byte file six hours old came to refuse every
 * auto-spawn on a healthy machine (#3123). So the record carries its pid and its
 * instant, and this acquisition reaps three kinds of lock rather than obeying
 * them: one whose holder is gone, one a live holder has held past `maxAgeMs`,
 * and one from an older bundle that says nothing and is older than `maxAgeMs`.
 *
 * A reap is never silent — `onReap` is handed every one — because a mechanism
 * that quietly deletes another process's lock must leave a trail when the guess
 * was wrong. Losing the race is still the ordinary outcome and still not a
 * failure: the caller waits for the winner, and now has a holder to name if the
 * winner never appears.
 */
export async function acquireSpawnLock(
  lockPath: string,
  options: SpawnLockOptions = {},
): Promise<SpawnLockOutcome> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_SPAWN_LOCK_MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;
  const alive = options.isPidAlive ?? isPidAlive;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  const reaped: SpawnLockReaping[] = [];
  for (let attempt = 0; ; attempt += 1) {
    const handle = await tryAcquireExclusiveLock(lockPath);
    if (handle) {
      // Written after the exclusive create, which is why a lock caught mid-write
      // reads as unattributed: that window is milliseconds wide, and the age
      // bound is what keeps a reader from mistaking it for an orphan.
      await handle
        .writeFile(`${SPAWN_LOCK_MAGIC} pid=${pid} taken=${new Date(now()).toISOString()}\n`)
        .catch(() => undefined);
      return { acquired: true, lockPath, handle, reaped };
    }

    const holder = await readSpawnLockHolder(lockPath);
    const ageMs = await spawnLockAgeMs(lockPath, holder, now());
    if (attempt >= SPAWN_LOCK_REAP_ATTEMPTS || ageMs == null) {
      return { acquired: false, lockPath, holder, ageMs };
    }
    const reason = spawnLockReapReason(holder, ageMs, maxAgeMs, alive);
    if (reason == null) return { acquired: false, lockPath, holder, ageMs };

    const reaping: SpawnLockReaping = { lockPath, reason, holder, ageMs };
    await rm(lockPath, { force: true });
    reaped.push(reaping);
    options.onReap?.(reaping);
  }
}

/** Give the lock back: close the handle, then remove the file. */
export async function releaseSpawnLock(taken: SpawnLockTaken): Promise<void> {
  await taken.handle.close().catch(() => undefined);
  await rm(taken.lockPath, { force: true });
}

/** Why this lock may be reaped, or `null` when it must still be obeyed. PURE. */
function spawnLockReapReason(
  holder: SpawnLockHolder | null,
  ageMs: number,
  maxAgeMs: number,
  alive: (pid: number) => boolean,
): SpawnLockReaping["reason"] | null {
  if (holder == null) return ageMs > maxAgeMs ? "unattributed" : null;
  if (!alive(holder.pid)) return "holder-dead";
  return ageMs > maxAgeMs ? "aged-out" : null;
}

/**
 * The sentence a refused spawn owes its operator.
 *
 * Named here rather than at each caller because every caller owes the same three
 * facts — which lock, whose it is, how old — and "the daemon did not start" is
 * exactly the sentence this replaces: it describes a spawn that was never
 * attempted, and sends an operator to inspect a daemon that is perfectly healthy.
 */
export function describeSpawnLockHolder(held: SpawnLockHeld): string {
  const age = held.ageMs == null ? "of unknown age" : `taken ${Math.round(held.ageMs / 1_000)}s ago`;
  const who = held.holder == null
    ? "an owner it does not name"
    : `pid ${held.holder.pid} (at ${held.holder.takenAt})`;
  return (
    `no spawn was attempted: the spawn lock ${JSON.stringify(held.lockPath)} is held by ${who}, ${age}. ` +
    `If that process is gone, remove the file to clear it`
  );
}

/** Read the holder a lock names; `null` when it names nobody or cannot be read. */
async function readSpawnLockHolder(lockPath: string): Promise<SpawnLockHolder | null> {
  try {
    return parseSpawnLockHolder(await readFile(lockPath, "utf8"));
  } catch {
    return null;
  }
}

/** Parse the lock's one line. PURE. Anything else reads as unattributed. */
export function parseSpawnLockHolder(raw: string): SpawnLockHolder | null {
  const line = raw.split("\n", 1)[0]?.trim() ?? "";
  if (!line.startsWith(SPAWN_LOCK_MAGIC)) return null;
  const pid = Number(/\bpid=(\d+)\b/.exec(line)?.[1] ?? "");
  const takenAt = /\btaken=(\S+)/.exec(line)?.[1] ?? "";
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(Date.parse(takenAt))) return null;
  return { pid, takenAt };
}

/**
 * How old this lock is: by its own stated instant, else by its mtime.
 *
 * The mtime fallback is what gives an unattributed lock an age at all — the
 * whole reason the six-hour zero-byte file could not be judged. A negative age
 * (a clock that moved backwards) is clamped to zero rather than reaped: a lock
 * from the future is a machine problem, not an orphan.
 */
async function spawnLockAgeMs(
  lockPath: string,
  holder: SpawnLockHolder | null,
  nowMs: number,
): Promise<number | null> {
  const stated = holder == null ? Number.NaN : Date.parse(holder.takenAt);
  if (Number.isFinite(stated)) return Math.max(0, nowMs - stated);
  try {
    return Math.max(0, nowMs - (await stat(lockPath)).mtimeMs);
  } catch {
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
 * The POSIX temp root every Unix has, used only when `tmpdir()` will not fit.
 *
 * Not a preference — a last resort. `TMPDIR` is the operator's answer and is
 * honoured first; this exists because a relocated one can be long enough that no
 * socket under it fits `sun_path`, and a shorter root that binds beats a
 * respectful one that cannot.
 */
export const FALLBACK_TMP_ROOT = "/tmp";

/**
 * The runtime directory for a scope's socket, preferring `XDG_RUNTIME_DIR`.
 *
 * Each candidate is used only when the resulting socket path still fits
 * `sun_path`, because a path the kernel refuses to bind is not an option, it is
 * an outage — and one that surfaces as `ENAMETOOLONG` from `bind`, which reads
 * like anything but a path too long by four bytes. `XDG_RUNTIME_DIR` first (the
 * OS's own per-user answer), then `tmpdir()` for a host that has no session to
 * have made one, then `/tmp` for the host whose `TMPDIR` is itself too long —
 * WSL2 and the distros that relocate it are where that last case lives.
 */
export function runtimeSocketDir(options: RuntimeSocketDirOptions): string {
  const env = options.env ?? process.env;
  const hash = createHash("sha256").update(options.key).digest("hex").slice(0, 20);
  const fits = (dir: string): boolean =>
    join(dir, options.socketFileName).length < UNIX_SOCKET_PATH_LIMIT;
  const xdg = env.XDG_RUNTIME_DIR;
  if (xdg) {
    const candidate = join(xdg, "red-skills", hash);
    if (fits(candidate)) return candidate;
  }
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : "nouid");
  const leaf = join(`red-skills-${uid}`, hash);
  const candidate = join(tmpdir(), leaf);
  if (fits(candidate) || process.platform === "win32") return candidate;
  // Windows is excluded above rather than falling through: it has no `/tmp`, and
  // its named pipes are not bound by `sun_path` in the first place.
  return join(FALLBACK_TMP_ROOT, leaf);
}
