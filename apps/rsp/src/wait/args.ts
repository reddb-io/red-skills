/**
 * args.ts — parsing and validating `rsp wait` invocations.
 *
 * Validation happens HERE, before any process is spawned or any registry entry
 * is written, so a malformed invocation fails as a clean indeterminate result
 * rather than half-starting a wait. The one piece of state captured at parse
 * time is the signal target's process identity: pinning it early is what lets
 * delivery detect PID reuse an hour later.
 */
import { constants as osConstants } from "node:os";
import {
  DEFAULT_CAPTURE_BYTES,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TERMINATE_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  type ParsedWait,
  type WaitOptions,
} from "./model.js";
import { pidAlive, pidStartTime } from "./process-tree.js";

export async function parseWaitArgs(argv: readonly string[]): Promise<ParsedWait> {
  const kind = argv[1];
  const options: WaitOptions = {
    timeoutMs: DEFAULT_TIMEOUT_MS.cmd,
    reason: "",
    signal: "SIGUSR1",
    notifyTimeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
    terminateGraceMs: DEFAULT_TERMINATE_GRACE_MS,
    probeTimeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
    format: "toon",
    captureBytes: DEFAULT_CAPTURE_BYTES,
  };
  const parsed: ParsedWait = { kind: kind as ParsedWait["kind"], options };
  if (!kind || kind === "--help" || kind === "-h") return { ...parsed, kind: "help" };
  if (kind !== "ls" && kind !== "cmd" && kind !== "pr" && kind !== "run" && kind !== "job" && kind !== "release") {
    return { ...parsed, kind: undefined };
  }
  if (kind !== "ls") options.timeoutMs = DEFAULT_TIMEOUT_MS[kind];

  // Everything after `--` is the command line, never an option to this parser.
  const commandSeparator = argv.indexOf("--");
  const optionEnd = commandSeparator >= 0 ? commandSeparator : argv.length;
  for (let i = 2; i < optionEnd; i++) {
    const value = argv[i];
    if (value === "--timeout") options.timeoutMs = parseDuration(argv[++i] ?? "");
    else if (value === "--reason") options.reason = argv[++i] ?? "";
    else if (value === "--signal-pid") options.signalPid = Number(argv[++i]);
    else if (value === "--signal") options.signal = normalizeSignal(argv[++i] ?? "");
    else if (value === "--notify-cmd") options.notifyCmd = argv[++i] ?? "";
    else if (value === "--notify-timeout") options.notifyTimeoutMs = parseDuration(argv[++i] ?? "");
    else if (value === "--terminate-grace") options.terminateGraceMs = parseDuration(argv[++i] ?? "");
    else if (value === "--probe-timeout") options.probeTimeoutMs = parseDuration(argv[++i] ?? "");
    else if (value === "--result-file") options.resultFile = argv[++i] ?? "";
    else if (value === "--json") options.format = "json";
    else if (value === "--capture-bytes") options.captureBytes = parsePositiveInteger(argv[++i] ?? "", "capture bytes");
    else if (kind === "run" && value === "--branch") parsed.branch = argv[++i] ?? "";
    else if (kind === "run" && value === "--latest") parsed.latest = true;
    else if (kind === "release" && value === "--tag") parsed.tagGlob = argv[++i] ?? "";
    else if (kind === "release" && value === "--existing") parsed.existing = true;
    else if (!value.startsWith("--") && !parsed.target) parsed.target = value;
  }
  await validateCompletionOptions(options);
  if (kind === "cmd") parsed.commandLine = commandSeparator >= 0 ? argv.slice(commandSeparator + 1).join(" ") : "";
  return parsed;
}

/**
 * Reject a wait that could never deliver, and pin the signal target's identity.
 *
 * Failing here is much better than failing after an hour of polling: the caller
 * learns immediately that its `--signal-pid` was wrong, rather than sleeping
 * through a wait that was never going to wake it.
 */
async function validateCompletionOptions(options: WaitOptions): Promise<void> {
  if (!(options.signal in osConstants.signals)) throw new Error(`invalid signal: ${options.signal}`);
  if (options.signalPid !== undefined) {
    if (!Number.isSafeInteger(options.signalPid) || options.signalPid <= 0) {
      throw new Error(`invalid signal pid: ${options.signalPid}`);
    }
    if (!pidAlive(options.signalPid)) throw new Error(`signal pid is not running: ${options.signalPid}`);
    options.signalPidStartTime = await pidStartTime(options.signalPid);
  }
  if (options.resultFile !== undefined && !options.resultFile.trim()) throw new Error("invalid result file: empty path");
}

/** `500ms`, `30s`, `45m`, `2h`, or a bare millisecond count. */
export function parseDuration(value: string): number {
  const match = /^([1-9][0-9]*)(ms|s|m|h)?$/.exec(value);
  if (!match) throw new Error(`invalid timeout: ${value}`);
  const n = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (unit === "ms") return n;
  if (unit === "s") return n * 1_000;
  if (unit === "m") return n * 60_000;
  return n * 60 * 60_000;
}

/** An env override for a tuning knob; a malformed value falls back silently. */
export function envDuration(name: string, fallbackMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = env[name];
  if (!value) return fallbackMs;
  try {
    return parseDuration(value);
  } catch {
    return fallbackMs;
  }
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return Number(value);
}

/** Accept both `USR1` and `SIGUSR1`; the validator rejects anything unreal. */
export function normalizeSignal(value: string): NodeJS.Signals {
  return (value.startsWith("SIG") ? value : `SIG${value}`) as NodeJS.Signals;
}
