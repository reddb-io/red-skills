#!/usr/bin/env node
/**
 * cli — the `redskilled` entrypoint: `serve` runs the daemon, `host-state` reads it.
 *
 * `serve` takes every path as a flag and derives none. ADR 0130 rule 3 makes
 * that a contract, not a style: the daemon must never learn repository layout,
 * because the moment it does, it stops being servable by checkouts on different
 * bundle versions. A path it needs is a path it was given.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, routeCommand } from "@reddb-io/shared/args.js";
import { findUp } from "@reddb-io/shared/plugin-gate.js";
import { declaredProjectNameInConfig } from "@reddb-io/shared/project-identity.js";
import {
  ensureRedskilledDaemon,
  readRedskilledHostState,
  readRedskilledStatuslineString,
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
import { DEFAULT_REDSKILLED_IDLE_MS, startRedskilledDaemon } from "./daemon.js";
import {
  reclaimRedskilledRuntimeDirs,
  type RedskilledReclaimOptions,
} from "./reclaim.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import {
  parseRedskilledStatuslineFlags,
  resolveRedskilledStatuslineOptions,
} from "./statusline-config.js";
import {
  installRedskilledUnit,
  planRedskilledUnit,
  readRedskilledUnitStatus,
  uninstallRedskilledUnit,
  type RedskilledUnitIO,
} from "./supervision.js";

const SERVE_FLAGS = {
  socket: { kind: "value", coerce: (raw: string) => raw },
  lease: { kind: "value", coerce: (raw: string) => raw },
  events: { kind: "value", coerce: (raw: string) => raw },
  "session-key-hash": { kind: "value", coerce: (raw: string) => raw },
  "machine-id-hash": { kind: "value", coerce: (raw: string) => raw },
  "idle-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
  "daemon-version": { kind: "value", coerce: (raw: string) => raw },
} as const;

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

  const { command, args } = routeCommand<
    "serve" | "host-state" | "statusline" | "unit" | "provision" | "reclaim"
  >(argv, {
    commands: { serve: {}, "host-state": {}, statusline: {}, unit: {}, provision: {}, reclaim: {} },
    default: "host-state",
  });

  if (command === "serve") {
    const { values } = parseFlags(args, SERVE_FLAGS);
    const daemon = await startRedskilledDaemon({
      paths: servePaths(values),
      idleMs: values["idle-ms"] ?? DEFAULT_REDSKILLED_IDLE_MS,
      // The artifact states what it IS. Absent, the daemon reports the version
      // baked into this build rather than a placeholder, because "what version is
      // answering" is the first fact a skew investigation needs.
      daemonVersion: values["daemon-version"] ?? readBuildInfo("redskilled").version,
    });
    await daemon.closed;
    return 0;
  }

  if (command === "statusline") return await runStatusline(args);
  if (command === "unit") return await runUnit(args);

  if (command === "provision") return await runProvision(args);
  if (command === "reclaim") return await runReclaim(args);

  const state = await readRedskilledHostState(resolveRedskilledPaths());
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
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
 */
export async function runStatusline(
  args: readonly string[],
  io: {
    readonly cwd?: string;
    /** The session's socket; derived from the environment when absent. */
    readonly paths?: RedskilledPaths;
    readonly write?: (line: string) => void;
    readonly warn?: (line: string) => void;
  } = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line));
  const warn = io.warn ?? ((line: string) => process.stderr.write(line));

  const parsed = parseRedskilledStatuslineFlags(args);
  const project = readProjectConfig(io.cwd ?? process.cwd());
  const resolved = resolveRedskilledStatuslineOptions({
    configText: project.configText,
    project: project.name,
    flags: parsed.flags,
  });
  for (const warning of [...resolved.warnings, ...parsed.warnings]) {
    warn(`redskilled statusline: ignoring ${warning.key}=${warning.value} — ${warning.reason}\n`);
  }

  const render = await readRedskilledStatuslineString(io.paths ?? resolveRedskilledPaths(), resolved.options, {
    ...(resolved.options.project == null ? {} : { sessionProject: resolved.options.project }),
  });
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

/** The nearest `.red/config.yaml`, and the project name it declares. */
function readProjectConfig(cwd: string): { configText?: string; name: string | null } {
  const path = findUp(cwd, ".red/config.yaml");
  if (path == null) return { name: null };
  let configText: string;
  try {
    configText = readFileSync(path, "utf8");
  } catch {
    return { name: null };
  }
  return { configText, name: declaredProjectNameInConfig(configText) ?? null };
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
}): RedskilledPaths {
  const derived = resolveRedskilledPaths();
  return {
    ...derived,
    socketPath: values.socket ?? derived.socketPath,
    leasePath: values.lease ?? derived.leasePath,
    eventLanePath: values.events ?? derived.eventLanePath,
    sessionKeyHash: values["session-key-hash"] ?? derived.sessionKeyHash,
    machineIdHash: values["machine-id-hash"] ?? derived.machineIdHash,
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
