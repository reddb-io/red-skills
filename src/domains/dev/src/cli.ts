#!/usr/bin/env node
import { fleetCommand } from "./commands/fleet.js";
import { monitorCommand } from "./commands/monitor.js";
import { runCommand } from "./commands/run.js";
import { reapCommand } from "./commands/reap.js";
import { statuslineCommand } from "./commands/statusline.js";
import { superviseCommand } from "./commands/supervise.js";
import { routeCommand, type RouterSchema } from "../../../shared/args.js";

export type CliCommand = "run" | "monitor" | "fleet" | "reap" | "statusline" | "__supervise";

export interface ParsedCli {
  command: CliCommand;
  args: string[];
}

/**
 * Command-router schema for the dev CLI, expressed against the shared layer
 * (`src/shared/args.ts`). A leading `run` is peeled like any other command;
 * any other leading token falls through to the `run` default with the full
 * argv preserved, reproducing the legacy default-`/afk` interface exactly.
 */
const CLI_ROUTER: RouterSchema<CliCommand> = {
  commands: {
    run: {},
    monitor: {},
    fleet: {},
    reap: {},
    statusline: {},
    __supervise: {},
  },
  default: "run",
  keepArgvOnDefault: true,
};

export function parseCli(argv: readonly string[]): ParsedCli {
  return routeCommand(argv, CLI_ROUTER);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed.command === "monitor") return monitorCommand(parsed.args);
  if (parsed.command === "fleet") return fleetCommand(parsed.args);
  if (parsed.command === "reap") return reapCommand(parsed.args);
  if (parsed.command === "statusline") return statuslineCommand(parsed.args);
  if (parsed.command === "__supervise") return superviseCommand(parsed.args);
  return runCommand({ args: parsed.args });
}

import { createLogger } from "../../../shared/log.js";
const __log = createLogger({ serviceName: "afk" });

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    __log.error({ err: error }, message);
    process.exit(1);
  });
}
