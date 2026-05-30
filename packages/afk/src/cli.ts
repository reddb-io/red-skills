#!/usr/bin/env node
import { fleetCommand } from "./commands/fleet.js";
import { monitorCommand } from "./commands/monitor.js";
import { runCommand } from "./commands/run.js";

export interface ParsedCli {
  command: "run" | "monitor" | "fleet";
  args: string[];
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const [first, ...rest] = argv;
  if (first === "monitor") return { command: "monitor", args: rest };
  if (first === "fleet") return { command: "fleet", args: rest };
  if (first === "run") return { command: "run", args: rest };
  return { command: "run", args: [...argv] };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed.command === "monitor") return monitorCommand(parsed.args);
  if (parsed.command === "fleet") return fleetCommand(parsed.args);
  return runCommand({ args: parsed.args });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[afk-ts] ${message}`);
    process.exit(1);
  });
}
