/**
 * supervision — the optional user unit that revives a daemon nobody asked for.
 *
 * ADR 0130 rule 7 chose auto-spawn as the floor **plus** an optional user unit
 * with `Restart=always`. Auto-spawn shipped alone, which left the one
 * component whose absence stops every project on the machine revived only when
 * some client next happens to want work. This module is the other half.
 *
 * **The unit becomes the birth authority, never a second spawn path.** Its `ExecStart` is
 * the same resolved published bundle a client would spawn, given the same session
 * paths on the same flags, so a host with the unit and a host without it run
 * identical code against an identical contract — the difference is who starts
 * it and notices the death. That is why the unit is *rendered from* the entry resolver
 * rather than hand-written: a unit carrying its own idea of the argv would drift
 * from the client's the first time a flag moved.
 *
 * **Every daemon exit is supervised.** `Restart=always` also revives a daemon
 * whose internal shutdown path exits zero. An explicit `systemctl stop` still
 * stays stopped because systemd does not apply the restart policy to an
 * operator-requested stop. A self-replacement keeps its distinct non-zero exit
 * code for observability — see {@link REDSKILLED_REPLACE_EXIT_CODE}.
 *
 * PURE apart from the injected file and `systemctl` IO, so the unit text and the
 * install sequence are both provable on a host with no systemd at all.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  redskilledServeArgv,
  requireRedskilledEntry,
  type RedskilledEntryLookup,
  type RedskilledEntryOverride,
  type RedskilledServeTarget,
} from "./daemon-entry.js";
import type { RedskilledPaths } from "./paths.js";
import { stabilizeRedskilledEntry, stableBundleHomeOf } from "./stable-bundle.js";

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
  /**
   * The version this daemon IS, so a cache-resident bundle can be copied
   * somewhere durable before the unit names it.
   *
   * Absent, `stabilizeRedskilledEntry` cannot name a destination and returns
   * the entry untouched — which is correct for a local build and wrong for the
   * npx dispatch, because npx always delivers the UNVERSIONED asset name. That
   * is how an installed unit came to point inside `~/.npm/_npx/`, a directory
   * npm may prune, leaving a daemon that cannot start.
   */
  readonly version?: string;
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
  // The unit outlives every cache, so its ExecStart must too (#3554 closure).
  // The caller states the version because the RESOLVED name usually cannot:
  // an npx dispatch hands over `redskilled.bundle.min.mjs`, with no version in
  // it, so a stabilizer left to read the basename declines and the unit ends up
  // naming a path inside `~/.npm/_npx/`. A shim or a genuinely local build is
  // still used as resolved — durability is an upgrade, never a precondition.
  const entry = stabilizeRedskilledEntry(
    requireRedskilledEntry(options.override ?? {}, options.entryLookup ?? {}),
    {
      homeDir: stableBundleHomeOf(env),
      ...(options.version === undefined ? {} : { version: options.version }),
    },
  );
  const args = [
    ...entry.args,
    ...redskilledServeArgv(paths),
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
    // A stale or manually-started holder must not turn singleton protection
    // into an unbounded restart storm.
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    "LimitCORE=0",
    `ExecStart=${[command, ...args].map(quoteUnitWord).join(" ")}`,
    // The whole reason the unit exists: a daemon that dies comes back without a
    // client having to want work first.
    "Restart=always",
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

/** The drop-in a supervised in-major replacement writes before it exits. */
export function redskilledReplacementDropInPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(`${redskilledUnitPath(env)}.d`, "10-current-entry.conf");
}

function replacementDropInForUnit(unitPath: string): string {
  return join(`${unitPath}.d`, "10-current-entry.conf");
}

/**
 * Atomically repoint the installed unit to the already-resolved successor.
 *
 * This runs before the old daemon releases its socket. If either the write or
 * daemon-reload fails, the replacement throws and the serving daemon stays up;
 * an upgrade may be delayed, but it cannot become a restart loop on the old
 * ExecStart.
 */
export function repointRedskilledUnitForReplacement(
  entry: { readonly command: string; readonly args: readonly string[] },
  target: RedskilledServeTarget,
  options: {
    readonly env?: NodeJS.ProcessEnv;
      readonly run?: (argv: readonly string[]) => RedskilledUnitRunResult;
  } = {},
): string {
  // systemd resolves the ExecStart binary with the MANAGER's PATH, which the
  // unit's own Environment=PATH never touches — a relative command here is
  // 203/EXEC on every restart until a human runs `reset-failed` (#3554). The
  // refusal happens before any write, so the serving daemon stays up on its
  // current ExecStart: an upgrade may be delayed, a unit is never poisoned.
  if (!isAbsolute(entry.command)) {
    throw new Error(
      `redskilled refused to write the relative command "${entry.command}" into the supervisor drop-in: ` +
        "systemd resolves ExecStart with the manager's PATH, so a relative command dies with 203/EXEC " +
        "on hosts whose node comes from a version manager (#3554)",
    );
  }
  const path = redskilledReplacementDropInPath(options.env ?? process.env);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const argv = [
    entry.command,
    ...entry.args,
    ...redskilledServeArgv(target),
  ];
  const text = [
    "[Service]",
    "ExecStart=",
    `ExecStart=${argv.map(quoteUnitWord).join(" ")}`,
    "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, text, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  const reloaded = (options.run ?? defaultRun)(["systemctl", "--user", "daemon-reload"]);
  if (reloaded.status !== 0) {
    throw new Error(
      `redskilled wrote the supervised replacement drop-in ${path}, but systemd did not reload it: ` +
        `${(reloaded.stderr ?? reloaded.stdout ?? `status ${reloaded.status}`).trim()}`,
    );
  }
  return path;
}

/** What healing the current-entry drop-in found and did. */
export interface RedskilledUnitHealReport {
  readonly path: string;
  /**
   * `absent` — no drop-in to heal; `absolute` — already healthy, untouched;
   * `healed` — relative command rewritten to this process's own absolute
   * invocation; `unparsed` — no readable ExecStart, left alone; `foreign` —
   * the drop-in serves some other session's socket, never ours to rewrite.
   */
  readonly status: "absent" | "absolute" | "healed" | "unparsed" | "foreign";
  /** The ExecStart command the drop-in carried, when one was readable. */
  readonly command?: string;
}

/**
 * Heal a current-entry drop-in whose `ExecStart` names a relative command.
 *
 * The recovery half of the #3554 fix: hosts that already carry a relative
 * `npx` drop-in are dead on every systemd start — but the SAME daemon still
 * comes up through client auto-spawn or an operator's hand-start, and a
 * supervised boot proves the running invocation works. So a daemon booting
 * supervised rewrites the poisoned drop-in with its own absolute invocation
 * (`process.execPath`, its own entry, its live argv) and reloads systemd,
 * converging the host without manual surgery. An absolute drop-in is left
 * byte-for-byte untouched, and so is one that does not name `socketPath` —
 * the drop-in describes ONE session's daemon, and only that daemon, proven by
 * serving the same socket, may rewrite it: a test or foreign-session process
 * that healed it would poison the unit with an argv it never served.
 */
export function healRedskilledUnitDropIn(
  options: {
    readonly env?: NodeJS.ProcessEnv;
    /** The socket THIS process serves — its claim to the drop-in. */
    readonly socketPath?: string;
    /** This process's absolute node; `process.execPath` by default. */
    readonly execPath?: string;
    /** This process's entry and everything after it; `process.argv.slice(1)` by default. */
    readonly argv?: readonly string[];
    /**
     * The version this process reports itself as. Stated, it lets the rewrite
     * stabilize the running entry into the daemon home first, so the healed
     * `ExecStart` points at the copy nothing on the host prunes.
     */
    readonly version?: string;
    readonly readFile?: (path: string) => string;
    readonly run?: (argv: readonly string[]) => RedskilledUnitRunResult;
  } = {},
): RedskilledUnitHealReport {
  const path = redskilledReplacementDropInPath(options.env ?? process.env);
  let text: string;
  try {
    text = (options.readFile ?? ((p: string) => readFileSync(p, "utf8")))(path);
  } catch {
    return { path, status: "absent" };
  }
  const words = execStartWordsOf(text);
  const command = words?.[0];
  if (words == null || command == null) return { path, status: "unparsed" };
  if (isAbsolute(command)) return { path, status: "absolute", command };
  if (options.socketPath == null || !words.includes(options.socketPath)) {
    return { path, status: "foreign", command };
  }
  const execPath = options.execPath ?? process.execPath;
  const tail = options.argv ?? process.argv.slice(1);
  // The healed target should also be the DURABLE one: the running entry is
  // copied into the daemon home when its version is certain, so the rewrite
  // does not trade a relative command for an absolute path into a GC'd cache.
  const stabilized = tail.length === 0 ? undefined : stabilizeRedskilledEntry(
    { command: execPath, args: tail, entry: tail[0] },
    {
      homeDir: stableBundleHomeOf(options.env ?? process.env),
      ...(options.version == null ? {} : { version: options.version }),
    },
  );
  const argv = [execPath, ...(stabilized?.args ?? tail)];
  const healed = [
    "[Service]",
    "ExecStart=",
    `ExecStart=${argv.map(quoteUnitWord).join(" ")}`,
    "",
  ].join("\n");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, healed, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  // A failed reload is not undone: the file on disk is already correct, and
  // systemd reads it on its own next reload or login — later beats never.
  (options.run ?? defaultRun)(["systemctl", "--user", "daemon-reload"]);
  return { path, status: "healed", command };
}

/** The words of the LAST non-empty `ExecStart=` line, unquoted. */
function execStartWordsOf(unitText: string): readonly string[] | undefined {
  let words: string[] | undefined;
  for (const line of unitText.split("\n")) {
    const value = line.trim().startsWith("ExecStart=") ? line.trim().slice("ExecStart=".length).trim() : undefined;
    if (!value) continue;
    words = value.split(/\s+/).map(
      (word) =>
        word.startsWith('"') && word.endsWith('"') && word.length > 1
          ? word.slice(1, -1).replace(/\\\\/g, "\\").replace(/\\"/g, '"')
          : word,
    );
  }
  return words;
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
  const remove = io.removeFile ?? defaultRemoveFile;
  const run = io.run ?? defaultRun;
  const steps: RedskilledUnitStep[] = [];

  await write(plan.unitPath, plan.text);
  // An explicit install (including a major upgrade) owns the new base
  // ExecStart. A managed in-major replacement drop-in must not silently keep
  // overriding that freshly installed entry.
  await remove(replacementDropInForUnit(plan.unitPath));
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
  await remove(replacementDropInForUnit(unitPath));
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
  /** Actionable supervision defects; an absent optional unit is not one. */
  readonly findings: readonly RedskilledUnitFinding[];
  /** How a daemon starts when nothing supervises it. Always auto-spawn. */
  readonly floor: "auto-spawn";
}

export interface RedskilledUnitFinding {
  readonly code: "enabled-but-inactive";
  readonly evidence: string;
  readonly fix: string;
}

export function readRedskilledUnitStatus(
  io: RedskilledUnitIO & { readonly env?: NodeJS.ProcessEnv } = {},
): RedskilledUnitStatus {
  const exists = io.exists ?? existsSync;
  const run = io.run ?? defaultRun;
  const unitPath = redskilledUnitPath(io.env ?? process.env);
  const installed = exists(unitPath);
  // Never probe systemd when the file is absent: its failure would collapse a
  // supported optional configuration into the same answer as a broken unit.
  const enabled = installed && run(["systemctl", "--user", "is-enabled", REDSKILLED_UNIT_NAME]).status === 0;
  const active = installed && run(["systemctl", "--user", "is-active", REDSKILLED_UNIT_NAME]).status === 0;
  const findings: RedskilledUnitFinding[] = enabled && !active
    ? [{
        code: "enabled-but-inactive",
        evidence: `${REDSKILLED_UNIT_NAME} is installed and enabled but inactive`,
        fix: `systemctl --user restart ${REDSKILLED_UNIT_NAME}`,
      }]
    : [];
  return {
    unitName: REDSKILLED_UNIT_NAME,
    unitPath,
    installed,
    enabled,
    active,
    findings,
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
