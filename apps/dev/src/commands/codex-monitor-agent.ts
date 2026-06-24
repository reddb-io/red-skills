import { renderCodexMonitorAgentPrompt, type CodexMonitorAgentMode } from "../core/codex-monitor-agent.js";

export interface CodexMonitorAgentCommandOptions {
  projectRoot?: string;
  mode?: CodexMonitorAgentMode;
  intervalSeconds?: number;
  json?: boolean;
}

function parseMode(value: string): CodexMonitorAgentMode {
  if (value === "run" || value === "fleet") return value;
  throw new Error(`codex-monitor-agent --mode must be one of: run, fleet`);
}

function parsePositiveInteger(flag: string, value: string | undefined): number {
  if (!value) throw new Error(`codex-monitor-agent ${flag} requires a value`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`codex-monitor-agent ${flag} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(args: readonly string[]): CodexMonitorAgentCommandOptions {
  const out: CodexMonitorAgentCommandOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      out.json = true;
    } else if (arg === "--project-root") {
      const value = args[++i];
      if (!value) throw new Error("codex-monitor-agent --project-root requires a path");
      out.projectRoot = value;
    } else if (arg.startsWith("--project-root=")) {
      out.projectRoot = arg.slice("--project-root=".length);
    } else if (arg === "--mode") {
      const value = args[++i];
      if (!value) throw new Error("codex-monitor-agent --mode requires a value");
      out.mode = parseMode(value);
    } else if (arg.startsWith("--mode=")) {
      out.mode = parseMode(arg.slice("--mode=".length));
    } else if (arg === "--interval-seconds") {
      out.intervalSeconds = parsePositiveInteger("--interval-seconds", args[++i]);
    } else if (arg.startsWith("--interval-seconds=")) {
      out.intervalSeconds = parsePositiveInteger("--interval-seconds", arg.slice("--interval-seconds=".length));
    } else {
      throw new Error(`unknown codex-monitor-agent argument '${arg}'`);
    }
  }
  return out;
}

export async function codexMonitorAgentCommand(
  args: string[],
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const options = parseArgs(args);
  const projectRoot = options.projectRoot ?? process.cwd();
  const prompt = renderCodexMonitorAgentPrompt({
    projectRoot,
    mode: options.mode,
    intervalSeconds: options.intervalSeconds,
  });

  if (options.json) {
    stdout.write(`${JSON.stringify({
      projectRoot,
      mode: options.mode ?? "run",
      intervalSeconds: options.intervalSeconds,
      prompt,
    })}\n`);
    return 0;
  }

  stdout.write(prompt);
  return 0;
}
