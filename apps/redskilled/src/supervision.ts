/**
 * supervision — the optional user unit that revives a daemon nobody asked for.
 *
 * ADR 0130 rule 7 chose auto-spawn as the floor **plus** an optional user unit
 * with `Restart=on-failure`. Auto-spawn shipped alone, which left the one
 * component whose absence stops every project on the machine revived only when
 * some client next happens to want work. This module is the other half.
 *
 * **The unit adds a supervisor, never a second spawn path.** Its `ExecStart` is
 * the same resolved published bundle a client would spawn, given the same session
 * paths on the same flags, so a host with the unit and a host without it run
 * identical code against an identical contract — the difference is only who
 * notices the death. That is why the unit is *rendered from* the entry resolver
 * rather than hand-written: a unit carrying its own idea of the argv would drift
 * from the client's the first time a flag moved.
 *
 * **Idle exit is a clean exit, so the supervisor lets it go.** `Restart=on-failure`
 * revives a daemon that died; it does not fight the daemon that left because it
 * had nothing to hold (ADR 0130 rule 7 keeps idle exit gated on the Worker set).
 * A self-replacement therefore exits NON-ZERO on purpose — see
 * {@link REDSKILLED_REPLACE_EXIT_CODE} — because being restarted is the whole
 * point of that exit.
 *
 * PURE apart from the injected file and `systemctl` IO, so the unit text and the
 * install sequence are both provable on a host with no systemd at all.
 */
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  redskilledServeArgv,
  requireRedskilledEntry,
  type RedskilledEntryLookup,
  type RedskilledEntryOverride,
} from "./daemon-entry.js";
import type { RedskilledPaths } from "./paths.js";

/** The unit's name — one per machine, matching the daemon's own scope. */
export const REDSKILLED_UNIT_NAME = "redskilled.service";

/** Env var the unit sets, so a daemon knows a supervisor will revive it. */
export const REDSKILLED_SUPERVISED_ENV = "REDSKILLED_SUPERVISED";

/** The ADR record the unit points a reader at, carried in `Documentation=`. */
export const REDSKILLED_UNIT_DOCUMENTATION =
  "https://github.com/reddb-io/red-skills/blob/main/.red/adr/0130-redskilled-host-scoped-execution-daemon.md";

/** Where user units live: `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/...`. */
export function redskilledUnitDir(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(config, "systemd", "user");
}

/** The unit file this session's daemon is supervised by. */
export function redskilledUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(redskilledUnitDir(env), REDSKILLED_UNIT_NAME);
}

export interface RedskilledUnitPlan {
  readonly unitName: string;
  readonly unitPath: string;
  /** The executable the unit starts — the published bundle, never the caller's. */
  readonly command: string;
  readonly args: readonly string[];
  /** The whole unit file, ready to write. */
  readonly text: string;
}

export interface PlanRedskilledUnitOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** An explicit command, exactly as a client may state one. */
  readonly override?: RedskilledEntryOverride;
  /** Where to look for the published bundle when no command is stated. */
  readonly entryLookup?: RedskilledEntryLookup;
  readonly idleMs?: number;
}

/**
 * Render the unit for one session's daemon.
 *
 * Throws {@link RedskilledDaemonEntryError} when no published bundle can be
 * resolved: a unit whose `ExecStart` names nothing would install cleanly and then
 * fail on every start, which is the fail-open shape ADR 0130 rule 6 refuses.
 */
export function planRedskilledUnit(
  paths: RedskilledPaths,
  options: PlanRedskilledUnitOptions = {},
): RedskilledUnitPlan {
  const env = options.env ?? process.env;
  const entry = requireRedskilledEntry(options.override ?? {}, options.entryLookup ?? {});
  const args = [
    ...entry.args,
    ...redskilledServeArgv(paths, options.idleMs == null ? {} : { idleMs: options.idleMs }),
  ];
  return {
    unitName: REDSKILLED_UNIT_NAME,
    unitPath: redskilledUnitPath(env),
    command: entry.command,
    args,
    text: renderUnit(entry.command, args, paths),
  };
}

function renderUnit(command: string, args: readonly string[], paths: RedskilledPaths): string {
  return [
    "[Unit]",
    "Description=redskilled — the host-scoped execution daemon (ADR 0130)",
    `Documentation=${REDSKILLED_UNIT_DOCUMENTATION}`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[command, ...args].map(quoteUnitWord).join(" ")}`,
    // The whole reason the unit exists: a daemon that dies comes back without a
    // client having to want work first.
    "Restart=on-failure",
    "RestartSec=1",
    `Environment="${REDSKILLED_SUPERVISED_ENV}=1"`,
    // The session the daemon serves, stated rather than derived: a unit started
    // by the init system may not inherit the login session's XDG variables, and a
    // daemon that resolved a different session would serve a socket its clients
    // never look at.
    `Environment="REDSKILLED_SESSION=${escapeUnitValue(paths.sessionKey)}"`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** A word for `ExecStart`: quoted only when it would otherwise split or escape. */
function quoteUnitWord(word: string): string {
  return /[\s"'\\$%]/.test(word) ? `"${escapeUnitValue(word)}"` : word;
}

function escapeUnitValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

/** One `systemctl` (or file) step the install performed, in order. */
export interface RedskilledUnitStep {
  readonly step: "write-unit" | "daemon-reload" | "enable" | "disable" | "remove-unit";
  readonly argv?: readonly string[];
  readonly ok: boolean;
  readonly detail?: string;
}

/** The result of one `systemctl` call — status is what the caller judges on. */
export interface RedskilledUnitRunResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface RedskilledUnitIO {
  readonly writeFile?: (path: string, text: string) => Promise<void>;
  readonly removeFile?: (path: string) => Promise<void>;
  readonly exists?: (path: string) => boolean;
  readonly run?: (argv: readonly string[]) => RedskilledUnitRunResult;
}

export interface RedskilledUnitInstallation {
  readonly unitPath: string;
  /** True when every step the install needed succeeded. */
  readonly installed: boolean;
  readonly steps: readonly RedskilledUnitStep[];
}

/**
 * Install and start the unit: write it, reload, `enable --now`.
 *
 * `--now` because an install that only registered the unit would leave the
 * machine unsupervised until the next login, and the operator who ran this asked
 * for supervision now.
 */
export async function installRedskilledUnit(
  plan: RedskilledUnitPlan,
  io: RedskilledUnitIO = {},
): Promise<RedskilledUnitInstallation> {
  const write = io.writeFile ?? defaultWriteFile;
  const run = io.run ?? defaultRun;
  const steps: RedskilledUnitStep[] = [];

  await write(plan.unitPath, plan.text);
  steps.push({ step: "write-unit", ok: true, detail: plan.unitPath });
  steps.push(runStep("daemon-reload", run, ["systemctl", "--user", "daemon-reload"]));
  steps.push(runStep("enable", run, ["systemctl", "--user", "enable", "--now", plan.unitName]));

  return { unitPath: plan.unitPath, installed: steps.every((step) => step.ok), steps };
}

/**
 * Remove the unit: `disable --now`, delete the file, reload.
 *
 * Removing supervision is not removing the daemon — the floor stays auto-spawn,
 * so a stopped unit is a machine that starts a daemon the next time a client
 * needs one.
 */
export async function uninstallRedskilledUnit(
  io: RedskilledUnitIO & { readonly env?: NodeJS.ProcessEnv } = {},
): Promise<RedskilledUnitInstallation> {
  const remove = io.removeFile ?? defaultRemoveFile;
  const run = io.run ?? defaultRun;
  const unitPath = redskilledUnitPath(io.env ?? process.env);
  const steps: RedskilledUnitStep[] = [
    runStep("disable", run, ["systemctl", "--user", "disable", "--now", REDSKILLED_UNIT_NAME]),
  ];
  await remove(unitPath);
  steps.push({ step: "remove-unit", ok: true, detail: unitPath });
  steps.push(runStep("daemon-reload", run, ["systemctl", "--user", "daemon-reload"]));
  return { unitPath, installed: false, steps };
}

/**
 * What the host says about supervision right now.
 *
 * `floor` is stated in the answer rather than left to the reader: an absent unit
 * is a supported configuration, not a fault, and a status that only said
 * `installed: false` would read as a broken machine.
 */
export interface RedskilledUnitStatus {
  readonly unitName: string;
  readonly unitPath: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  /** How a daemon starts when nothing supervises it. Always auto-spawn. */
  readonly floor: "auto-spawn";
}

export function readRedskilledUnitStatus(
  io: RedskilledUnitIO & { readonly env?: NodeJS.ProcessEnv } = {},
): RedskilledUnitStatus {
  const exists = io.exists ?? existsSync;
  const run = io.run ?? defaultRun;
  const unitPath = redskilledUnitPath(io.env ?? process.env);
  const installed = exists(unitPath);
  return {
    unitName: REDSKILLED_UNIT_NAME,
    unitPath,
    installed,
    // Never asked when the file is absent: `is-enabled` on a unit that does not
    // exist is a failure, and reporting it as "not enabled" would be the same
    // answer for two different machines.
    enabled: installed && run(["systemctl", "--user", "is-enabled", REDSKILLED_UNIT_NAME]).status === 0,
    active: installed && run(["systemctl", "--user", "is-active", REDSKILLED_UNIT_NAME]).status === 0,
    floor: "auto-spawn",
  };
}

function runStep(
  step: RedskilledUnitStep["step"],
  run: (argv: readonly string[]) => RedskilledUnitRunResult,
  argv: readonly string[],
): RedskilledUnitStep {
  const result = run(argv);
  const detail = (result.stderr ?? result.stdout ?? "").trim();
  return { step, argv, ok: result.status === 0, ...(detail ? { detail } : {}) };
}

async function defaultWriteFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { encoding: "utf8", mode: 0o644 });
}

async function defaultRemoveFile(path: string): Promise<void> {
  await rm(path, { force: true });
}

function defaultRun(argv: readonly string[]): RedskilledUnitRunResult {
  const result = spawnSync(argv[0]!, [...argv.slice(1)], { encoding: "utf8" });
  if (result.error != null) return { status: null, stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
