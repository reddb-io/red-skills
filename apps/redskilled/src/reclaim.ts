/**
 * reclaim — clear the corpses out of a session runtime root.
 *
 * A daemon that crashes, or a harness that pinned its own session key, leaves a
 * runtime directory behind: a socket nothing listens on, a lease naming a pid
 * that died, an event lane nobody will rehydrate. The lease is the singleton's
 * own arbitration record, so a directory full of dead ones is not merely untidy
 * — it is noise inside the exact surface arbitration reads from, and it reads to
 * a human counting sockets as one-daemon-per-something, which is the failure
 * ADR 0130 exists to prevent. An artifact that imitates a design failure costs
 * more than one that is simply messy.
 *
 * **The lease decides, not the directory.** A dead pid in a lease is proof the
 * holder is gone; nothing else on disk proves anything. So a directory whose
 * lease names a live pid is kept whatever else it contains, and a directory with
 * no lease is only a corpse once it has aged past `graceMs` — a daemon that is
 * mid-spawn has made its directory but not yet won its lease, and reclaiming
 * that one would race a healthy start.
 *
 * **The runtime root is shared, so foreignness is judged by name.** `rsp`'s
 * resident sockets live under the same `red-skills/` parent (one hashed
 * directory per scope), and a sweep that deleted by location rather than by
 * content would take another tool's live socket with it. Only files named
 * `redskilled.*` are this module's business; a directory holding anything else
 * is reported `foreign` and left alone.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isPidAlive as defaultIsPidAlive, runtimeSocketDir } from "@reddb-io/shared/resident-core.js";
import { REDSKILLED_SOCKET_FILE } from "./paths.js";
import { readRedskilledLeaseFile } from "./session-lease.js";
import { sendRedskilledRequest } from "./protocol.js";

/** A directory with no lease is only a corpse once it is this old. */
export const REDSKILLED_RECLAIM_GRACE_MS = 5 * 60_000;

/** File name prefix that marks a runtime directory as this daemon's. */
const REDSKILLED_FILE_PREFIX = "redskilled.";

/** What the sweep decided about one directory. */
export type RedskilledReclaimVerdict = "reclaimed" | "live" | "young" | "foreign" | "failed";

export interface RedskilledReclaimEntry {
  readonly dir: string;
  readonly verdict: RedskilledReclaimVerdict;
  /** Why, in operator words — the report is the whole point of reclaiming. */
  readonly reason: string;
  /** The file names that went with the directory, so the report says what was lost. */
  readonly removed: readonly string[];
}

export interface RedskilledReclaimReport {
  readonly roots: readonly string[];
  readonly scanned: number;
  readonly reclaimed: number;
  readonly dryRun: boolean;
  readonly entries: readonly RedskilledReclaimEntry[];
}

export interface RedskilledReclaimOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly uid?: number | string;
  /** Directories to sweep; derived from the environment when absent. */
  readonly roots?: readonly string[];
  readonly graceMs?: number;
  /** Report what would go, remove nothing. */
  readonly dryRun?: boolean;
  readonly now?: () => number;
  readonly isPidAlive?: (pid: number) => boolean | Promise<boolean>;
  /** Whether a socket answers; only ever asked of a directory with no lease. */
  readonly answers?: (socketPath: string) => Promise<boolean>;
}

/**
 * The parent directories session runtime dirs are minted under.
 *
 * Derived by asking {@link runtimeSocketDir} rather than by rebuilding its
 * layout, so the sweep cannot drift from the minting. Both candidates are
 * returned — the `XDG_RUNTIME_DIR` one and the `tmpdir()` fallback — because a
 * host that lost or gained XDG between runs has litter in both.
 */
export function redskilledRuntimeRoots(options: RedskilledReclaimOptions = {}): readonly string[] {
  const env = options.env ?? process.env;
  const probe = (candidate: NodeJS.ProcessEnv): string =>
    dirname(runtimeSocketDir({
      key: "redskilled:reclaim-probe",
      socketFileName: REDSKILLED_SOCKET_FILE,
      env: candidate,
      ...(options.uid === undefined ? {} : { uid: options.uid }),
    }));

  const { XDG_RUNTIME_DIR: _xdg, ...withoutXdg } = env;
  const roots = [probe(env), probe(withoutXdg)];
  return [...new Set(roots)];
}

/**
 * Sweep every runtime root and remove the directories whose owner is gone.
 *
 * Never throws on a directory it cannot read: an unreadable entry is reported
 * `failed` and the sweep continues, because one bad permission must not leave
 * the other thousand corpses in place.
 */
export async function reclaimRedskilledRuntimeDirs(
  options: RedskilledReclaimOptions = {},
): Promise<RedskilledReclaimReport> {
  const roots = options.roots ?? redskilledRuntimeRoots(options);
  const graceMs = options.graceMs ?? REDSKILLED_RECLAIM_GRACE_MS;
  const now = options.now ?? Date.now;
  const pidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const answers = options.answers ?? socketAnswers;
  const dryRun = options.dryRun === true;

  const entries: RedskilledReclaimEntry[] = [];
  for (const root of roots) {
    let children: string[];
    try {
      children = (await readdir(root, { withFileTypes: true }))
        .filter((child) => child.isDirectory())
        .map((child) => child.name);
    } catch {
      // A root that does not exist is a host that never littered, not an error.
      continue;
    }
    for (const child of children.sort()) {
      entries.push(await judge(join(root, child), { graceMs, now, pidAlive, answers, dryRun }));
    }
  }

  return {
    roots,
    scanned: entries.length,
    reclaimed: entries.filter((entry) => entry.verdict === "reclaimed").length,
    dryRun,
    entries,
  };
}

interface JudgeDeps {
  readonly graceMs: number;
  readonly now: () => number;
  readonly pidAlive: (pid: number) => boolean | Promise<boolean>;
  readonly answers: (socketPath: string) => Promise<boolean>;
  readonly dryRun: boolean;
}

async function judge(dir: string, deps: JudgeDeps): Promise<RedskilledReclaimEntry> {
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch (error) {
    return { dir, verdict: "failed", reason: describe(error), removed: [] };
  }

  const ours = names.filter((name) => name.startsWith(REDSKILLED_FILE_PREFIX));
  if (names.length > 0 && ours.length === 0) {
    return { dir, verdict: "foreign", reason: "holds no redskilled files", removed: [] };
  }

  const lease = await readLease(join(dir, "redskilled.lease.toon"));
  if (lease !== undefined) {
    if (await deps.pidAlive(lease.pid)) {
      return { dir, verdict: "live", reason: `lease pid ${lease.pid} is alive`, removed: [] };
    }
    return await reclaim(dir, names, `lease pid ${lease.pid} is dead`, deps);
  }

  // No lease. A socket that still answers outranks the missing record — the
  // holder is demonstrably there, whatever the directory says about it.
  if (names.includes(REDSKILLED_SOCKET_FILE) && await deps.answers(join(dir, REDSKILLED_SOCKET_FILE))) {
    return { dir, verdict: "live", reason: "socket answers with no lease", removed: [] };
  }

  const age = await ageMs(dir, deps.now);
  if (age !== undefined && age < deps.graceMs) {
    return { dir, verdict: "young", reason: `no lease, modified ${Math.round(age / 1000)}s ago`, removed: [] };
  }
  return await reclaim(dir, names, names.length === 0 ? "empty and stale" : "no lease and stale", deps);
}

async function reclaim(
  dir: string,
  names: readonly string[],
  reason: string,
  deps: JudgeDeps,
): Promise<RedskilledReclaimEntry> {
  if (deps.dryRun) return { dir, verdict: "reclaimed", reason: `${reason} (dry run)`, removed: names };
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    return { dir, verdict: "failed", reason: describe(error), removed: [] };
  }
  return { dir, verdict: "reclaimed", reason, removed: names };
}

async function readLease(leasePath: string) {
  try {
    return await readRedskilledLeaseFile(leasePath);
  } catch {
    // Bytes nobody can interpret name no owner, so they protect nothing.
    return undefined;
  }
}

async function ageMs(dir: string, now: () => number): Promise<number | undefined> {
  try {
    return Math.max(0, now() - (await stat(dir)).mtimeMs);
  } catch {
    return undefined;
  }
}

async function socketAnswers(socketPath: string): Promise<boolean> {
  try {
    const response = await sendRedskilledRequest(
      { socketPath, timeoutMs: 250 },
      { id: `redskilled-reclaim-${process.pid}`, op: "ping" },
    );
    return response.ok;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
