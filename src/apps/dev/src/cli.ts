#!/usr/bin/env node
import { fleetCommand } from "./commands/fleet.js";
import { activityReviewCommand } from "./commands/activity-review.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { injectDevelopmentWorkflowCommand } from "./commands/inject-development-workflow.js";
import { monitorCommand } from "./commands/monitor.js";
import { runCommand } from "./commands/run.js";
import { reapCommand } from "./commands/reap.js";
import { retakeCommand } from "./commands/retake.js";
import { routeModelTierCommand } from "./commands/route-model-tier.js";
import { shipCommand } from "./commands/ship.js";
import { statuslineCommand } from "./commands/statusline.js";
import { superviseCommand } from "./commands/supervise.js";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { routeCommand, type RouterSchema } from "@reddb-io/shared/args.js";

export type CliCommand =
  | "run"
  | "monitor"
  | "fleet"
  | "dashboard"
  | "daily-review"
  | "weekly-review"
  | "reap"
  | "retake"
  | "ship"
  | "route-model-tier"
  | "statusline"
  | "inject-development-workflow"
  | "version"
  | "__supervise";

export interface ParsedCli {
  command: CliCommand;
  args: string[];
}

/**
 * Command-router schema for the dev CLI, expressed against the shared layer
 * (`src/packages/shared/args.ts`). A leading `run` is peeled like any other command;
 * any other leading token falls through to the `run` default with the full
 * argv preserved, reproducing the legacy default-`/afk` interface exactly.
 */
const CLI_ROUTER: RouterSchema<CliCommand> = {
  commands: {
    run: {},
    monitor: {},
    fleet: {},
    dashboard: {},
    "daily-review": {},
    "weekly-review": {},
    reap: {},
    retake: {},
    ship: {},
    "route-model-tier": {},
    statusline: {},
    "inject-development-workflow": {},
    version: {},
    __supervise: {},
  },
  default: "run",
  keepArgvOnDefault: true,
};

export function parseCli(argv: readonly string[]): ParsedCli {
  if (argv[0] === "--version" || argv[0] === "-v") return { command: "version", args: argv.slice(1) };
  return routeCommand(argv, CLI_ROUTER);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed.command === "version") {
    const info = readBuildInfo("dev");
    process.stdout.write(parsed.args.includes("--json") ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
    return 0;
  }
  if (parsed.command === "monitor") return monitorCommand(parsed.args);
  if (parsed.command === "fleet") return fleetCommand(parsed.args);
  if (parsed.command === "dashboard") return dashboardCommand(parsed.args);
  if (parsed.command === "daily-review") return activityReviewCommand("daily", parsed.args);
  if (parsed.command === "weekly-review") return activityReviewCommand("weekly", parsed.args);
  if (parsed.command === "reap") return reapCommand(parsed.args);
  if (parsed.command === "retake") return retakeCommand(parsed.args);
  if (parsed.command === "ship") return shipCommand(parsed.args);
  if (parsed.command === "route-model-tier") return routeModelTierCommand(parsed.args);
  if (parsed.command === "statusline") return statuslineCommand(parsed.args);
  if (parsed.command === "inject-development-workflow") return injectDevelopmentWorkflowCommand(parsed.args);
  if (parsed.command === "__supervise") return superviseCommand(parsed.args);
  return runCommand({ args: parsed.args });
}

import { createLogger } from "@reddb-io/shared/log.js";
const __log = createLogger({ serviceName: "afk" });

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    __log.error({ err: error }, message);
    process.exit(1);
  });
}
