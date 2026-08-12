import { spawn } from "node:child_process";

const RSP_COMMANDS = new Set([
  "dashboard",
  "stats",
  "gains",
  "show",
  "git",
  "gh",
  "vitest",
  "cargo",
  "cat",
  "exec",
  "wait",
  "doctor",
  "status",
  "sweep",
  "setup",
  "mcp",
  "shell-init",
  "server",
  "warm-resident",
  "gh-api-json",
  "hook",
]);

export type FastBoundaryInvocation =
  | { kind: "argv"; argv: string[] }
  | { kind: "shell"; commandLine: string };

/**
 * Resolve only the paths that require no RSP-owned work.
 *
 * This module deliberately imports nothing from config, telemetry, the store,
 * or the resident. Unknown argv can therefore cross the boundary before the
 * rest of RSP is loaded. A proxy command stays on this path only when it cannot
 * contain one of the specialized executors; ambiguous input is left to the
 * full proxy, which in turn fails open to the original shell string.
 */
export function resolveFastBoundary(argv: readonly string[]): FastBoundaryInvocation | null {
  const first = argv[0];
  if (!first || first.startsWith("-")) {
    if (first !== "--" || !argv[1]) return null;
    return { kind: "argv", argv: [...argv.slice(1)] };
  }
  if (first === "proxy") {
    if (process.env.RSP_PROXY_FAIL_INTERNAL === "1") return null;
    const separator = argv.indexOf("--");
    const commandParts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
    if (commandParts.length !== 1 || !commandParts[0]?.trim()) return null;
    const commandLine = commandParts[0];
    if (mayUseSpecializedProxyExecutor(commandLine)) return null;
    return { kind: "shell", commandLine };
  }
  if (RSP_COMMANDS.has(first)) return null;
  return { kind: "argv", argv: [...argv] };
}

export async function runFastBoundary(invocation: FastBoundaryInvocation): Promise<number> {
  const child = invocation.kind === "argv"
    ? spawn(invocation.argv[0]!, invocation.argv.slice(1), { stdio: "inherit" })
    : spawn(invocation.commandLine, { shell: true, stdio: "inherit" });
  return await new Promise((resolve) => {
    child.once("error", (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      resolve(127);
    });
    child.once("close", (status, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        resolve(128);
        return;
      }
      resolve(status ?? 0);
    });
  });
}

export async function tryRunFastBoundary(argv: readonly string[]): Promise<number | null> {
  const invocation = resolveFastBoundary(argv);
  return invocation ? await runFastBoundary(invocation) : null;
}

function mayUseSpecializedProxyExecutor(commandLine: string): boolean {
  // This is intentionally a conservative load decision, not a shell parser.
  // False positives only take the established full proxy path; false negatives
  // are avoided for every capability the proxy can currently contribute.
  return /(?:^|&&|\|\||[;|])\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+|env)\s+)*(?:git\s+(?:status|log|diff|show|blame|branch\s+-av)(?:\s|$)|gh\s+(?:pr|issue|run)\s+(?:list|view)(?:\s|$)|vitest(?:\s|$)|cargo\s+test(?:\s|$)|(?:cat|head|tail)\s+)/.test(commandLine);
}
