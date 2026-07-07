export type AutoMonitorCommand = "run" | "fleet" | "monitor" | "other";

export type AutoMonitorDecision =
  | { action: "schedule-full-render-cron"; cron: string; prompt: string; reason: "statusline-absent" }
  | { action: "schedule-reactive-check"; cron: string; prompt: string; reason: "reactive-loop-requested" }
  | {
      action: "skip";
      reason:
        | "rich-statusline-present"
        | "command-does-not-launch-worker"
        | "single-supervised-run"
        | "cron-unavailable"
        | "non-claude-runner";
    };

export interface AutoMonitorDecisionInput {
  runner: string;
  command: AutoMonitorCommand;
  cronAvailable: boolean;
  richStatuslinePresent: boolean;
  once?: boolean;
  reactiveLoopRequested?: boolean;
}

export const AUTO_MONITOR_CRON = "*/10 * * * *";
export const FULL_RENDER_MONITOR_PROMPT = "/dev:afk monitor";
export const REACTIVE_MONITOR_PROMPT = "rtk env RED_AFK_REACTIVE_CHECK=1 red-skills-dev monitor --reactive-check";

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

export function decideAutoMonitorLoop(input: AutoMonitorDecisionInput): AutoMonitorDecision {
  const commandLaunchesWorker = input.command === "run" || input.command === "fleet";
  if (!commandLaunchesWorker) return { action: "skip", reason: "command-does-not-launch-worker" };
  if (input.once) return { action: "skip", reason: "single-supervised-run" };
  if (normalized(input.runner) !== "claude") return { action: "skip", reason: "non-claude-runner" };
  if (!input.cronAvailable) return { action: "skip", reason: "cron-unavailable" };

  if (input.richStatuslinePresent) {
    if (input.reactiveLoopRequested) {
      return {
        action: "schedule-reactive-check",
        cron: AUTO_MONITOR_CRON,
        prompt: REACTIVE_MONITOR_PROMPT,
        reason: "reactive-loop-requested",
      };
    }
    return { action: "skip", reason: "rich-statusline-present" };
  }

  return {
    action: "schedule-full-render-cron",
    cron: AUTO_MONITOR_CRON,
    prompt: FULL_RENDER_MONITOR_PROMPT,
    reason: "statusline-absent",
  };
}

export function hasRichClaudeStatusline(settingsJson: string | null | undefined): boolean {
  if (!settingsJson) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsJson);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  const statusLine = (parsed as { statusLine?: unknown }).statusLine;
  if (statusLine === null || typeof statusLine !== "object") return false;
  const rec = statusLine as { type?: unknown; command?: unknown };
  if (rec.type !== undefined && rec.type !== "command") return false;
  if (typeof rec.command !== "string") return false;
  return isRedSkillsStatuslineCommand(rec.command);
}

export function isRedSkillsStatuslineCommand(command: string): boolean {
  const c = command.toLowerCase();
  if (!/\bstatusline\b/.test(c)) return false;
  return c.includes("red-skills") || c.includes("redskills") || c.includes("dev-");
}
