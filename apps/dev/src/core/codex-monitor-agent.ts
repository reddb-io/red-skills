export type CodexMonitorAgentMode = "run" | "fleet";
export type CodexMonitorAgentLaunchCommand = CodexMonitorAgentMode | "monitor" | "dashboard" | "statusline" | "other";

export type CodexMonitorAgentDecisionReason =
  | "spawn"
  | "not-codex-runner"
  | "subagent-unavailable"
  | "command-does-not-launch-worker"
  | "single-supervised-run"
  | "boot-only";

export interface CodexMonitorAgentDecisionInput {
  runner: string;
  command: CodexMonitorAgentLaunchCommand;
  subagentAvailable: boolean;
  once?: boolean;
  bootOnly?: boolean;
}

export interface CodexMonitorAgentDecision {
  spawn: boolean;
  reason: CodexMonitorAgentDecisionReason;
}

export interface CodexMonitorAgentPromptOptions {
  projectRoot: string;
  mode?: CodexMonitorAgentMode;
  intervalSeconds?: number;
  monitorCommand?: string;
}

export const DEFAULT_CODEX_MONITOR_INTERVAL_SECONDS = 30;

/**
 * The castle `status {scope: worker}` intent is the canonical read (ADR 0120/0134); this CLI
 * invocation is the no-MCP fallback for hosts that cannot reach the MCP.
 */
export const DEFAULT_CODEX_MONITOR_COMMAND =
  "env RED_AFK_RUNNER=codex red-skills-dev monitor --once";

function normalizedRunner(runner: string): string {
  return runner.trim().toLowerCase();
}

export function decideCodexMonitorAgent(input: CodexMonitorAgentDecisionInput): CodexMonitorAgentDecision {
  if (normalizedRunner(input.runner) !== "codex") return { spawn: false, reason: "not-codex-runner" };
  if (!input.subagentAvailable) return { spawn: false, reason: "subagent-unavailable" };
  if (input.command !== "run" && input.command !== "fleet") {
    return { spawn: false, reason: "command-does-not-launch-worker" };
  }
  if (input.once) return { spawn: false, reason: "single-supervised-run" };
  if (input.bootOnly) return { spawn: false, reason: "boot-only" };
  return { spawn: true, reason: "spawn" };
}

export function renderCodexMonitorAgentPrompt(options: CodexMonitorAgentPromptOptions): string {
  const mode = options.mode ?? "run";
  const intervalSeconds = options.intervalSeconds ?? DEFAULT_CODEX_MONITOR_INTERVAL_SECONDS;
  const monitorCommand = options.monitorCommand ?? DEFAULT_CODEX_MONITOR_COMMAND;

  return [
    "You are the read-only Codex AFK monitor agent.",
    "",
    `Project root: ${options.projectRoot}`,
    `AFK launch mode: ${mode}`,
    "",
    "Purpose: keep AFK progress visible in the Codex UI while the main session continues working.",
    "",
    "Loop:",
    `1. Every ${intervalSeconds} seconds, read live state from the castle MCP: call the castle \`status\` tool with \`scope: worker\` for normalized worker state, vitals, and monitor inputs.`,
    "   The castle `monitor` tool and `worker_vitals` remain answering deprecation aliases for that scoped status read; treat them as compatibility surface, not the primary route.",
    "2. When the castle MCP is not reachable from this host, say so once, then use the no-MCP fallback from the project root:",
    `   ${monitorCommand}`,
    "3. Report a concise progress update when live worker state changes, when a worker becomes stale/wedged, or at least every five minutes.",
    "4. Exit once there is no live .red/tmp/supervisors/default/afk-supervisor.pid and the worker status read has no [live] or [quiet] workers.",
    "5. If the status read fails three times in a row, report the failure and exit.",
    "",
    "Hard read-only rules:",
    "- Do not edit files.",
    "- Do not run /dev:afk run, /dev:afk fleet, /dev:afk fleet stop, /dev:afk reap, /dev:afk requeue, /retake, /hitl, or /triage.",
    "- Do not claim issues, edit labels, comment on issues, open PRs, merge, push, run validation suites, or stop workers.",
    "- Do not repair state. Only observe and report.",
    "",
    "Allowed actions:",
    "- Call the read-only castle `status` tool above, or the fallback command when the MCP is unreachable.",
    "- Use read-only process/file checks such as ps, test -f, cat, tail, and ls when needed to decide whether to exit.",
    "- Summarize worker id, issue number, runner, stage, live/stale/wedged state, duration, and diffstat.",
  ].join("\n") + "\n";
}
