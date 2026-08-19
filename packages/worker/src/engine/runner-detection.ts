import { isRunner, type Runner, type RunnerDetection } from "./runner-types.js";

export interface DetectRunnerInput {
  flag?: string;
  env?: NodeJS.ProcessEnv;
  processTree?: string;
  scriptPath?: string;
  fallback?: string;
}

const CLAUDE_ENV_KEYS = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"];
const CODEX_ENV_KEYS = ["CODEX_HOME", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED", "CODEX_MANAGED_BY_NPM"];

function envHasAny(env: NodeJS.ProcessEnv, keys: string[]): string | undefined {
  return keys.find((key) => env[key] !== undefined && env[key] !== "");
}

export function runnerFromExplicitEnv(value: string | undefined): Runner | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isRunner(value)) throw new Error(`unsupported runner: ${value}`);
  return value;
}

function runnerFromFallback(value: string | undefined): Runner {
  return value && isRunner(value) ? value : "claude";
}

export function detectRunner(input: DetectRunnerInput = {}): RunnerDetection {
  const env = input.env ?? process.env;
  if (input.flag) {
    if (!isRunner(input.flag)) throw new Error(`unsupported runner: ${input.flag}`);
    return { runner: input.flag, method: "flag", detail: "--runner" };
  }

  const explicitEnvRunner = runnerFromExplicitEnv(env.RED_AFK_RUNNER);
  if (explicitEnvRunner) return { runner: explicitEnvRunner, method: "env-var", detail: "RED_AFK_RUNNER" };

  const claudeKey = envHasAny(env, CLAUDE_ENV_KEYS);
  if (claudeKey) return { runner: "claude", method: "env-var", detail: claudeKey };
  const codexKey = envHasAny(env, CODEX_ENV_KEYS);
  if (codexKey) return { runner: "codex", method: "env-var", detail: codexKey };

  const tree = input.processTree?.toLowerCase() ?? "";
  if (/claude(\s|$|-|_)|claude-code/.test(tree)) return { runner: "claude", method: "process" };
  if (/codex(\s|$|-|_)|openai-codex/.test(tree)) return { runner: "codex", method: "process" };

  const scriptPath = input.scriptPath ?? "";
  if (scriptPath.includes("/.claude/")) return { runner: "claude", method: "path" };
  if (scriptPath.includes("/.codex/")) return { runner: "codex", method: "path" };

  const fallback = input.fallback;
  return { runner: runnerFromFallback(fallback), method: "env-fallback", detail: fallback ?? "claude" };
}

export function parseRunnerFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--runner") return args[i + 1];
    if (arg.startsWith("--runner=")) return arg.slice("--runner=".length);
  }
  return undefined;
}
