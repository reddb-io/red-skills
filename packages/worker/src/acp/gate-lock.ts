/**
 * gate-lock — one declared Validation execution at a time per host (#4161).
 *
 * Two Workers running their gates simultaneously on one machine poisoned each
 * other: the second collapsed in 15s with six unrelated packages red at once —
 * contention's signature, not the branch's — and the Verdict read it as branch
 * fault. The gate is serialized behind a host-wide lock file instead: atomic
 * `wx` create with the holder's pid inside, a dead holder broken immediately,
 * and a bounded wait that PROCEEDS unlocked past its deadline — a wedged lock
 * must not park every Worker on the host, and an unlocked run risks a flake,
 * never corruption.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";

export interface HostGateLockOptions {
  /** The lock file every Worker on this host agrees on. */
  readonly lockPath?: string;
  /** How often a blocked Worker re-reads the lock. */
  readonly pollMs?: number;
  /** How long a blocked Worker waits before proceeding unlocked. */
  readonly deadlineMs?: number;
  /** Heartbeat: who holds the lock and how long this Worker has waited. */
  readonly onWait?: (holder: number | null, waitedMs: number) => void;
  /** Test seams. Production uses the real clock, timer, and process table. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pidAlive?: (pid: number) => boolean;
  readonly pid?: number;
}

export interface HostGateLock {
  /** True when the deadline passed and the gate runs WITHOUT the lock. */
  readonly unlocked: boolean;
  readonly waitedMs: number;
  release(): Promise<void>;
}

/** The lock every Worker of one user on one machine agrees on. */
export function hostGateLockPath(tmpRoot: string = tmpdir(), uid: string | number = defaultUid()): string {
  const segment = String(uid).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return join(tmpRoot, `red-skills-${segment}`, "gate.lock");
}

const DEFAULT_GATE_LOCK_POLL_MS = 2_000;
const DEFAULT_GATE_LOCK_DEADLINE_MS = 15 * 60_000;

export async function acquireHostGateLock(options: HostGateLockOptions = {}): Promise<HostGateLock> {
  const lockPath = options.lockPath ?? hostGateLockPath();
  const pollMs = options.pollMs ?? DEFAULT_GATE_LOCK_POLL_MS;
  const deadlineMs = options.deadlineMs ?? DEFAULT_GATE_LOCK_DEADLINE_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const alive = options.pidAlive ?? processAlive;
  const pid = options.pid ?? process.pid;
  await mkdir(dirname(lockPath), { recursive: true });
  const startedAt = now();
  for (;;) {
    try {
      await writeFile(lockPath, `${pid}\n`, { encoding: "utf8", flag: "wx" });
      return {
        unlocked: false,
        waitedMs: now() - startedAt,
        async release() {
          await rm(lockPath, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = await holderOf(lockPath);
    if (holder != null && !alive(holder)) {
      // A dead holder is a Worker that never reached its release; breaking the
      // lock immediately is the stale-claim sweep this file needs.
      await rm(lockPath, { force: true });
      continue;
    }
    const waitedMs = now() - startedAt;
    if (waitedMs >= deadlineMs) {
      return { unlocked: true, waitedMs, async release() {} };
    }
    options.onWait?.(holder, waitedMs);
    await sleep(pollMs);
  }
}

async function holderOf(lockPath: string): Promise<number | null> {
  const text = await readFile(lockPath, "utf8").catch(() => null);
  if (text == null) return null;
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function defaultUid(): string | number {
  return process.getuid?.() ?? userInfo().username;
}
