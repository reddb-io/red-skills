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
 * Amendment 2 records the split: `provisionRedskilledHome` is the ONE creator,
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
import {
  declaredWorkspaceTargetInConfig,
  parseWorkspaceTarget,
  workspaceReadsRedskilledHome,
  WORKSPACE_TARGET_CONFIG_KEY,
} from "@reddb-io/shared/worker-workspace.js";
import { socketAnswers } from "./daemon.js";
import {
  isResolvedRedskilledEntry,
  resolveRedskilledEntry,
  type RedskilledEntryLookup,
  type RedskilledEntryOverride,
  type RedskilledEntryResolution,
} from "./daemon-entry.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";

/**
 * The canonical fix, in one string, so every surface prints the same sentence.
 *
 * The direct form is spelled as the ADR 0091 npm direct-run invocation rather
 * than a bare `redskilled`, because this line is printed exactly when the host
 * has no working daemon — and therefore no reason to have a shim for one on
 * PATH. A hint that names its own precondition is the #2961 dead end (#3071).
 */
export const REDSKILLED_PROVISION_FIX =
  "run `/red-setup` (Section E3 — execution daemon), or " +
  `\`${canonicalInvocation("red-skills-redskilled", ["provision"])}\` directly`;

/** What a provisioning run did to the home. `created` and `tightened` are never both true. */
export interface RedskilledHomeReceipt {
  readonly path: string;
  /** True when this run brought the directory into being. */
  readonly created: boolean;
  /** True when this run narrowed an existing home back to owner-only. */
  readonly tightened: boolean;
  readonly mode: number;
  /** The host configuration this authority owns beside the daemon home. */
  readonly configPath: string;
  /** True only when this run created the initial, operator-editable template. */
  readonly configCreated: boolean;
}

const HOST_CONFIG_TEMPLATE = `# Host-scoped redskilled policy. This file is never read from a repository.
plugins:
  dev:
    redskilled:
      # worker_ceiling: 6
      # memory_ceiling: 8G
      # validation_ceiling: 2
      # idle_ms: 300000
`;

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
  const configPath = join(dirname(path), "config.yaml");
  const existing = await modeOf(path);
  let created = false;
  let tightened = false;
  if (existing === undefined) {
    await mkdir(path, { recursive: true, mode: REDSKILLED_HOME_MODE });
    // `mkdir` masks the requested mode with the process umask, so the bits are
    // stated again rather than hoped for: a home this call left group-readable
    // would be reported as drift by the very audit below.
    await chmod(path, REDSKILLED_HOME_MODE);
    created = true;
  } else if (existing !== REDSKILLED_HOME_MODE) {
    await chmod(path, REDSKILLED_HOME_MODE);
    tightened = true;
  }

  // `wx` is the ownership boundary: provisioning may establish the file, but
  // once an operator has one it is never rewritten, even by a concurrent run.
  let configCreated = false;
  try {
    await writeFile(configPath, HOST_CONFIG_TEMPLATE, { encoding: "utf8", flag: "wx", mode: 0o600 });
    configCreated = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return {
    path,
    created,
    tightened,
    mode: REDSKILLED_HOME_MODE,
    configPath,
    configCreated,
  };
}

/**
 * Whether anything on this host READS the home, and what says so.
 *
 * The daemon does not: it binds its socket, writes its lease and its event lane
 * under the session runtime dir, and never resolves the home at all. Exactly one
 * thing reads it — a workspace lane rooted inside it (`plugins.dev.workspace.target:
 * host`, or a custom parent under the home). So the need is a PROPERTY OF A
 * PROJECT'S DECLARATION, not of the machine, and `declaredBy` carries the
 * declaration into the audit's evidence so an operator is never told a bare
 * absence they cannot act on.
 */
export interface RedskilledHomeNeed {
  readonly needed: boolean;
  /** The declaration that decided it, quoted verbatim into the audit's evidence. */
  readonly declaredBy: string;
}

/** Nothing declared a need — what a host with no project in view reports. */
export const REDSKILLED_HOME_UNNEEDED: RedskilledHomeNeed = {
  needed: false,
  declaredBy: `no ${WORKSPACE_TARGET_CONFIG_KEY} in view`,
};

export interface RedskilledHomeNeedOptions {
  /** The repository whose `.red/config.yaml` declares the workspace target. */
  readonly projectRoot?: string | undefined;
  /** A target stated outright — wins over the file, for the moment a preset is chosen. */
  readonly declaredTarget?: string | undefined;
  readonly homeDir?: string | undefined;
}

/**
 * Read whether this host's declared workspace target needs the home.
 *
 * An unreadable config and an off-contract target both read as "not needed":
 * neither can be the `host` preset, and a provisioning run is the wrong place to
 * re-raise a config error the workspace layer already refuses at the point of
 * use.
 */
export async function readRedskilledHomeNeed(
  options: RedskilledHomeNeedOptions = {},
): Promise<RedskilledHomeNeed> {
  const homeDir = options.homeDir ?? homedir();
  const stated = options.declaredTarget?.trim();
  if (stated) return needOf(stated, homeDir, "stated on the command line");

  const projectRoot = options.projectRoot?.trim();
  if (!projectRoot) return REDSKILLED_HOME_UNNEEDED;
  const configPath = join(projectRoot, ".red", "config.yaml");
  const text = await readFile(configPath, "utf8").catch(() => undefined);
  if (text === undefined) return { needed: false, declaredBy: `no ${configPath}` };
  const declared = declaredWorkspaceTargetInConfig(text);
  if (declared === undefined) {
    return { needed: false, declaredBy: `${configPath} declares no workspace target (default local)` };
  }
  return needOf(declared, homeDir, configPath);
}

function needOf(declared: string, homeDir: string, source: string): RedskilledHomeNeed {
  const declaredBy = `${WORKSPACE_TARGET_CONFIG_KEY}: ${declared} (${source})`;
  try {
    return { needed: workspaceReadsRedskilledHome(parseWorkspaceTarget(declared), homeDir), declaredBy };
  } catch {
    return { needed: false, declaredBy: `${declaredBy} — off-contract, so it names no lane under the home` };
  }
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
  /** Whether anything on this host reads the home. Absent reads as unneeded. */
  readonly homeNeed?: RedskilledHomeNeed | undefined;
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

/**
 * An absent home is two different states, and reporting them as one is the defect
 * this row was fixed for (#2958).
 *
 * **Absent and not needed is `ok`** — the daemon never reads the home, so on the
 * default `local` preset the directory that was created was one nothing would
 * ever open. A row that reddened over it sent operators to `/red-setup` to cure a
 * machine that was already working. Absent and NEEDED stays `missing`, and names
 * the declaration that needs it.
 */
function homeRow(facts: RedskilledProvisionFacts): RedskilledProvisionRow {
  const need = facts.homeNeed ?? REDSKILLED_HOME_UNNEEDED;
  if (!facts.homePresent) {
    if (!need.needed) {
      return {
        check: "home",
        verdict: "ok",
        evidence: `${facts.homePath} is absent and unneeded — ${need.declaredBy}; the daemon never reads it`,
        fix: "",
      };
    }
    return {
      check: "home",
      verdict: "missing",
      evidence: `${facts.homePath} does not exist, and it is needed — ${need.declaredBy}`,
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
    fix:
      "install or warm the RedSkills bundle for this host, then re-run " +
      `\`${canonicalInvocation("red-skills-redskilled", ["provision"])}\``,
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
    ? "redskilled.service is installed (optional supervision, Restart=always)"
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
  /** The repository whose declared workspace target decides whether the home is needed. */
  readonly projectRoot?: string | undefined;
  /** A workspace target stated outright, for the moment an operator selects one. */
  readonly declaredTarget?: string | undefined;
  /** The need, already read — so a caller that has it does not read the config twice. */
  readonly homeNeed?: RedskilledHomeNeed | undefined;
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
  const [homeMode, reachable, homeNeed] = await Promise.all([
    modeOf(homePath),
    socketAnswers(paths.socketPath),
    options.homeNeed
      ? Promise.resolve(options.homeNeed)
      : readRedskilledHomeNeed({ homeDir, projectRoot: options.projectRoot, declaredTarget: options.declaredTarget }),
  ]);
  return {
    homePath,
    homePresent: homeMode !== undefined,
    homeMode,
    homeNeed,
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
 * It adds `Restart=always` to the identical binary, socket and contract the
 * auto-spawn path uses (rule 7); once installed it becomes the sole birth
 * authority rather than a second spawn path. Rendering it is separate from installing it because setup shows the
 * operator what it is about to write.
 */
export function renderRedskilledUserUnit(input: RedskilledUserUnitInput): string {
  const socketFlag = input.socketPath ? ` --socket ${input.socketPath}` : "";
  return [
    "[Unit]",
    "Description=redskilled — the host-scoped execution daemon (ADR 0130)",
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${input.command} serve${socketFlag}`,
    "Restart=always",
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
