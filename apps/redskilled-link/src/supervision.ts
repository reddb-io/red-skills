import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";

export const REDSKILLED_LINK_UNIT_NAME = "redskilled-link.service";

export interface RedskilledLinkEntry {
  readonly command: string;
  readonly args: readonly string[];
}

export interface CurrentRedskilledLinkEntryOptions {
  readonly scriptPath?: string;
  readonly execPath?: string;
  readonly execArgv?: readonly string[];
  readonly homeDir?: string;
}

export interface RedskilledLinkUnitPlan {
  readonly unitName: typeof REDSKILLED_LINK_UNIT_NAME;
  readonly unitPath: string;
  readonly text: string;
}

export interface RedskilledLinkUnitRunResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface RedskilledLinkUnitIO {
  readonly write?: (path: string, text: string) => Promise<void>;
  readonly run?: (argv: readonly string[]) => RedskilledLinkUnitRunResult;
}

export interface RedskilledLinkUnitInstallation {
  readonly unitPath: string;
  readonly installed: boolean;
  readonly detail?: string;
}

export function redskilledLinkUnitPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(configHome, "systemd", "user", REDSKILLED_LINK_UNIT_NAME);
}

export function currentRedskilledLinkEntry(
  options: CurrentRedskilledLinkEntryOptions = {},
): RedskilledLinkEntry {
  const script = options.scriptPath ?? process.argv[1];
  if (!script) throw new Error("redskilled-link cannot supervise an entry with no script path");
  const resolvedScript = resolve(script);
  return {
    command: options.execPath ?? process.execPath,
    args: [
      ...(options.execArgv ?? process.execArgv),
      resolvedScript.endsWith(".bundle.min.mjs")
        ? stabilizePublishedBundle(resolvedScript, options.homeDir ?? homedir())
        : resolvedScript,
    ],
  };
}

function stabilizePublishedBundle(source: string, homeDir: string): string {
  const bytes = readFileSync(source);
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const binDir = join(redskilledHomeDir(homeDir), "bin");
  const stable = join(binDir, `redskilled-link-${digest}.bundle.min.mjs`);
  mkdirSync(binDir, { recursive: true, mode: 0o700 });

  const existing = readFileIfPresent(stable);
  if (existing && createHash("sha256").update(existing).digest("hex").startsWith(digest)) return stable;

  const temporary = `${stable}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporary, stable);
  } finally {
    rmSync(temporary, { force: true });
  }
  return stable;
}

function readFileIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function planRedskilledLinkUnit(options: {
  readonly entry: RedskilledLinkEntry;
  readonly statePath: string;
  readonly env?: NodeJS.ProcessEnv;
}): RedskilledLinkUnitPlan {
  if (!isAbsolute(options.entry.command)) {
    throw new Error(`redskilled-link supervisor requires an absolute executable, received ${options.entry.command}`);
  }
  const argv = [...options.entry.args, "host", "--state", resolve(options.statePath)];
  return {
    unitName: REDSKILLED_LINK_UNIT_NAME,
    unitPath: redskilledLinkUnitPath(options.env),
    text: [
      "[Unit]",
      "Description=redskilled Remote link Host companion",
      "Documentation=https://github.com/reddb-io/red-skills/blob/main/.red/adr/0158-remote-control-is-a-companion-not-a-daemon-listener.md",
      "After=network-online.target redskilled.service",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=${[options.entry.command, ...argv].map(quoteUnitWord).join(" ")}`,
      "Restart=always",
      "RestartSec=2",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  };
}

export async function installRedskilledLinkUnit(
  plan: RedskilledLinkUnitPlan,
  io: RedskilledLinkUnitIO = {},
): Promise<RedskilledLinkUnitInstallation> {
  const write = io.write ?? defaultWrite;
  const run = io.run ?? defaultRun;
  await write(plan.unitPath, plan.text);
  const reload = run(["systemctl", "--user", "daemon-reload"]);
  if (reload.status !== 0) return failed(plan, reload, "systemd user manager did not reload");
  const enable = run(["systemctl", "--user", "enable", plan.unitName]);
  if (enable.status !== 0) return failed(plan, enable, "systemd did not enable the Host companion");
  const restart = run(["systemctl", "--user", "restart", plan.unitName]);
  if (restart.status !== 0) return failed(plan, restart, "systemd did not start the Host companion");
  return { unitPath: plan.unitPath, installed: true };
}

export interface RedskilledLinkUnitRemoval {
  readonly unitPath: string;
  readonly removed: boolean;
  readonly detail?: string;
}

/**
 * Take the Host companion back out: stop it, disable it, delete the unit.
 *
 * A best-effort inverse of install — a machine where the unit was never
 * installed answers `removed: true`, because the state the operator asked for
 * (no companion) already holds.
 */
export async function removeRedskilledLinkUnit(
  io: RedskilledLinkUnitIO & { readonly unlink?: (path: string) => Promise<void> } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<RedskilledLinkUnitRemoval> {
  const run = io.run ?? defaultRun;
  const unlink = io.unlink ?? (async (target: string) => { await rm(target, { force: true }); });
  const unitPath = redskilledLinkUnitPath(env);
  const disable = run(["systemctl", "--user", "disable", "--now", REDSKILLED_LINK_UNIT_NAME]);
  await unlink(unitPath);
  const reload = run(["systemctl", "--user", "daemon-reload"]);
  if (reload.status !== 0) {
    return {
      unitPath,
      removed: false,
      detail: (reload.stderr ?? reload.stdout ?? "").trim() || "systemd user manager did not reload",
    };
  }
  return {
    unitPath,
    removed: true,
    ...(disable.status === 0 ? {} : { detail: "the unit was not enabled; the file is gone either way" }),
  };
}

export interface RedskilledLinkUnitStatus {
  readonly unitName: typeof REDSKILLED_LINK_UNIT_NAME;
  /** systemd's own words: "active", "inactive", "failed" — or null when unaskable. */
  readonly active: string | null;
  readonly enabled: string | null;
}

/** Ask systemd, and only systemd, whether the companion runs. */
export function readRedskilledLinkUnitStatus(
  io: RedskilledLinkUnitIO = {},
): RedskilledLinkUnitStatus {
  const run = io.run ?? defaultRun;
  const answer = (argv: readonly string[]): string | null => {
    const result = run(argv);
    const word = (result.stdout ?? "").trim();
    return word === "" ? null : word;
  };
  return {
    unitName: REDSKILLED_LINK_UNIT_NAME,
    active: answer(["systemctl", "--user", "is-active", REDSKILLED_LINK_UNIT_NAME]),
    enabled: answer(["systemctl", "--user", "is-enabled", REDSKILLED_LINK_UNIT_NAME]),
  };
}

function failed(
  plan: RedskilledLinkUnitPlan,
  result: RedskilledLinkUnitRunResult,
  fallback: string,
): RedskilledLinkUnitInstallation {
  const detail = (result.stderr ?? result.stdout ?? "").trim() || fallback;
  return { unitPath: plan.unitPath, installed: false, detail };
}

async function defaultWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode: 0o644 });
}

function defaultRun(argv: readonly string[]): RedskilledLinkUnitRunResult {
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function quoteUnitWord(value: string): string {
  return `"${value.replace(/([\\"])/g, "\\$1")}"`;
}
