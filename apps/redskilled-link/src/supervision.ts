import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const REDSKILLED_LINK_UNIT_NAME = "redskilled-link.service";

export interface RedskilledLinkEntry {
  readonly command: string;
  readonly args: readonly string[];
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

export function currentRedskilledLinkEntry(): RedskilledLinkEntry {
  const script = process.argv[1];
  if (!script) throw new Error("redskilled-link cannot supervise an entry with no script path");
  return {
    command: process.execPath,
    args: [...process.execArgv, resolve(script)],
  };
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
