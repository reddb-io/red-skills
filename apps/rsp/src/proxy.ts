import { spawn } from "node:child_process";
import { appendTelemetryEvent, RSP_DECISIONS_COLLECTION, RSP_TELEMETRY_INVOCATIONS_COLLECTION } from "./telemetry.js";

export interface ProxyRunOptions {
  telemetryRoot: string;
}

export async function runProxy(argv: readonly string[], options: ProxyRunOptions): Promise<number> {
  let commandLine = "";
  const started = process.hrtime.bigint();
  try {
    commandLine = parseProxyCommandLine(argv);
    if (process.env.RSP_PROXY_FAIL_INTERNAL === "1") throw new Error("forced proxy failure");
  } catch (err) {
    if (commandLine) {
      await appendProxyFailedOpen(options.telemetryRoot, commandLine, err);
      return await runShellVerbatim(commandLine);
    }
    throw err;
  }

  const status = await runShellVerbatim(commandLine);
  const wrapperMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  await appendTelemetryEvent(options.telemetryRoot, {
    collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
    ts: new Date().toISOString(),
    command: commandLine,
    wrapper: "proxy",
    loss: "lossless",
    elided: false,
    raw_bytes: 0,
    emitted_bytes: 0,
    wrapper_ms: wrapperMs,
    accounting_recorded: false,
  });
  return status;
}

export function parseProxyCommandLine(argv: readonly string[]): string {
  if (argv[0] !== "proxy") throw new Error("expected rsp proxy -- <command line>");
  const separator = argv.indexOf("--");
  const parts = separator >= 0 ? argv.slice(separator + 1) : argv.slice(1);
  const commandLine = parts.length === 1 ? parts[0]! : parts.join(" ");
  if (!commandLine.trim()) throw new Error("usage: rsp proxy -- <command line>");
  return commandLine;
}

async function appendProxyFailedOpen(rootDir: string, command: string, err: unknown): Promise<void> {
  await appendTelemetryEvent(rootDir, {
    collection: RSP_DECISIONS_COLLECTION,
    event_type: "decision",
    ts: new Date().toISOString(),
    hook: "proxy",
    command,
    command_family: commandFamily(command),
    decision: "failed-open",
    reason: "proxy-internal-error",
    error: err instanceof Error ? err.name : typeof err,
  });
}

async function runShellVerbatim(commandLine: string): Promise<number> {
  const child = spawn(commandLine, { shell: true, stdio: "inherit" });
  return await new Promise((resolve) => {
    child.on("error", (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      resolve(127);
    });
    child.on("close", (status, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        resolve(128);
        return;
      }
      resolve(status ?? 0);
    });
  });
}

function commandFamily(command: string): string {
  const parts = command.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "unknown";
  if (parts[0] === "git" && parts[1]) return `git ${parts[1]}`;
  if (parts[0] === "gh" && parts[1] && parts[2]) return `gh ${parts[1]} ${parts[2]}`;
  if (parts[0] === "gh" && parts[1]) return `gh ${parts[1]}`;
  if (parts[0] === "cargo" && parts[1]) return `cargo ${parts[1]}`;
  if (parts[0] === "vitest") return "vitest";
  return parts[0]!;
}
