#!/usr/bin/env node
import { fleetCommand } from "./commands/fleet.js";
import { monitorCommand } from "./commands/monitor.js";
import { runCommand } from "./commands/run.js";
import { reapCommand } from "./commands/reap.js";
import { superviseCommand } from "./commands/supervise.js";

export type CliCommand = "run" | "monitor" | "fleet" | "reap" | "__supervise";

export interface ParsedCli {
  command: CliCommand;
  args: string[];
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const [first, ...rest] = argv;
  if (first === "monitor") return { command: "monitor", args: rest };
  if (first === "fleet") return { command: "fleet", args: rest };
  if (first === "reap") return { command: "reap", args: rest };
  if (first === "__supervise") return { command: "__supervise", args: rest };
  if (first === "run") return { command: "run", args: rest };
  return { command: "run", args: [...argv] };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed.command === "monitor") return monitorCommand(parsed.args);
  if (parsed.command === "fleet") return fleetCommand(parsed.args);
  if (parsed.command === "reap") return reapCommand(parsed.args);
  if (parsed.command === "__supervise") return superviseCommand(parsed.args);
  return runCommand({ args: parsed.args });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[afk-ts] ${message}`);
    process.exit(1);
  });
}
