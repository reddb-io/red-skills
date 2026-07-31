#!/usr/bin/env node
import { fleetCommand } from "./commands/fleet.js";
import { goCommand } from "./commands/go.js";
import { activityReviewCommand } from "./commands/activity-review.js";
import { afkOutputShapingCommand } from "./commands/afk-output-shaping.js";
import { auditSkillsCommand } from "./commands/audit-skills.js";
import { hitlCardCommand } from "./commands/hitl-card.js";
import { codexMonitorAgentCommand } from "./commands/codex-monitor-agent.js";
import { codexStatuslineCommand } from "./commands/codex-statusline.js";
import { dashboardCommand } from "./commands/dashboard.js";
import { injectDevelopmentWorkflowCommand } from "./commands/inject-development-workflow.js";
import { managerCommand } from "./commands/manager.js";
import { monitorCommand } from "./commands/monitor.js";
import { runCommand } from "./commands/run.js";
import { reapCommand } from "./commands/reap.js";
import { orphanBranchesCommand } from "./commands/orphan-branches.js";
import { redDoctorCommand } from "./commands/red-doctor.js";
import { redactSweepCommand } from "./commands/redact-sweep.js";
import { relabelSweepCommand } from "./commands/relabel-sweep.js";
import { requeueCommand } from "./commands/requeue.js";
import { retakeCommand } from "./commands/retake.js";
import { reviewCommand } from "./commands/review.js";
import { stopCommand } from "./commands/stop.js";
import { respondCommand } from "./commands/respond.js";
import { routeModelTierCommand } from "./commands/route-model-tier.js";
import { rspInstructionsCommand } from "./commands/rsp-instructions.js";
import { statuslineCommand, statuslineRefreshCountsCommand } from "./commands/statusline.js";
import { superviseCommand } from "./commands/supervise.js";
import { supervisorWatchdogCommand } from "./commands/supervisor-watchdog.js";
import { triageCommand } from "./commands/triage.js";
import { toonBumpCommand } from "./commands/toon-bump.js";
import { toonMigrateCommand } from "./commands/toon-migrate.js";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { routeCommand, UnknownCommandError, type RouterSchema } from "@reddb-io/shared/args.js";

export type CliCommand =
  | "run"
  | "monitor"
  | "fleet"
  | "stop"
  | "go"
  | "manager"
  | "dashboard"
  | "audit-skills"
  | "afk-output-shaping"
  | "daily-review"
  | "weekly-review"
  | "reap"
  | "orphan-branches"
  | "red-doctor"
  | "redact-sweep"
  | "relabel-sweep"
  | "requeue"
  | "retake"
  | "review"
  | "respond"
  | "hitl-card"
  | "triage"
  | "codex-monitor-agent"
  | "codex-statusline"
  | "route-model-tier"
  | "rsp-instructions"
  | "statusline"
  | "statusline-refresh-counts"
  | "inject-development-workflow"
  | "toon-bump"
  | "toon-migrate"
  | "version"
  | "__supervise"
  | "__watchdog";

export interface ParsedCli {
  command: CliCommand;
  args: string[];
}

/**
 * Command-router schema for the dev CLI, expressed against the shared layer
 * (`packages/shared/args.ts`). A leading `run` is peeled like any other
 * command; a flag-led (`--spec …`) or empty invocation falls through to the
 * `run` default with the full argv preserved, reproducing the legacy
 * default-`/afk` interface. `errorOnUnknownCommand` makes a typo'd subcommand
 * (a non-flag leading token matching no command) error instead of silently
 * launching a worker — accidental `afk moniter` no longer drains the queue.
 */
const CLI_ROUTER: RouterSchema<CliCommand> = {
  commands: {
    run: {},
    monitor: {},
    fleet: {},
    stop: {},
    go: {},
    manager: {},
    dashboard: {},
    "audit-skills": {},
    "afk-output-shaping": {},
    "daily-review": {},
    "weekly-review": {},
    reap: {},
    "orphan-branches": {},
    "red-doctor": {},
    "redact-sweep": {},
    "relabel-sweep": {},
    requeue: {},
    retake: {},
    review: {},
    respond: {},
    "hitl-card": {},
    triage: {},
    "codex-monitor-agent": {},
    "codex-statusline": {},
    "route-model-tier": {},
    "rsp-instructions": {},
    statusline: {},
    "statusline-refresh-counts": {},
    "inject-development-workflow": {},
    "toon-bump": {},
    "toon-migrate": {},
    version: {},
    __supervise: {},
    __watchdog: {},
  },
  default: "run",
  keepArgvOnDefault: true,
  errorOnUnknownCommand: true,
};

/** Run-surface flags the flag-led default invocation may open with — the
 * documented legacy `/afk` interface (`--issues 42`, `--spec 7`, …). Any OTHER
 * leading flag is an error, never a silent queue drain (#2581: `--help` booted
 * a live worker and iterated the queue). */
const RUN_SURFACE_LEADING_FLAGS = new Set([
  "--spec",
  "--issues",
  "--selector",
  "--runner",
  "--alternate",
  "--fallback-runner",
  "--request",
  "-r",
  "-n",
  "--once",
  "--boot-only",
  "--base",
]);

export const CLI_USAGE = `Usage: red-skills-dev <command> [options]

Commands: run (default), monitor, fleet, stop, go, manager, dashboard,
  daily-review, weekly-review, reap, orphan-branches, requeue, retake, review,
  respond, triage,
  red-doctor, statusline, version, …

Flag-led invocations route to the run surface: --issues N, --spec N,
  --selector <json>, --runner <r>, -n <count>, --once, --boot-only.

Run \`red-skills-dev <command> --help\` for a command's own usage.
Docs: plugins/dev/skills/engineering/afk/SKILL.md
`;

export class HelpRequested extends Error {}

export function parseCli(argv: readonly string[]): ParsedCli {
  if (argv[0] === "--version" || argv[0] === "-v") return { command: "version", args: argv.slice(1) };
  // Help must short-circuit BEFORE any routing can reach the run default —
  // a usage request never boots a worker or touches the queue (#2581).
  if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") throw new HelpRequested();
  const first = argv[0];
  if (first !== undefined && first.startsWith("-")) {
    const flagName = first.split("=")[0]!;
    if (!RUN_SURFACE_LEADING_FLAGS.has(flagName)) {
      throw new UnknownCommandError(first, [...RUN_SURFACE_LEADING_FLAGS]);
    }
  }
  return routeCommand(argv, CLI_ROUTER);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(CLI_USAGE);
      return 0;
    }
    if (error instanceof UnknownCommandError) {
      process.stderr.write(`[afk] ${error.message}\n`);
      process.stderr.write(CLI_USAGE);
      return 2;
    }
    throw error;
  }
  // `<command> --help` prints usage and exits BEFORE dispatch for every
  // command (#2581 acceptance) — commands with richer usage (e.g. fleet) are
  // never reached with a help flag, so their own handlers stay as docs.
  if (
    parsed.command !== "go" &&
    (parsed.args.includes("--help") || parsed.args.includes("-h"))
  ) {
    if (parsed.command === "fleet") return fleetCommand(parsed.args);
    process.stdout.write(
      `Usage: red-skills-dev ${parsed.command} [options]\n` +
        `No detailed usage registered for this command yet; see the afk skill docs.\n`,
    );
    return 0;
  }
  if (parsed.command === "version") {
    const info = readBuildInfo("dev");
    process.stdout.write(parsed.args.includes("--json") ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
    return 0;
  }
  if (parsed.command === "monitor") return monitorCommand(parsed.args);
  if (parsed.command === "fleet") return fleetCommand(parsed.args);
  if (parsed.command === "stop") return stopCommand(parsed.args);
  if (parsed.command === "go") return goCommand(parsed.args);
  if (parsed.command === "manager") return managerCommand(parsed.args);
  if (parsed.command === "dashboard") return dashboardCommand(parsed.args);
  if (parsed.command === "audit-skills") return auditSkillsCommand(parsed.args);
  if (parsed.command === "afk-output-shaping") return afkOutputShapingCommand(parsed.args);
  if (parsed.command === "daily-review") return activityReviewCommand("daily", parsed.args);
  if (parsed.command === "weekly-review") return activityReviewCommand("weekly", parsed.args);
  if (parsed.command === "reap") return reapCommand(parsed.args);
  if (parsed.command === "orphan-branches") return orphanBranchesCommand(parsed.args);
  if (parsed.command === "red-doctor") return redDoctorCommand(parsed.args);
  if (parsed.command === "redact-sweep") return redactSweepCommand(parsed.args);
  if (parsed.command === "relabel-sweep") return relabelSweepCommand(parsed.args);
  if (parsed.command === "requeue") return requeueCommand(parsed.args);
  if (parsed.command === "retake") return retakeCommand(parsed.args);
  if (parsed.command === "review") return reviewCommand(parsed.args);
  if (parsed.command === "respond") return respondCommand(parsed.args);
  if (parsed.command === "hitl-card") return hitlCardCommand(parsed.args);
  if (parsed.command === "triage") return triageCommand(parsed.args);
  if (parsed.command === "codex-monitor-agent") return codexMonitorAgentCommand(parsed.args);
  if (parsed.command === "codex-statusline") return codexStatuslineCommand(parsed.args);
  if (parsed.command === "route-model-tier") return routeModelTierCommand(parsed.args);
  if (parsed.command === "rsp-instructions") return rspInstructionsCommand(parsed.args);
  if (parsed.command === "statusline") return statuslineCommand(parsed.args);
  if (parsed.command === "statusline-refresh-counts") return statuslineRefreshCountsCommand(parsed.args);
  if (parsed.command === "inject-development-workflow") return injectDevelopmentWorkflowCommand(parsed.args);
  if (parsed.command === "toon-bump") return toonBumpCommand(parsed.args);
  if (parsed.command === "toon-migrate") return toonMigrateCommand(parsed.args);
  if (parsed.command === "__supervise") return superviseCommand(parsed.args);
  if (parsed.command === "__watchdog") return supervisorWatchdogCommand(parsed.args);
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
