/**
 * machine-scope — the arbiter that makes "one `redskilled` per machine" true.
 *
 * ADR 0130 Amendment 3 states the scope: one daemon per MACHINE, not per user
 * session. On Linux the ordinary derivation already lands there — `XDG_RUNTIME_DIR`
 * is per *user*, not per login, so every terminal of one operator resolves to the
 * same `/run/user/<uid>` and to the same socket. What the runtime dir cannot
 * answer is the case it was never scoped for: **two different OS users on one
 * machine**, whose runtime directories are different by construction and
 * `0700` against each other.
 *
 * The claim answers it, and answers it by refusing. A world-readable record in a
 * shared directory names the daemon that holds the machine; a second session that
 * finds a LIVE holder refuses to start rather than starting a second arbiter, and
 * says whose socket holds it. Refusal is the deliberate answer of the three
 * available:
 *
 * 1. **Serve the second user from the first user's daemon** — every Worker it
 *    births would run as the *first* user, reading and writing that user's
 *    checkouts under that user's credentials. That is a privilege boundary
 *    crossed silently, to save an operator a sentence of explanation.
 * 2. **Widen the socket to `0666`** — same crossing, with the kernel's help.
 * 3. **Refuse, and say so.** The budget stays the machine's, the Workers stay
 *    their owner's, and the second user gets a message naming what holds it.
 *
 * The claim is not the singleton on its own, and is not meant to be: the
 * exclusive bind still owns "who has the socket right now" and the session lease
 * still owns "who has this runtime dir across restarts". The claim owns the third
 * question — "does this machine already have a daemon somewhere else" — which
 * neither of the other two can see, because both are scoped inside a directory a
 * foreign session never looks at.
 *
 * **A corpse is not a holder, and an unremovable corpse is not an opening.** A
 * claim whose pid is dead is reaped and retried; a dead claim this process may not
 * unlink (a foreign uid's file under a sticky directory) ends in a stated refusal
 * naming the file, because inventing a second claim beside it is exactly the
 * second daemon this module exists to prevent.
 *
 * TOON on disk (repo mandate), written with the encoder and read with a
 * JSON-then-TOON sniff so a record written by an older bundle stays readable.
 */
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";

/** The claim file name, inside whichever directory the machine shares. */
export const REDSKILLED_MACHINE_CLAIM_FILE = "redskilled.machine.claim.toon";

/** Env var that pins the shared directory outright — an operator, or a test. */
export const REDSKILLED_MACHINE_DIR_ENV = "REDSKILLED_MACHINE_DIR";

/** How many reap-and-retry rounds before contention is reported instead of looped on. */
const MAX_CLAIM_ROUNDS = 8;

export interface RedskilledMachineOwner {
  readonly pid: number;
  readonly startTime: string;
  /** The OS user this daemon runs as — every Worker it births will run as it too. */
  readonly uid: number;
}

export interface RedskilledMachineClaim {
  readonly version: 1;
  /** Stated on the record so a reader never has to infer the scope from the path. */
  readonly scope: "machine";
  readonly pid: number;
  readonly start_time: string;
  readonly uid: number;
  readonly machine_id_hash: string;
  readonly session_key_hash: string;
  readonly socket_path: string;
  readonly acquired_at: string;
  readonly renewed_at: string;
}

/** Why a claim was refused — each one a different thing for an operator to do. */
export type RedskilledMachineRefusal =
  /** A live daemon holds the machine; join its socket or stop it. */
  | "held"
  /** A dead claim this process may not remove; remove it as its owner. */
  | "stale-claim-not-reapable"
  /** The claim changed hands under us repeatedly; nothing was assumed. */
  | "contended";

export type RedskilledMachineClaimResult =
  | { readonly claimed: true; readonly reaped: boolean; readonly claim: RedskilledMachineClaim }
  | {
    readonly claimed: false;
    readonly reason: RedskilledMachineRefusal;
    readonly claim?: RedskilledMachineClaim;
  };

/**
 * Raised when this machine already has a daemon, and it is not this process's.
 *
 * A distinct type, and a loud message: the operator's next action differs from
 * every other start failure — there is nothing to fix here, there is a daemon to
 * reach or to stop.
 */
export class RedskilledMachineHeldError extends Error {
  constructor(
    readonly claimPath: string,
    readonly reason: RedskilledMachineRefusal,
    readonly claim?: RedskilledMachineClaim,
  ) {
    super(describeRefusal(claimPath, reason, claim));
    this.name = "RedskilledMachineHeldError";
  }
}

export interface RedskilledMachineClaimLabels {
  readonly machineIdHash: string;
  readonly sessionKeyHash: string;
  readonly socketPath: string;
}

export interface RedskilledMachineClaimStoreOptions {
  readonly clock?: () => string;
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
}

export interface RedskilledMachineClaimStore {
  readonly claimPath: string;
  read(): Promise<RedskilledMachineClaim | undefined>;
  claim(owner: RedskilledMachineOwner): Promise<RedskilledMachineClaimResult>;
  release(owner: RedskilledMachineOwner): Promise<boolean>;
}

/** The scope a daemon believes it holds, as it reports it. */
export interface RedskilledScopeState {
  readonly kind: "machine";
  readonly claim_path: string;
  readonly owner_uid: number;
  readonly machine_id_hash: string;
  readonly session_key_hash: string;
  readonly socket_path: string;
}

let cachedMachineOwner: RedskilledMachineOwner | undefined;

/**
 * This process's machine identity — pid, start instant and uid.
 *
 * Memoised for the same reason the lease owner is: two calls that disagreed by a
 * millisecond would make a live daemon fail to recognise its own claim.
 */
export function currentMachineOwner(): RedskilledMachineOwner {
  cachedMachineOwner ??= {
    pid: process.pid,
    startTime: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
  };
  return cachedMachineOwner;
}

/**
 * The directory every session of one machine looks in, most explicit first.
 *
 * `REDSKILLED_MACHINE_DIR` wins so an operator (or a test) can state it outright.
 * Otherwise: `%PROGRAMDATA%` on Windows and the shared temp root elsewhere,
 * because those are the two places every OS user of one machine can *read* —
 * which is all a refusal needs. The directory is keyed by the host digest so two
 * machines sharing a network mount never share an arbiter.
 */
export function resolveMachineClaimDir(
  options: { readonly env?: NodeJS.ProcessEnv; readonly machineIdHash: string; readonly platform?: NodeJS.Platform } = {
    machineIdHash: "unknown",
  },
): string {
  const env = options.env ?? process.env;
  const pinned = env[REDSKILLED_MACHINE_DIR_ENV]?.trim();
  if (pinned) return pinned;
  const platform = options.platform ?? process.platform;
  const shared = platform === "win32" ? env.PROGRAMDATA?.trim() || tmpdir() : tmpdir();
  return join(shared, `redskilled-${options.machineIdHash}`);
}

/** The claim path for one machine. PURE. */
export function resolveMachineClaimPath(
  options: { readonly env?: NodeJS.ProcessEnv; readonly machineIdHash: string; readonly platform?: NodeJS.Platform },
): string {
  return join(resolveMachineClaimDir(options), REDSKILLED_MACHINE_CLAIM_FILE);
}

export function createRedskilledMachineClaimStore(
  claimPath: string,
  labels: RedskilledMachineClaimLabels,
  options: RedskilledMachineClaimStoreOptions = {},
): RedskilledMachineClaimStore {
  const clock = options.clock ?? (() => new Date().toISOString());
  const pidAlive = options.isPidAlive ?? isPidAlive;

  async function readClaim(): Promise<RedskilledMachineClaim | undefined> {
    let raw: string;
    try {
      raw = await readFile(claimPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // Unreadable because it is another user's and the mode says so: from here
      // that is indistinguishable from a holder, and both refuse.
      if (isPermissionError(error)) return undefined;
      throw error;
    }
    const parsed = parseSnapshot(raw);
    return isMachineClaim(parsed) ? parsed : undefined;
  }

  function mint(owner: RedskilledMachineOwner, now: string): RedskilledMachineClaim {
    return {
      version: 1,
      scope: "machine",
      pid: owner.pid,
      start_time: owner.startTime,
      uid: owner.uid,
      machine_id_hash: labels.machineIdHash,
      session_key_hash: labels.sessionKeyHash,
      socket_path: labels.socketPath,
      acquired_at: now,
      renewed_at: now,
    };
  }

  /** Remove a corpse, or report that it is not ours to remove. */
  async function reap(): Promise<boolean> {
    try {
      await rm(claimPath, { force: true });
      return true;
    } catch (error) {
      if (isPermissionError(error)) return false;
      throw error;
    }
  }

  return {
    claimPath,
    read: readClaim,

    async claim(owner) {
      // World-searchable and sticky: every OS user must be able to READ the
      // record, and only its owner may unlink it. The explicit chmod is what
      // makes that true under a umask; a directory another user already owns is
      // theirs to have set, so a refused chmod is not an error here.
      // Only the creator sets the mode. `mkdir` reports whether this call brought
      // the directory into being, and a directory that already existed is
      // somebody's configuration — re-chmodding it every start would let one
      // daemon quietly widen a directory another user had narrowed.
      const created = await mkdir(dirname(claimPath), { recursive: true, mode: 0o1777 });
      if (created != null) await chmod(dirname(claimPath), 0o1777).catch(() => undefined);

      let reaped = false;
      for (let round = 0; round < MAX_CLAIM_ROUNDS; round += 1) {
        const claim = mint(owner, clock());
        try {
          await writeFile(claimPath, serialize(claim), { encoding: "utf8", mode: 0o644, flag: "wx" });
          return { claimed: true, reaped, claim };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            if (isPermissionError(error)) return { claimed: false, reason: "stale-claim-not-reapable" };
            throw error;
          }
        }

        const existing = await readClaim();
        if (!existing) {
          // Bytes nobody can interpret are not an owner — but they are also not an
          // opening if they cannot be cleared.
          if (!(await reap())) return { claimed: false, reason: "stale-claim-not-reapable" };
          reaped = true;
          continue;
        }
        if (belongsTo(existing, owner, labels.socketPath)) return { claimed: true, reaped, claim: existing };
        if (await pidAlive(existing.pid)) return { claimed: false, reason: "held", claim: existing };
        if (!(await reap())) return { claimed: false, reason: "stale-claim-not-reapable", claim: existing };
        reaped = true;
      }
      return { claimed: false, reason: "contended" };
    },

    async release(owner) {
      const existing = await readClaim();
      if (!existing || !belongsTo(existing, owner, labels.socketPath)) return false;
      return await reap();
    },
  };
}

/** The scope a daemon reports, from the same values it claimed with. PURE. */
export function describeMachineScope(
  claimPath: string,
  labels: RedskilledMachineClaimLabels,
  owner: RedskilledMachineOwner,
): RedskilledScopeState {
  return {
    kind: "machine",
    claim_path: claimPath,
    owner_uid: owner.uid,
    machine_id_hash: labels.machineIdHash,
    session_key_hash: labels.sessionKeyHash,
    socket_path: labels.socketPath,
  };
}

/** True when `value` is a complete scope block — a client's fail-closed check. */
export function isRedskilledScopeState(value: unknown): value is RedskilledScopeState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.kind === "machine" &&
    typeof scope.claim_path === "string" &&
    typeof scope.owner_uid === "number" &&
    typeof scope.machine_id_hash === "string" &&
    typeof scope.session_key_hash === "string" &&
    typeof scope.socket_path === "string";
}

function describeRefusal(
  claimPath: string,
  reason: RedskilledMachineRefusal,
  claim?: RedskilledMachineClaim,
): string {
  const held = claim == null
    ? ""
    : ` — held by pid ${claim.pid} (uid ${claim.uid}) on socket ${JSON.stringify(claim.socket_path)}`;
  if (reason === "held") {
    return `this machine already has a redskilled daemon${held}; a second one would void the host budget, so none was started. ` +
      `Reach that daemon, or stop it before starting another.`;
  }
  if (reason === "stale-claim-not-reapable") {
    return `the redskilled machine claim ${JSON.stringify(claimPath)} is stale and cannot be removed by this user${held}; ` +
      `remove it as its owner, then start again. No second daemon was started.`;
  }
  return `the redskilled machine claim ${JSON.stringify(claimPath)} changed hands repeatedly; no daemon was started.`;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/**
 * Whether a claim is THIS daemon's — pid, start instant and socket, all three.
 *
 * The socket is part of the identity on purpose. Without it, one process holding
 * the claim for one socket would recognise itself while claiming a *second*
 * socket, and re-entering the claim would admit the very second daemon this
 * module refuses. A pid is not an identity on its own; a pid serving a different
 * socket is not the same daemon.
 */
function belongsTo(claim: RedskilledMachineClaim, owner: RedskilledMachineOwner, socketPath: string): boolean {
  return claim.pid === owner.pid && claim.start_time === owner.startTime && claim.socket_path === socketPath;
}

function serialize(claim: RedskilledMachineClaim): string {
  return `${encode(claim as unknown as JsonValue)}\n`;
}

function parseSnapshot(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    try {
      return decode(body);
    } catch {
      return null;
    }
  }
}

function isMachineClaim(value: unknown): value is RedskilledMachineClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  if (claim.version !== 1 || claim.scope !== "machine") return false;
  if (!Number.isInteger(claim.pid) || (claim.pid as number) <= 0) return false;
  if (!Number.isInteger(claim.uid)) return false;
  for (
    const field of ["start_time", "machine_id_hash", "session_key_hash", "socket_path", "acquired_at", "renewed_at"] as const
  ) {
    if (typeof claim[field] !== "string" || claim[field].length === 0) return false;
  }
  return true;
}
