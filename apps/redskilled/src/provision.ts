/**
 * provision — the route from a machine with no prior state to a reachable daemon.
 *
 * ADR 0130 rule 7 makes start an auto-spawn, which answers *when* a daemon
 * appears and says nothing about what has to exist first. Three things do: the
 * host-scoped home, a published bundle to run, and a socket that answers. This
 * module owns the first, reports on all three, and offers the optional
 * supervising unit rule 7 mentions.
 *
 * **The home is this app's, not `/red-setup`'s.** ADR 0067 gives setup sole
 * authority over a repository's `.red/`; `~/.red/redskilled/` is operator-scoped
 * and outside every checkout, so it was never covered by that authority — and it
 * cannot be, because a home only an interactive installer could create would
 * leave auto-spawn on a fresh machine failing closed with no way back. ADR 0130
 * Amendment 1 records the split: `provisionRedskilledHome` is the ONE creator,
 * and setup is its most important caller.
 *
 * The audit is PURE. Facts about the host are collected by
 * {@link readRedskilledProvisionFacts} and handed in, so `/red-doctor` renders
 * the same verdicts this CLI does without either one growing a private probe.
 */
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { REDSKILLED_HOME_MODE, redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { socketAnswers } from "./daemon.js";
import {
  isResolvedRedskilledEntry,
  resolveRedskilledEntry,
  type RedskilledEntryLookup,
  type RedskilledEntryOverride,
  type RedskilledEntryResolution,
} from "./daemon-entry.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";

/** The canonical fix, in one string, so every surface prints the same sentence. */
export const REDSKILLED_PROVISION_FIX =
  "run `/red-setup` (Section E3 — execution daemon), or `redskilled provision` directly";

/** What a provisioning run did to the home. `created` and `tightened` are never both true. */
export interface RedskilledHomeReceipt {
  readonly path: string;
  /** True when this run brought the directory into being. */
  readonly created: boolean;
  /** True when this run narrowed an existing home back to owner-only. */
  readonly tightened: boolean;
  readonly mode: number;
}

/**
 * Create the daemon's host-scoped home, owner-only. **The only creator.**
 *
 * Idempotent by construction: an existing home is kept with everything in it,
 * and the only thing a second run can change is a permission bit that drifted
 * wider than owner-only — which is a repair, not a rewrite. A run over a healthy
 * home touches nothing at all.
 */
export async function provisionRedskilledHome(
  homeDir: string = homedir(),
): Promise<RedskilledHomeReceipt> {
  const path = redskilledHomeDir(homeDir);
  const existing = await modeOf(path);
  if (existing === undefined) {
    await mkdir(path, { recursive: true, mode: REDSKILLED_HOME_MODE });
    // `mkdir` masks the requested mode with the process umask, so the bits are
    // stated again rather than hoped for: a home this call left group-readable
    // would be reported as drift by the very audit below.
    await chmod(path, REDSKILLED_HOME_MODE);
    return { path, created: true, tightened: false, mode: REDSKILLED_HOME_MODE };
  }
  if (existing === REDSKILLED_HOME_MODE) {
    return { path, created: false, tightened: false, mode: existing };
  }
  await chmod(path, REDSKILLED_HOME_MODE);
  return { path, created: false, tightened: true, mode: REDSKILLED_HOME_MODE };
}

/** The four things a provisioned host has. Order is the order they must be cured in. */
export type RedskilledProvisionCheck = "home" | "daemon-entry" | "reach" | "supervisor-unit";

/** `ok` is provisioned; `degraded` works but drifted; `missing` is not provisioned. */
export type RedskilledProvisionVerdict = "ok" | "degraded" | "missing";

/** Whether the optional user unit is installed — never a defect when it is not. */
export type RedskilledSupervisorUnitState = "installed" | "absent" | "unsupported";

/** Everything the audit reads. Collected by the caller; the audit reads nothing itself. */
export interface RedskilledProvisionFacts {
  readonly homePath: string;
  readonly homePresent: boolean;
  /** Permission bits of the home, when it exists. */
  readonly homeMode?: number | undefined;
  readonly entry: RedskilledEntryResolution;
  readonly socketPath: string;
  /** Whether a daemon answered a ping. Probed WITHOUT spawning one. */
  readonly reachable: boolean;
  readonly supervisorUnit: RedskilledSupervisorUnitState;
}

export interface RedskilledProvisionRow {
  readonly check: RedskilledProvisionCheck;
  readonly verdict: RedskilledProvisionVerdict;
  readonly evidence: string;
  /** The exact command to run. Empty only on an `ok` row. */
  readonly fix: string;
}

export interface RedskilledProvisionReport {
  /** The worst row's verdict: one word for "is this host provisioned?". */
  readonly verdict: RedskilledProvisionVerdict;
  readonly rows: readonly RedskilledProvisionRow[];
  /** The non-ok rows, in cure order — never a re-ranking of the rows themselves. */
  readonly findings: readonly RedskilledProvisionRow[];
}

/**
 * Audit one host's provisioning. PURE.
 *
 * Rows come out in cure order — home, bundle, reach, unit — because reach cannot
 * be fixed before the bundle it would run, and a report that led with the
 * downstream symptom would send an operator after the wrong thing.
 */
export function auditRedskilledProvisioning(facts: RedskilledProvisionFacts): RedskilledProvisionReport {
  const rows: RedskilledProvisionRow[] = [
    homeRow(facts),
    entryRow(facts),
    reachRow(facts),
    supervisorRow(facts),
  ];
  const findings = rows.filter((row) => row.verdict !== "ok");
  const verdict: RedskilledProvisionVerdict = findings.some((row) => row.verdict === "missing")
    ? "missing"
    : findings.length > 0
      ? "degraded"
      : "ok";
  return { verdict, rows, findings };
}

function homeRow(facts: RedskilledProvisionFacts): RedskilledProvisionRow {
  if (!facts.homePresent) {
    return {
      check: "home",
      verdict: "missing",
      evidence: `${facts.homePath} does not exist`,
      fix: REDSKILLED_PROVISION_FIX,
    };
  }
  const mode = facts.homeMode ?? REDSKILLED_HOME_MODE;
  if (mode !== REDSKILLED_HOME_MODE) {
    return {
      check: "home",
      verdict: "degraded",
      evidence: `${facts.homePath} is mode ${mode.toString(8)}, not owner-only ${REDSKILLED_HOME_MODE.toString(8)}`,
      fix: `${REDSKILLED_PROVISION_FIX} — it narrows the home back to owner-only`,
    };
  }
  return { check: "home", verdict: "ok", evidence: `${facts.homePath} (mode ${mode.toString(8)})`, fix: "" };
}

function entryRow(facts: RedskilledProvisionFacts): RedskilledProvisionRow {
  if (isResolvedRedskilledEntry(facts.entry)) {
    return {
      check: "daemon-entry",
      verdict: "ok",
      evidence: `${facts.entry.entry ?? facts.entry.command} (resolved as ${facts.entry.source})`,
      fix: "",
    };
  }
  // Every probed path, not a count: "where should the artifact have been?" is the
  // question an operator has, and a count answers none of it.
  return {
    check: "daemon-entry",
    verdict: "missing",
    evidence: `no published redskilled bundle; probed ${facts.entry.searched.join(", ") || "nothing"}`,
    fix: "install or warm the RedSkills bundle for this host, then re-run `redskilled provision`",
  };
}

function reachRow(facts: RedskilledProvisionFacts): RedskilledProvisionRow {
  if (facts.reachable) {
    return { check: "reach", verdict: "ok", evidence: `daemon answered on ${facts.socketPath}`, fix: "" };
  }
  return {
    check: "reach",
    verdict: "missing",
    evidence: `no daemon answered on ${facts.socketPath}`,
    fix: `${REDSKILLED_PROVISION_FIX} — it starts the daemon and waits for the socket`,
  };
}

/**
 * The optional unit is reported and never flagged.
 *
 * Rule 7 makes supervision an addition to auto-spawn, not a prerequisite for it,
 * so an absent unit is `ok` with a stated absence. A doctor that reddened here
 * would teach operators to ignore a red row — the one failure mode a doctor
 * cannot afford.
 */
function supervisorRow(facts: RedskilledProvisionFacts): RedskilledProvisionRow {
  const evidence = facts.supervisorUnit === "installed"
    ? "redskilled.service is installed (optional supervision, Restart=on-failure)"
    : facts.supervisorUnit === "unsupported"
      ? "optional: this host has no systemd --user session; auto-spawn is the only start path"
      : "optional: not installed; auto-spawn already starts the daemon on first use";
  return { check: "supervisor-unit", verdict: "ok", evidence, fix: "" };
}

export interface RedskilledProvisionFactsOptions {
  readonly homeDir?: string;
  readonly configHome?: string;
  readonly paths?: RedskilledPaths;
  readonly entryLookup?: RedskilledEntryLookup;
  /**
   * A command the caller states outright, reported instead of the resolution.
   *
   * The report must describe the daemon the caller would actually run, and a
   * stated command wins over every candidate on the spawn path — so a report
   * that re-derived one here would name a different file than the one running.
   */
  readonly entryOverride?: RedskilledEntryOverride;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Collect the facts the audit reads. **Read-only, and never spawns.**
 *
 * Reach is probed with a ping rather than with the auto-spawning client call: a
 * report that started the daemon it was asked about would answer its own
 * question and tell an operator nothing about the machine they walked up to.
 */
export async function readRedskilledProvisionFacts(
  options: RedskilledProvisionFactsOptions = {},
): Promise<RedskilledProvisionFacts> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const paths = options.paths ?? resolveRedskilledPaths({ env });
  const homePath = redskilledHomeDir(homeDir);
  const [homeMode, reachable] = await Promise.all([
    modeOf(homePath),
    socketAnswers(paths.socketPath),
  ]);
  return {
    homePath,
    homePresent: homeMode !== undefined,
    homeMode,
    entry: resolveRedskilledEntry(options.entryOverride ?? {}, { env, ...options.entryLookup }),
    socketPath: paths.socketPath,
    reachable,
    supervisorUnit: await readSupervisorUnitState(configHomeOf(options, env, homeDir), env),
  };
}

/** The unit file name; one name, so a re-install finds what a first install wrote. */
export const REDSKILLED_UNIT_FILE = "redskilled.service";

/** Where the optional user unit lives, under the operator's XDG config home. */
export function redskilledUserUnitPath(configHome: string): string {
  return join(configHome, "systemd", "user", REDSKILLED_UNIT_FILE);
}

export interface RedskilledUserUnitInput {
  /** The command that runs the daemon — the resolved entry, already joined. */
  readonly command: string;
  /** The session socket to serve, when the operator wants it pinned. */
  readonly socketPath?: string;
}

/**
 * The optional supervising unit, as text.
 *
 * It adds `Restart=on-failure` to the identical binary, socket and contract the
 * auto-spawn path uses (rule 7) — one behaviour with a supervisor, never a second
 * spawn path. Rendering it is separate from installing it because setup shows the
 * operator what it is about to write.
 */
export function renderRedskilledUserUnit(input: RedskilledUserUnitInput): string {
  const socketFlag = input.socketPath ? ` --socket ${input.socketPath}` : "";
  return [
    "[Unit]",
    "Description=redskilled — the host-scoped execution daemon (ADR 0130)",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${input.command} serve${socketFlag}`,
    "Restart=on-failure",
    "RestartSec=2",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface RedskilledUnitInstallation {
  readonly path: string;
  readonly status: "installed" | "already-present";
}

/**
 * Write the unit, once. **An existing file is never rewritten.**
 *
 * A unit an operator has edited is their configuration, and re-running setup
 * must not silently take an `Environment=` line or a hardened sandbox back out.
 */
export async function installRedskilledUserUnit(input: {
  readonly configHome: string;
  readonly unit: string;
}): Promise<RedskilledUnitInstallation> {
  const path = redskilledUserUnitPath(input.configHome);
  if ((await modeOf(path)) !== undefined) return { path, status: "already-present" };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, input.unit, "utf8");
  return { path, status: "installed" };
}

/** Whether the host carries the optional unit, and whether it could. */
async function readSupervisorUnitState(
  configHome: string,
  env: NodeJS.ProcessEnv,
): Promise<RedskilledSupervisorUnitState> {
  if (process.platform !== "linux") return "unsupported";
  try {
    await readFile(redskilledUserUnitPath(configHome), "utf8");
    return "installed";
  } catch {
    // A host with no `--user` session cannot hold the unit at all; ADR 0130's
    // placement layer already reads the same signal for Worker isolation.
    return env.XDG_RUNTIME_DIR ? "absent" : "unsupported";
  }
}

function configHomeOf(
  options: RedskilledProvisionFactsOptions,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): string {
  return options.configHome ?? env.XDG_CONFIG_HOME?.trim() ?? join(homeDir, ".config");
}

/** Permission bits of a path, or `undefined` when it does not exist. */
async function modeOf(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}
