import { spawn } from "node:child_process";
import { runCompletedChild, type CompletedStdoutTransform } from "./completed-boundary.js";

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
  | { kind: "argv"; argv: string[]; level: FastBoundaryLossLevel }
  | { kind: "shell"; commandLine: string; level: FastBoundaryLossLevel };

export type FastBoundaryLossLevel = "lossless" | "brief" | "terse" | "full";

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
  if (first === "--full" || first === "--brief" || first === "--terse") {
    if (argv[1] !== "--" || !argv[2]) return null;
    return { kind: "argv", argv: [...argv.slice(2)], level: first.slice(2) as FastBoundaryLossLevel };
  }
  if (!first || first.startsWith("-")) {
    if (first !== "--" || !argv[1]) return null;
    return { kind: "argv", argv: [...argv.slice(1)], level: "lossless" };
  }
  if (first === "proxy") {
    if (process.env.RSP_PROXY_FAIL_INTERNAL === "1") return null;
    const separator = argv.indexOf("--");
    const proxyFlags = separator >= 0 ? argv.slice(1, separator) : [];
    if (proxyFlags.some((flag) => flag !== "--full" && flag !== "--brief" && flag !== "--terse")) return null;
    const commandParts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
    if (commandParts.length !== 1 || !commandParts[0]?.trim()) return null;
    const commandLine = commandParts[0];
    if (mayUseSpecializedProxyExecutor(commandLine)) return null;
    const level = proxyFlags.includes("--terse")
      ? "terse"
      : proxyFlags.includes("--brief")
        ? "brief"
        : proxyFlags.includes("--full")
          ? "full"
          : "lossless";
    return { kind: "shell", commandLine, level };
  }
  if (RSP_COMMANDS.has(first)) return null;
  return { kind: "argv", argv: [...argv], level: "lossless" };
}

export async function runFastBoundary(
  invocation: FastBoundaryInvocation,
  transform?: CompletedStdoutTransform,
): Promise<number> {
  const child = invocation.kind === "argv"
    ? spawn(invocation.argv[0]!, invocation.argv.slice(1), { stdio: ["inherit", "pipe", "pipe"] })
    : spawn(invocation.commandLine, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  return await runCompletedChild(child, transform);
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
