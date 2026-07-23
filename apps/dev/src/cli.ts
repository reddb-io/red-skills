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
  command: CliCommand | "help";
  args: string[];
}

/** Commands surfaced by `--help`. Hidden (`__`-prefixed) commands are omitted;
 * `version` is appended because the router handles it like any command while
 * `--version`/`-v` are special-cased in `parseCli`. */
export function renderUsage(): string {
  const visible = Object.keys(CLI_ROUTER.commands).filter((name) => !name.startsWith("__"));
  return [
    "red-skills-dev — RedSkills dev runtime (AFK engine host CLI; the castle MCP is the canonical interface)",
    "",
    "Usage:",
    "  red-skills-dev <command> [args]",
    "  red-skills-dev --version | -v",
    "  red-skills-dev --help | -h",
    "",
    "Commands:",
    ...visible.map((name) => `  ${name}`),
    "",
    "A bare flag-led invocation (e.g. `--issues 42`, `--runner codex --once`) is the",
    "legacy default-/afk interface and forwards to `run`. `--help` never does (#2581).",
    "",
  ].join("\n");
}

/** True when this argv asks for help. A leading `help`/`--help`/`-h` always is;
 * a `--help`/`-h` anywhere in a flag-led (default-`run`) invocation also is,
 * because the run surface has no help of its own and must never boot a worker
 * drain for a usage request (#2581). Explicit subcommands keep owning their own
 * `--help` handling (fleet, manager). */
function isHelpInvocation(argv: readonly string[]): boolean {
  const first = argv[0];
  if (first === "help" || first === "--help" || first === "-h") return true;
  const flagLed = first === undefined || first.startsWith("-") || first === "run";
  return flagLed && argv.some((a) => a === "--help" || a === "-h");
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

export function parseCli(argv: readonly string[]): ParsedCli {
  if (argv[0] === "--version" || argv[0] === "-v") return { command: "version", args: argv.slice(1) };
  // Help short-circuits BEFORE routing: the flag-led fallthrough to the `run`
  // default must never swallow a usage request into a live worker drain (#2581).
  if (isHelpInvocation(argv)) return { command: "help", args: [] };
  return routeCommand(argv, CLI_ROUTER);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    if (error instanceof UnknownCommandError) {
      process.stderr.write(`[afk] ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  if (parsed.command === "help") {
    process.stdout.write(renderUsage());
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
