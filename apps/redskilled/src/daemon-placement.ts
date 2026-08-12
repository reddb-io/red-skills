/**
 * daemon-placement — which resource group an AUTO-SPAWNED daemon is born into.
 *
 * ADR 0130 rule 7 makes auto-spawn the floor: the first client that needs a
 * daemon starts one. It said nothing about *where* that daemon lands, and a
 * `fork`ed child lands wherever its parent already is — on a desktop, inside
 * `app.slice/app-gnome-<terminal>-….scope`. **systemd-oomd kills a cgroup, not a
 * process** (#3657): pressure on the user manager took the terminal scope, and
 * with it the whole host daemon and every Worker it held, by SIGKILL, leaving no
 * record. The daemon a machine shares between all its projects must not be a
 * tenant of the first terminal that happened to want one.
 *
 * **A transient scope, not a transient service** — the opposite of the choice
 * `worker-placement` makes, and for the reason that module's own doc gives.
 * A Worker must survive a daemon restart and be re-attachable by unit name, so it
 * needs a unit the init system owns. An auto-spawned daemon needs something else:
 * the environment of the session that asked for it. Credentials resolve in that
 * environment (#3056), and a transient *service* is started by the user manager
 * and inherits the MANAGER's environment — curing the blast radius by silently
 * dropping the caller's tokens. `systemd-run --scope` moves its own process into
 * a new scope and then `exec`s, so the daemon keeps the caller's environment
 * verbatim while its cgroup becomes a SIBLING of the terminal's rather than a
 * child of it. That is the whole fix: oomd shooting `app-…-wezterm-….scope` no
 * longer touches `app.slice/redskilled-<session>.scope`.
 *
 * Once the optional user unit is installed it is the sole birth authority
 * (Amendment 11, `client-rendezvous.ts`) and nothing here runs — this module owns
 * the *unsupervised* floor, which is the state most machines are actually in.
 *
 * Planning is PURE over injected probes, on the `worker-placement` pattern: the
 * one impure read of the host lives in {@link detectDaemonPlacementProbes}, so
 * the systemd and no-systemd arms are both provable without spawning anything.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { REDSKILLED_UNIT_NAME } from "./supervision.js";

/** Env kill-switch: `REDSKILLED_DAEMON_PLACEMENT=off` forks as a child — loudly. */
export const REDSKILLED_DAEMON_PLACEMENT_ENV = "REDSKILLED_DAEMON_PLACEMENT";

/** The slice a scope of our own belongs in: the user manager's own app slice. */
export const REDSKILLED_DAEMON_SLICE = "app.slice";

export interface DaemonPlacementProbes {
  /** `process.platform` — transient scopes are a Linux backend. */
  readonly platform: NodeJS.Platform;
  /** `systemd-run` on PATH, or null when the binary is absent. */
  readonly systemdRun: string | null;
  /** True when a systemd `--user` session is reachable. */
  readonly userSession: boolean;
}

/** `transient-scope` is a group of the daemon's own; `none` is the caller's group. */
export type DaemonPlacementBackend = "transient-scope" | "none";

export interface DaemonPlacementPlan {
  /** True when the daemon is born in a resource group of its own. */
  readonly isolated: boolean;
  readonly backend: DaemonPlacementBackend;
  readonly command: string;
  readonly args: readonly string[];
  /** The transient scope unit's name, only under the `transient-scope` backend. */
  readonly scope?: string;
  /**
   * Why the daemon is charged to its caller, and what that now costs. ALWAYS set
   * when `isolated` is false — an unplaced daemon is never a silent one.
   */
  readonly warning?: string;
}

/**
 * Probe the host for the backend it can actually offer.
 *
 * The `--user` session is proven by its private socket under `XDG_RUNTIME_DIR`,
 * exactly as `worker-placement` proves it, so nothing is spawned on the start
 * path to find out.
 */
export function detectDaemonPlacementProbes(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DaemonPlacementProbes {
  if (platform !== "linux") return { platform, systemdRun: null, userSession: false };
  const runtimeDir = (env.XDG_RUNTIME_DIR ?? "").trim();
  return {
    platform,
    systemdRun: which("systemd-run", env),
    userSession: runtimeDir !== "" && existsSync(join(runtimeDir, "systemd", "private")),
  };
}

/** True unless the env kill-switch declines placement for this host. */
export function daemonPlacementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env[REDSKILLED_DAEMON_PLACEMENT_ENV] ?? "").trim().toLowerCase();
  if (override === "") return true;
  return !["off", "false", "0", "no"].includes(override);
}

/**
 * The transient scope's name: one per session location, never one per machine.
 *
 * Keyed by the session-key hash the socket is already keyed by, so a second
 * runtime dir — an operator pinning `REDSKILLED_SESSION`, a test posing as
 * another host — asks systemd for a name that is not already taken. A single
 * shared name would make the second daemon's placement fail on a live unit.
 */
export function redskilledDaemonScopeName(sessionKeyHash: string): string {
  return `redskilled-${slug(sessionKeyHash)}.scope`;
}

export interface PlanDaemonPlacementOptions {
  /** The resolved entry binary — what actually runs the daemon. */
  readonly command: string;
  /** The daemon's own argv, including the `serve` subcommand and its flags. */
  readonly args?: readonly string[];
  /** This session's publishable identity, which names the scope. */
  readonly sessionKeyHash: string;
  readonly probes: DaemonPlacementProbes;
  /** False when the env kill-switch declined placement host-wide. */
  readonly enabled?: boolean;
}

/**
 * Plan the launch argv for an auto-spawned daemon.
 *
 * When the host affords it, the daemon runs inside its own
 * `redskilled-<session>.scope` under `app.slice`. Everywhere else the original
 * argv comes back UNCHANGED with a warning: the daemon still starts — a host
 * without systemd must not be a host without a daemon — but the downgrade, and
 * the blast radius it restores, is never silent.
 */
export function planRedskilledDaemonPlacement(opts: PlanDaemonPlacementOptions): DaemonPlacementPlan {
  const args = [...(opts.args ?? [])];
  const unplaced = (reason: string): DaemonPlacementPlan => ({
    isolated: false,
    backend: "none",
    command: opts.command,
    args,
    warning:
      `${reason}: the daemon is born inside the resource group of whichever client first touched the socket, ` +
      "so a memory-pressure kill or a closed terminal takes the whole host daemon and every Worker it holds — " +
      `the session dies and the daemon dies with it. Install the optional user unit to place it permanently ` +
      `(\`${REDSKILLED_UNIT_NAME}\`, Restart=always).`,
  });

  if (opts.enabled === false) {
    return unplaced(`daemon placement disabled by ${REDSKILLED_DAEMON_PLACEMENT_ENV}`);
  }
  if (opts.probes.platform !== "linux") {
    return unplaced(`transient-scope placement is the Linux backend (platform=${opts.probes.platform})`);
  }
  if (!opts.probes.systemdRun) return unplaced("transient-scope placement unavailable: systemd-run is not on PATH");
  if (!opts.probes.userSession) {
    return unplaced("transient-scope placement unavailable: no systemd --user session");
  }

  const scope = redskilledDaemonScopeName(opts.sessionKeyHash);
  return {
    isolated: true,
    backend: "transient-scope",
    scope,
    command: opts.probes.systemdRun,
    // `--collect` so a scope left behind by an unclean death is garbage-collected
    // rather than blocking the next start on a name that is already taken;
    // `--quiet` because the caller's stdio is `ignore` and the "Running scope as
    // unit" line would go nowhere but a journal.
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${scope}`,
      `--slice=${REDSKILLED_DAEMON_SLICE}`,
      "--",
      opts.command,
      ...args,
    ],
  };
}

/** Where a daemon that is ALREADY running turned out to be charged. */
export type DaemonCgroupPlacement = "own-unit" | "shared-group" | "unknown";

export interface DaemonCgroupVerdict {
  readonly placement: DaemonCgroupPlacement;
  /** The cgroup path this verdict read, verbatim, or null when there was none. */
  readonly cgroup: string | null;
  /** What the placement means for this host. Always a sentence, never empty. */
  readonly reason: string;
}

/**
 * Classify the cgroup a running daemon sits in. PURE.
 *
 * The discrimination is the LEAF, because that is the group a kill lands on: a
 * scope or service the daemon owns is one nothing else can take down, and any
 * other group is somebody else's — a terminal's `app-…​.scope`, a login's
 * `session-N.scope` — where the daemon is collateral.
 *
 * `unknown` is a first-class answer rather than a suspicion. A host with no
 * cgroup filesystem (macOS, a WSL2 image without systemd) has no placement to
 * report, and reddening over one would teach operators to ignore the row.
 */
export function classifyDaemonCgroup(cgroupPath: string | null | undefined): DaemonCgroupVerdict {
  const cgroup = (cgroupPath ?? "").trim();
  if (cgroup === "" || cgroup === "/") {
    return {
      placement: "unknown",
      cgroup: cgroupPath ?? null,
      reason:
        "this host reports no cgroup for the daemon, so there is no resource group to name — " +
        "nothing here says the daemon is misplaced, only that the placement cannot be read",
    };
  }
  const leaf = cgroup.split("/").filter((part) => part !== "").pop() ?? "";
  if (leaf === REDSKILLED_UNIT_NAME || /^redskilled-[a-z0-9-]+\.scope$/.test(leaf)) {
    return {
      placement: "own-unit",
      cgroup,
      reason: `the daemon holds its own resource group, ${leaf} — a kill aimed at a terminal cannot reach it`,
    };
  }
  return {
    placement: "shared-group",
    cgroup,
    reason:
      `the daemon is charged to ${leaf}, a resource group it does not own — systemd-oomd kills a cgroup rather ` +
      "than a process, so memory pressure on that group takes the daemon and every Worker it holds",
  };
}

/**
 * Read one process's unified cgroup path, or `null`. **Never throws.**
 *
 * `/proc/<pid>/cgroup` rather than `/proc/self/cgroup`: the question is where the
 * daemon ended up, and a reporter that read its own placement would answer about
 * the reporter. An unreadable `/proc` — no procfs, a pid that just exited, a
 * foreign owner — is an absent answer, which {@link classifyDaemonCgroup} already
 * has a word for.
 */
export function readProcessCgroupPath(pid: number): string | null {
  try {
    // cgroup v2 writes exactly one line, `0::<path>`; on a v1/hybrid host the
    // unified controller is the same `0::` row, so one read answers both.
    for (const line of readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n")) {
      if (line.startsWith("0::")) return line.slice(3).trim();
    }
  } catch {
    // Fall through: an unreadable placement is reported as unread, never as bad.
  }
  return null;
}

function which(binary: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function slug(value: string): string {
  const cleaned = (value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return cleaned || "session";
}
