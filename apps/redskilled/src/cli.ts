#!/usr/bin/env node
/**
 * cli — the `redskilled` entrypoint: `serve` runs the daemon, `host-state` reads it.
 *
 * `serve` takes every path as a flag and derives none. ADR 0130 rule 3 makes
 * that a contract, not a style: the daemon must never learn repository layout,
 * because the moment it does, it stops being servable by checkouts on different
 * bundle versions. A path it needs is a path it was given.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, routeCommand } from "@reddb-io/shared/args.js";
import {
  readDeclaredProjectName,
  resolveProjectLabelForDir,
} from "@reddb-io/shared/project-identity-resolve.js";
import {
  ensureRedskilledDaemon,
  readRedskilledHostState,
  readRedskilledStatuslineString,
  stopRedskilledDaemon,
  type RedskilledClientConfig,
} from "./client.js";
import { isResolvedRedskilledEntry } from "./daemon-entry.js";
import {
  auditRedskilledProvisioning,
  installRedskilledUserUnit,
  provisionRedskilledHome,
  readRedskilledProvisionFacts,
  renderRedskilledUserUnit,
} from "./provision.js";
import {
  DEFAULT_REDSKILLED_IDLE_MS,
  startRedskilledDaemon,
  type RedskilledQueueRegistration,
} from "./daemon.js";
import { createGitHubActivityTransport } from "./repository-activity.js";
import {
  reclaimRedskilledRuntimeDirs,
  type RedskilledReclaimOptions,
} from "./reclaim.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import {
  parseRedskilledStatuslineFlags,
  resolveRedskilledStatuslineOptions,
} from "./statusline-config.js";
import { renderRedskilledStatuslineAbsence } from "./statusline-render.js";
import {
  installRedskilledUnit,
  planRedskilledUnit,
  readRedskilledUnitStatus,
  uninstallRedskilledUnit,
  type RedskilledUnitIO,
} from "./supervision.js";

/**
 * Usage, as a CONSTANT — the answer owes nothing to the machine it is asked on.
 *
 * `--help` is asked under exactly the conditions `--version` is (#2918): the
 * daemon will not start, or the operator is hunting for the subcommand that
 * stops it. Deriving usage from a socket, a config file or a store makes the
 * subcommand list unavailable precisely when someone is lost, which is how a
 * one-second question became a detour during a version migration.
 */
export const REDSKILLED_USAGE = `Usage: redskilled <command> [options]

Commands:
  host-state (default)  print the host's state as JSON
  serve                 run the daemon in this process
  statusline [global]   render one agent-host status line
  unit                  install | uninstall | status — the optional supervisor
  provision             make this machine ready; --check is the read-only half
  reclaim               clear runtime dirs left by dead sessions

Run \`redskilled <command> --help\` for a command's own usage.
\`--version\` (\`-v\`) prints the build stamp; both answer offline.
`;

/** Each subcommand's scoped usage — same contract, same offline answer. */
const COMMAND_USAGE = {
  serve: `Usage: redskilled serve [options]

Runs the daemon in this process. Every path is a flag and none is derived
(ADR 0130 rule 3); what is absent falls back to the session derivation.

  --socket <path>             the unix socket to listen on
  --lease <path>              the singleton lease record
  --events <path>             the append-only host event lane
  --session-key-hash <hex>    publishable session identity
  --machine-id-hash <hex>     publishable host label
  --machine-claim <path>      the machine-wide claim record
  --idle-ms <n>               exit after this long with no work
  --daemon-version <v>        the version this daemon reports as
  --queue-endpoint <url>      where the queue poll asks; GitHub's when absent
  --queue-ms <n>              window between queue polls
  --demand-ms <n>             window between demand ticks

The poller is armed by a token in REDSKILLED_HOST_TOKEN (GITHUB_TOKEN or
GH_TOKEN when it is unset). With none, the daemon holds registrations and counts
no queue — an honest unknown, never a drained one.
`,
  "host-state": `Usage: redskilled host-state

Prints the host's state as JSON. Contacts the running daemon; the default
command when none is named.
`,
  statusline: `Usage: redskilled statusline [global] [--verbose] [flags]

Renders the status line the agent host prints verbatim. Config is read on this
side and only decided values cross the socket (ADR 0130 rule 10).

  global      render the host-wide line instead of this project's
  --verbose   add one line per Worker
`,
  unit: `Usage: redskilled unit [install|uninstall|status]

Manages the OPTIONAL user supervisor unit — auto-spawn is the floor, and a host
with no unit is a supported configuration (ADR 0130 rule 7). Defaults to status.
`,
  provision: `Usage: redskilled provision [--check] [--no-start] [--install-unit]

Makes a machine with no prior state ready, and prints the audit. Idempotent: a
second run creates nothing and reports the same verdicts.

  --check         read-only; creates and starts nothing
  --no-start      provision the home without starting the daemon
  --install-unit  also install the user supervisor unit
`,
  stop: `Usage: redskilled stop [--detail <why>]

Asks the daemon to shut down and reports what it was holding. Every Worker
survives: they are init-system units, so a stop is a restart and not an
evacuation. A socket nobody answers on is a success with a stated reason.

  --detail <why>  the operator's own words, recorded on the event lane so a
                  successor can tell a planned handover from a crash
`,
  reclaim: `Usage: redskilled reclaim [--dry-run] [--grace-ms <n>]

Reports every session runtime dir it looked at and why it kept or removed it.

  --dry-run        the same report with nothing removed
  --grace-ms <n>   how long a dir must be idle before it is reclaimed
`,
} as const satisfies Record<string, string>;

/** The three spellings of "tell me what this does", asked of the top level. */
function isHelpToken(token: string | undefined): boolean {
  return token === "--help" || token === "-h" || token === "help";
}

const SERVE_FLAGS = {
  socket: { kind: "value", coerce: (raw: string) => raw },
  lease: { kind: "value", coerce: (raw: string) => raw },
  events: { kind: "value", coerce: (raw: string) => raw },
  "session-key-hash": { kind: "value", coerce: (raw: string) => raw },
  "machine-id-hash": { kind: "value", coerce: (raw: string) => raw },
  "machine-claim": { kind: "value", coerce: (raw: string) => raw },
  "idle-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
  "daemon-version": { kind: "value", coerce: (raw: string) => raw },
  "queue-endpoint": { kind: "value", coerce: (raw: string) => raw },
  "queue-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
  "demand-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
} as const;

/**
 * The env var naming the credential this host polls the tracker with.
 *
 * ONE token per host, by construction: quota is per credential, so the whole
 * point of batching every project into one request is lost the moment a second
 * one appears (ADR 0130 Amendment 3).
 */
export const REDSKILLED_HOST_TOKEN_ENV = "REDSKILLED_HOST_TOKEN";

/**
 * Arm the queue poller, or say nothing and leave it unarmed.
 *
 * **No token, no poller** — and no invented depth either. A daemon that cannot
 * reach the tracker holds registrations it never counts, which reads as
 * `queue-unknown` at every demand tick; that is the honest state, and it is
 * distinguishable from a drained queue, which is the distinction the whole
 * Amendment turns on.
 */
export function resolveServeQueueDiscovery(
  values: { readonly "queue-endpoint"?: string; readonly "queue-ms"?: number },
  env: NodeJS.ProcessEnv = process.env,
): RedskilledQueueRegistration | undefined {
  const token = (env[REDSKILLED_HOST_TOKEN_ENV] ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "").trim();
  if (token === "") return undefined;
  const endpoint = values["queue-endpoint"] ?? env.GITHUB_GRAPHQL_URL;
  return {
    transport: createGitHubActivityTransport({ token, ...(endpoint ? { endpoint } : {}) }),
    ...(values["queue-ms"] == null ? {} : { intervalMs: values["queue-ms"] }),
  };
}

export async function runRedskilledCli(argv: readonly string[]): Promise<number> {
  // Answered before routing, because the daemon's own version is the fact a
  // skew investigation starts from — and `serve` takes `--daemon-version` from
  // its caller, so the binary must still be able to state what IT is.
  if (argv[0] === "--version" || argv[0] === "-v") {
    const info = readBuildInfo("redskilled");
    process.stdout.write(
      argv.includes("--json") ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`,
    );
    return 0;
  }

  // Answered before routing, for the same reason `--version` is: routing lands
  // on `host-state`, which reaches for the socket — so an operator whose daemon
  // is down would be told the daemon is down when they asked what the commands
  // are (#2918). Usage never contacts a socket, starts a daemon or reads config.
  if (isHelpToken(argv[0])) {
    process.stdout.write(REDSKILLED_USAGE);
    return 0;
  }

  const { command, args } = routeCommand<
    "serve" | "stop" | "host-state" | "statusline" | "unit" | "provision" | "reclaim"
  >(argv, {
    commands: { serve: {}, stop: {}, "host-state": {}, statusline: {}, unit: {}, provision: {}, reclaim: {} },
    default: "host-state",
  });

  // The same guarantee one level down: `<command> --help` prints that command's
  // usage BEFORE dispatch, so no subcommand's help path can reach the daemon.
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(COMMAND_USAGE[command]);
    return 0;
  }

  if (command === "serve") {
    const { values } = parseFlags(args, SERVE_FLAGS);
    const queueDiscovery = resolveServeQueueDiscovery(values);
    const daemon = await startRedskilledDaemon({
      paths: servePaths(values),
      idleMs: values["idle-ms"] ?? DEFAULT_REDSKILLED_IDLE_MS,
      // The artifact states what it IS. Absent, the daemon reports the version
      // baked into this build rather than a placeholder, because "what version is
      // answering" is the first fact a skew investigation needs.
      daemonVersion: values["daemon-version"] ?? readBuildInfo("redskilled").version,
      // The two halves of the loop ADR 0130 Amendment 4 moved in here: what the
      // tracker says exists, and how often this host decides what it can afford.
      // Absent flags take the modules' own windows; an absent token leaves the
      // poller unarmed rather than counting a queue it never reached.
      ...(queueDiscovery == null ? {} : { queueDiscovery }),
      ...(values["demand-ms"] == null ? {} : { demandMs: values["demand-ms"] }),
    });
    // A signalled daemon LETS GO rather than being cut off: the stop path flushes
    // the event lane, releases the lease and unlinks the socket, so the successor
    // inherits a complete record instead of whatever had reached disk by the time
    // the default handler killed this process (#2917). The Workers are untouched —
    // they are init-system units, and this is a restart, not an evacuation.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      // Named on the lane as a signal rather than as a request: a successor that
      // could not tell "the operator asked" from "something signalled us" would
      // read every kill as a planned handover (#2919).
      process.once(signal, () => void daemon.stop({ reason: "signal", signal }).catch(() => undefined));
    }
    await daemon.closed;
    return 0;
  }

  if (command === "stop") return await runStop(args);
  if (command === "statusline") return await runStatusline(args);
  if (command === "unit") return await runUnit(args);

  if (command === "provision") return await runProvision(args);
  if (command === "reclaim") return await runReclaim(args);

  const state = await readRedskilledHostState(resolveRedskilledPaths());
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
}

const STOP_FLAGS = {
  reason: { kind: "value", coerce: (raw: string) => raw },
  "settle-timeout-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
} as const;

/**
 * `redskilled stop [--reason "..."]` — the daemon, asked to leave.
 *
 * **Asking beats signalling, and the report is the whole reason.** A hand-sent
 * `SIGTERM` ends the same process and can say nothing about what that process was
 * holding; this prints the Workers and projects the daemon had, states that every
 * one of them survives — Workers are init-system units, so a stop is a restart and
 * not an evacuation — and records the intent on the host event lane so a successor
 * can tell a handover from a crash.
 *
 * **A daemon that is not running is a success**, with the reason printed. The
 * operator asked for a machine with no daemon on it and that is the machine they
 * have; erroring would make this a command one must check the state before running.
 */
export async function runStop(
  args: readonly string[],
  io: {
    readonly write?: (text: string) => void;
    readonly paths?: RedskilledPaths;
    readonly client?: RedskilledClientConfig;
  } = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const { values } = parseFlags(args, STOP_FLAGS);
  const report = await stopRedskilledDaemon(
    io.paths ?? resolveRedskilledPaths(),
    {
      ...(values.reason == null ? {} : { detail: values.reason }),
      ...(Number.isFinite(values["settle-timeout-ms"]) ? { settleTimeoutMs: values["settle-timeout-ms"] as number } : {}),
    },
    io.client ?? {},
  );
  write(`${encodeToon({
    running: report.running,
    stopped: report.stopped,
    reason: report.reason,
    socket: report.socket_path,
    daemon_version: report.daemon_version,
    pid: report.pid,
    holding: {
      workers: report.holding.workers.length,
      projects: [...report.holding.projects],
    },
    surviving: [...report.surviving],
    workers: report.holding.workers.map((worker) => ({
      worker_id: worker.worker_id,
      project_label: worker.project_label,
      pid: worker.pid,
      unit: worker.unit,
      isolated: worker.isolated,
      survives: worker.survives,
    })),
    detail: report.detail,
  })}\n`);
  // The one failure an operator must not miss: a daemon that took the request and
  // is still answering. An absent daemon is not one of them.
  return report.running && !report.stopped ? 1 : 0;
}

/**
 * `redskilled unit install|uninstall|status` — the optional supervisor.
 *
 * Optional is the whole point (ADR 0130 rule 7): a host that never runs this
 * still gets a daemon, because auto-spawn is the floor and the unit only adds
 * `Restart=on-failure` on top. The status answer says so out loud, so an absent
 * unit reads as a supported configuration rather than as a broken machine.
 */
export async function runUnit(
  args: readonly string[],
  io: {
    readonly paths?: RedskilledPaths;
    readonly write?: (line: string) => void;
    readonly unitIO?: RedskilledUnitIO;
  } = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line));
  const paths = io.paths ?? resolveRedskilledPaths();
  const action = args[0] ?? "status";

  if (action === "status") {
    write(`${JSON.stringify(readRedskilledUnitStatus(io.unitIO ?? {}), null, 2)}\n`);
    return 0;
  }
  if (action === "install") {
    const installed = await installRedskilledUnit(planRedskilledUnit(paths), io.unitIO ?? {});
    write(`${JSON.stringify(installed, null, 2)}\n`);
    return installed.installed ? 0 : 1;
  }
  if (action === "uninstall") {
    write(`${JSON.stringify(await uninstallRedskilledUnit(io.unitIO ?? {}), null, 2)}\n`);
    return 0;
  }
  throw new Error(`unsupported redskilled unit action ${JSON.stringify(action)}: expected install, uninstall or status`);
}

/**
 * `redskilled statusline [global] [--verbose] [--flags]` — the whole of an agent
 * host's job.
 *
 * The host runs this and prints the one line it writes; it decides nothing about
 * shape, order, width or degradation, because ADR 0130 rule 10 moves rendering
 * off every host so that a second host cannot drift from the first. Config is
 * read HERE, on the client side, and only decided values cross the socket.
 *
 * **It always writes a line and always exits 0.** A statusline that printed
 * nothing when the daemon was down would be indistinguishable from a machine
 * with no Workers — the operator would read an outage as calm — so an
 * unreachable host renders as a stated absence and the diagnosis goes to stderr,
 * where a host's statusline plumbing does not put it on screen.
 */
export async function runStatusline(
  args: readonly string[],
  io: {
    readonly cwd?: string;
    /** The session's socket; derived from the environment when absent. */
    readonly paths?: RedskilledPaths;
    readonly write?: (line: string) => void;
    readonly warn?: (line: string) => void;
    /** How to reach the daemon; injected so a test can pose as a dead host. */
    readonly client?: RedskilledClientConfig;
    /** The clock, for the one instant no daemon supplies: an absence's own. */
    readonly now?: () => string;
  } = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line));
  const warn = io.warn ?? ((line: string) => process.stderr.write(line));

  const parsed = parseRedskilledStatuslineFlags(args);
  const project = readStatuslineProject(io.cwd ?? process.cwd());
  const resolved = resolveRedskilledStatuslineOptions({
    ...(project.configText == null ? {} : { configText: project.configText }),
    project: project.label,
    flags: parsed.flags,
  });
  for (const warning of [...resolved.warnings, ...parsed.warnings]) {
    warn(`redskilled statusline: ignoring ${warning.key}=${warning.value} — ${warning.reason}\n`);
  }

  let render;
  try {
    render = await readRedskilledStatuslineString(io.paths ?? resolveRedskilledPaths(), resolved.options, {
      ...(io.client ?? {}),
      ...(resolved.options.project == null ? {} : { sessionProject: resolved.options.project }),
    });
  } catch (err) {
    warn(`redskilled statusline: ${err instanceof Error ? err.message : String(err)}\n`);
    render = renderRedskilledStatuslineAbsence({
      options: resolved.options,
      generated_at: (io.now ?? (() => new Date().toISOString()))(),
    });
  }
  // Every line the daemon rendered, in order — one write, whatever the taste.
  // With `--verbose` that is the Worker line plus a second line per Worker; the
  // host still decides nothing about shape (ADR 0130 rule 10).
  write(`${render.lines.join("\n")}\n`);
  return 0;
}

const PROVISION_FLAGS = {
  "no-start": { kind: "boolean" },
  "install-unit": { kind: "boolean" },
  check: { kind: "boolean" },
} as const;

/**
 * `redskilled provision` — a machine with no prior state, made ready.
 *
 * It creates the host-scoped home (the one thing this app owns outright),
 * starts the daemon through the ordinary auto-spawn path, and prints the audit.
 * **Idempotent**: a second run creates nothing, rewrites nothing and reports the
 * same verdicts, which is what makes it safe for `/red-setup` to run on every
 * pass rather than only when something looks wrong.
 *
 * `--check` is the read-only half — the shape `/red-doctor` consumes — and never
 * creates or starts anything.
 */
export async function runProvision(
  args: readonly string[],
  io: {
    readonly write?: (text: string) => void;
    /** The session to provision; derived from the environment when absent. */
    readonly paths?: RedskilledPaths;
    readonly homeDir?: string;
    readonly configHome?: string;
    /** Client options for the start, so a test can pose as another host. */
    readonly client?: RedskilledClientConfig;
  } = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const { values } = parseFlags(args, PROVISION_FLAGS);
  const paths = io.paths ?? resolveRedskilledPaths();
  const home = values.check ? undefined : await provisionRedskilledHome(io.homeDir ?? homedir());

  // The daemon is started through the very path a client uses, so provisioning
  // proves the route a project will take rather than a private one beside it.
  let startError: string | undefined;
  if (!values.check && !values["no-start"]) {
    try {
      await ensureRedskilledDaemon(paths, io.client ?? {});
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    }
  }

  const facts = await readRedskilledProvisionFacts({
    paths,
    ...(io.homeDir == null ? {} : { homeDir: io.homeDir }),
    ...(io.configHome == null ? {} : { configHome: io.configHome }),
    ...(io.client?.serverCommand == null
      ? {}
      : { entryOverride: { serverCommand: io.client.serverCommand, serverArgs: io.client.serverArgs } }),
  });
  const unit = values["install-unit"] && isResolvedRedskilledEntry(facts.entry)
    ? await installRedskilledUserUnit({
        configHome: io.configHome ?? configHome(),
        unit: renderRedskilledUserUnit({
          command: [facts.entry.command, ...facts.entry.args].join(" "),
          socketPath: paths.socketPath,
        }),
      })
    : undefined;

  const report = auditRedskilledProvisioning(facts);
  write(`${encodeToon({
    verdict: report.verdict,
    home: home == null
      ? { path: facts.homePath, created: false, tightened: false }
      : { path: home.path, created: home.created, tightened: home.tightened },
    socket: facts.socketPath,
    ...(startError == null ? {} : { start_error: startError }),
    ...(unit == null ? {} : { unit: { path: unit.path, status: unit.status } }),
    checks: report.rows.map((row) => ({ check: row.check, verdict: row.verdict, evidence: row.evidence })),
    fixes: report.findings.map((finding) => ({ check: finding.check, fix: finding.fix })),
  })}\n`);
  return report.verdict === "ok" ? 0 : 1;
}

const RECLAIM_FLAGS = {
  "dry-run": { kind: "boolean" },
  "grace-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
} as const;

/**
 * `redskilled reclaim [--dry-run] [--grace-ms N]` — a host that already
 * accumulated dead sessions, cleared without hand-deleting paths.
 *
 * It reports every directory it looked at and why it kept or removed it, because
 * the operator reaching for this command is usually mid-diagnosis: "which of
 * these is a live daemon" is the question, and a sweep that answered it only by
 * changing the filesystem underneath them would destroy the evidence it was
 * called to explain. `--dry-run` is that same report with nothing removed.
 */
export async function runReclaim(
  args: readonly string[],
  io: {
    readonly write?: (text: string) => void;
    readonly options?: RedskilledReclaimOptions;
  } = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const { values } = parseFlags(args, RECLAIM_FLAGS);
  const report = await reclaimRedskilledRuntimeDirs({
    ...(io.options ?? {}),
    dryRun: values["dry-run"] === true,
    ...(Number.isFinite(values["grace-ms"]) ? { graceMs: values["grace-ms"] as number } : {}),
  });
  write(`${encodeToon({
    roots: [...report.roots],
    scanned: report.scanned,
    reclaimed: report.reclaimed,
    dry_run: report.dryRun,
    entries: report.entries.map((entry) => ({
      dir: entry.dir,
      verdict: entry.verdict,
      reason: entry.reason,
      removed: [...entry.removed],
    })),
  })}\n`);
  // A failure to read or remove is the one thing an operator must not miss.
  return report.entries.some((entry) => entry.verdict === "failed") ? 1 : 0;
}

function configHome(): string {
  const declared = process.env.XDG_CONFIG_HOME?.trim();
  return declared && declared !== "" ? declared : join(homedir(), ".config");
}

/**
 * The calling directory's project label, and the config that carries its taste.
 *
 * **Resolved through the SAME authority that labels a Worker at birth**, which is
 * the whole of the fix for #2928. Reading only a declared `project.name` here
 * meant a repository that declares none — most of them — asked the daemon about
 * `null` while every one of its Workers was filed under the label the remote
 * gave, so the local mode reported an idle zero from a host holding three.
 */
function readStatuslineProject(cwd: string): { configText?: string; label: string | null } {
  const declared = readDeclaredProjectName(cwd);
  // No `.red/config.yaml` anywhere above is a directory outside any RedSkills
  // project: it has no taste to read and no project to be, and guessing a label
  // from git alone would file a stray shell under a repository it is only near.
  if (declared.configText == null) return { label: null };
  return { configText: declared.configText, label: resolveProjectLabelForDir(cwd) };
}

/**
 * The serve paths: flags first, the session derivation only for what is absent.
 *
 * A supervisor unit passes everything; a hand-run `redskilled serve` passes
 * nothing and still lands on the same session socket as its clients.
 */
function servePaths(values: {
  socket?: string;
  lease?: string;
  events?: string;
  "session-key-hash"?: string;
  "machine-id-hash"?: string;
  "machine-claim"?: string;
}): RedskilledPaths {
  const derived = resolveRedskilledPaths();
  return {
    ...derived,
    socketPath: values.socket ?? derived.socketPath,
    leasePath: values.lease ?? derived.leasePath,
    eventLanePath: values.events ?? derived.eventLanePath,
    sessionKeyHash: values["session-key-hash"] ?? derived.sessionKeyHash,
    machineIdHash: values["machine-id-hash"] ?? derived.machineIdHash,
    machineClaimPath: values["machine-claim"] ?? derived.machineClaimPath,
  };
}

const invokedDirectly = process.argv[1] != null &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  runRedskilledCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`redskilled: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
