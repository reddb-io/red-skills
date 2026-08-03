/**
 * daemon-presence — "I could not reach it" is not "it is not there" (#3092).
 *
 * A client that finds no answer on the socket has learned ONE thing: it got no
 * answer. Three different worlds produce that silence, and they take three
 * different repairs:
 *
 * 1. **absent** — no socket, no lease, nothing holding the machine. The repair is
 *    to start one, and that is the only state where telling an operator to
 *    provision is true.
 * 2. **held-unresponsive** — a lease names a pid that is alive and holds this very
 *    socket, and it still did not answer a ping. There IS a daemon; the repair is
 *    to inspect or stop THAT process, never to install another.
 * 3. **answering** — it answered, and there is nothing to repair.
 *
 * Collapsing the first two is what #3092 was: a client whose redundant spawn was
 * refused (correctly — the singleton guard working) rendered that refusal as "the
 * daemon did not start", and then advised provisioning a daemon that had been
 * serving for five hours. **The healthy path and the broken path printed the same
 * sentence**, so the operator's next action was to install what was already
 * installed.
 *
 * `reason` and `repair` are whole sentences because this text is what an operator
 * reads when nothing happened, and the pid, the socket and the uptime are what
 * they act on.
 *
 * PURE: every input is passed in — the probe that reads the socket and the lease
 * lives in `client.ts`, so this module is testable without a host.
 */
import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";
import type { RedskilledLease } from "./session-lease.js";

/** The three states a silent socket can actually be in. */
export type RedskilledPresenceKind = "answering" | "held-unresponsive" | "absent";

/** The process a lease names, as an operator needs to read it. */
export interface RedskilledPresenceHolder {
  readonly pid: number;
  readonly socket_path: string;
  readonly acquired_at: string;
  readonly renewed_at: string;
  /** Wall-clock milliseconds since the lease was taken; `null` when undatable. */
  readonly uptime_ms: number | null;
}

export interface RedskilledPresence {
  readonly version: 1;
  readonly kind: RedskilledPresenceKind;
  readonly socket_path: string;
  /** The live lease holder, when there is one; `null` in every other state. */
  readonly holder: RedskilledPresenceHolder | null;
  /** What was observed, as a sentence. */
  readonly reason: string;
  /** What to do about it, as a sentence. */
  readonly repair: string;
}

export interface DescribeRedskilledPresenceInput {
  readonly socketPath: string;
  /** Whether a ping was answered on {@link socketPath}. */
  readonly answers: boolean;
  /** The lease record found on disk, when there was one. */
  readonly lease?: RedskilledLease | undefined;
  /** Whether the pid the lease names can still be signalled. */
  readonly holderAlive?: boolean;
  /** Now, for the uptime; defaults to the wall clock. */
  readonly now?: string;
}

/**
 * Classify one silence. PURE.
 *
 * A lease on ANOTHER socket does not make this socket held: it names a daemon
 * this client is not talking to, and reporting it as the holder of a path it
 * never bound would send the operator after the wrong process.
 */
export function describeRedskilledPresence(input: DescribeRedskilledPresenceInput): RedskilledPresence {
  const socketPath = input.socketPath;
  const holder = holderOf(input);
  if (input.answers) {
    return {
      version: 1,
      kind: "answering",
      socket_path: socketPath,
      holder,
      reason: `a redskilled daemon answered on ${JSON.stringify(socketPath)}`,
      repair: "nothing to repair",
    };
  }
  if (holder != null) {
    return {
      version: 1,
      kind: "held-unresponsive",
      socket_path: socketPath,
      holder,
      reason:
        `redskilled pid ${holder.pid} is alive and has held ${JSON.stringify(socketPath)} since ` +
        `${holder.acquired_at}${holder.uptime_ms == null ? "" : ` (up ${formatUptime(holder.uptime_ms)})`}, ` +
        `but it did not answer a ping — this is a daemon that could not be REACHED, not one that is missing.`,
      repair:
        `Do not provision: a daemon is already running. Inspect it (\`ps -p ${holder.pid}\`), or stop it with ` +
        `\`${canonicalInvocation("red-skills-redskilled", ["stop"])}\` and let the next client start a fresh one.`,
    };
  }
  return {
    version: 1,
    kind: "absent",
    socket_path: socketPath,
    holder: null,
    reason: `nothing answered on ${JSON.stringify(socketPath)} and no live process holds its lease`,
    repair:
      `Install and start one with \`${canonicalInvocation("red-skills-redskilled", ["provision"])}\` ` +
      `(or \`/red-setup\`), then retry.`,
  };
}

/** The repair-carrying half of a presence, for a surface that renders its own lead. PURE. */
export function redskilledPresenceAdvice(presence: RedskilledPresence): string {
  return `${presence.reason} ${presence.repair}`;
}

function holderOf(input: DescribeRedskilledPresenceInput): RedskilledPresenceHolder | null {
  const lease = input.lease;
  if (lease == null || input.holderAlive !== true) return null;
  if (lease.socket_path !== input.socketPath) return null;
  return {
    pid: lease.pid,
    socket_path: lease.socket_path,
    acquired_at: lease.acquired_at,
    renewed_at: lease.renewed_at,
    uptime_ms: elapsedMs(lease.acquired_at, input.now ?? new Date().toISOString()),
  };
}

function elapsedMs(from: string, now: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/** `4h43m`, `12m`, `30s` — the shape an operator reads uptime in. PURE. */
export function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** True when `value` is a complete presence — a consumer's fail-closed check. PURE. */
export function isRedskilledPresence(value: unknown): value is RedskilledPresence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const presence = value as Record<string, unknown>;
  return presence.version === 1 &&
    typeof presence.kind === "string" &&
    typeof presence.socket_path === "string" &&
    typeof presence.reason === "string" &&
    typeof presence.repair === "string";
}
