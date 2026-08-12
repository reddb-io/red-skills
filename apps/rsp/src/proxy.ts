import { spawn } from "node:child_process";
import { startChildProcessTimer } from "./overhead-budget.js";
import { runCompletedChild } from "./completed-boundary.js";
import { commandFamily, isEnvAssignment, isGhJsonJqSelection } from "./command-classifier.js";
import { resolveRspInvocationPrefix } from "./rsp-cli.js";
import { renderStructuredBoundary } from "./structured-boundary.js";
import { appendTelemetryEvent, RSP_DECISIONS_COLLECTION, RSP_TELEMETRY_INVOCATIONS_COLLECTION } from "./telemetry.js";

function shellQuoteIfNeeded(value: string): string {
  return /[^\w@%+=:,./-]/.test(value) ? `'${value.replace(/'/g, "'\\''")}'` : value;
}

export interface ProxyRunOptions {
  telemetryRoot: string;
  level?: ProxyLossLevel;
}

export type ProxyLossLevel = "lossless" | "brief" | "terse";

export interface ProxySegmentMatch {
  command: string;
  commandFamily: string;
  decision: "contributed" | "passed";
  reason: string;
  capabilityId?: string;
}

interface ShellSegmentPart {
  kind: "segment";
  text: string;
}

interface ShellOperatorPart {
  kind: "operator";
  text: string;
}

type ShellPart = ShellSegmentPart | ShellOperatorPart;

interface ShellWord {
  raw: string;
  value: string;
}

export async function runProxy(argv: readonly string[], options: ProxyRunOptions): Promise<number> {
  let commandLine = "";
  let routedCommandLine = "";
  let segmentMatches: ProxySegmentMatch[] = [];
  const started = process.hrtime.bigint();
  try {
    commandLine = parseProxyCommandLine(argv);
    if (process.env.RSP_PROXY_FAIL_INTERNAL === "1") throw new Error("forced proxy failure");
    const rewritten = rewriteProxyCommandLine(commandLine, options.level ?? "lossless");
    routedCommandLine = rewritten.commandLine;
    segmentMatches = rewritten.matches;
  } catch (err) {
    if (commandLine) {
      await appendProxyFailedOpen(options.telemetryRoot, commandLine, err);
      return await runShellVerbatim(commandLine);
    }
    throw err;
  }

  for (const match of segmentMatches) {
    await appendProxySegmentDecision(options.telemetryRoot, match);
  }
  const status = await runShellVerbatim(routedCommandLine || commandLine);
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

export function rewriteProxyCommandLine(commandLine: string, level: ProxyLossLevel = "lossless", rspPrefix: string[] = resolveRspInvocationPrefix()): {
  commandLine: string;
  matches: ProxySegmentMatch[];
} {
  const parts = splitShellParts(commandLine);
  const matches: ProxySegmentMatch[] = [];
  const rewritten = parts.map((part, index) => {
    if (part.kind === "operator") return part.text;
    if (nextOperator(parts, index) === "|") return part.text;
    const rewrittenSegment = rewriteProxySegment(part.text, level, rspPrefix);
    if (!rewrittenSegment) return part.text;
    matches.push(rewrittenSegment.match);
    return rewrittenSegment.text;
  }).join("");
  return { commandLine: rewritten, matches };
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

async function appendProxySegmentDecision(rootDir: string, match: ProxySegmentMatch): Promise<void> {
  await appendTelemetryEvent(rootDir, {
    collection: RSP_DECISIONS_COLLECTION,
    event_type: "decision",
    ts: new Date().toISOString(),
    hook: "proxy",
    command: match.command,
    command_family: match.commandFamily,
    decision: match.decision,
    reason: match.reason,
    capability_id: match.capabilityId,
  });
}

async function runShellVerbatim(commandLine: string): Promise<number> {
  const child = spawn(commandLine, { shell: true, stdio: ["inherit", "pipe", "pipe"] });
  // The wrapped command's own runtime is never rsp's overhead (#2746).
  const stopChildTimer = startChildProcessTimer();
  child.once("close", stopChildTimer);
  child.once("error", stopChildTimer);
  return await runCompletedChild(child, renderStructuredBoundary);
}

function rewriteProxySegment(segment: string, level: ProxyLossLevel, rspPrefix: string[]): { text: string; match: ProxySegmentMatch } | null {
  const leading = segment.match(/^\s*/)?.[0] ?? "";
  const trailing = segment.match(/\s*$/)?.[0] ?? "";
  const core = segment.trim();
  if (!core) return null;
  const words = parseShellWords(core);
  if (!words) return null;
  const commandStart = commandWordStart(words);
  if (commandStart >= words.length) return null;
  const commandWords = words.slice(commandStart);
  const commandValues = commandWords.map((word) => word.value);
  if (isGhJsonJqSelection(commandValues)) {
    return {
      text: segment,
      match: {
        command: commandWords.map((word) => word.raw).join(" "),
        commandFamily: commandFamily(commandValues.join(" ")),
        decision: "passed",
        reason: "lossless-gh-json-jq",
      },
    };
  }
  const match = matchProxyCapability(commandWords);
  if (!match) return null;

  const prefix = words.slice(0, commandStart).map((word) => word.raw);
  const loss = level === "lossless" ? [] : [`--${level}`];
  const rewrittenCore = [...prefix, ...rspPrefix.map(shellQuoteIfNeeded), ...loss, ...match.wrapperWords].join(" ");
  return {
    text: `${leading}${rewrittenCore}${trailing}`,
    match: {
      command: commandWords.map((word) => word.raw).join(" "),
      commandFamily: commandFamily(commandValues.join(" ")),
      decision: "contributed",
      reason: "proxy-segment",
      capabilityId: match.capabilityId,
    },
  };
}

function matchProxyCapability(words: readonly ShellWord[]): { capabilityId: string; wrapperWords: string[] } | null {
  const values = words.map((word) => word.value);
  const raw = words.map((word) => word.raw);
  if (values[0] === "git" && ["status", "log", "diff", "show", "blame"].includes(values[1] ?? "")) {
    return { capabilityId: `git:${values[1]}`, wrapperWords: raw };
  }
  if (values[0] === "git" && values[1] === "branch" && values[2] === "-av") {
    return { capabilityId: "git:branch:av", wrapperWords: raw };
  }
  if (values[0] === "gh" && ["pr", "issue", "run"].includes(values[1] ?? "") && ["list", "view"].includes(values[2] ?? "")) {
    return { capabilityId: `gh:${values[1]}:${values[2]}`, wrapperWords: raw };
  }
  if (values[0] === "vitest") {
    return { capabilityId: values[1] === "run" ? "vitest:run" : "vitest", wrapperWords: raw };
  }
  if (values[0] === "cargo" && values[1] === "test") {
    return { capabilityId: "cargo:test", wrapperWords: raw };
  }
  return matchFileDumpCapability(values, raw);
}

function matchFileDumpCapability(values: readonly string[], raw: readonly string[]): { capabilityId: string; wrapperWords: string[] } | null {
  if (values[0] === "cat" && values.length === 2 && isPlainFileValue(values[1]!)) {
    return { capabilityId: "cat:file", wrapperWords: ["cat", raw[1]!] };
  }
  if ((values[0] === "head" || values[0] === "tail") && values.length === 2 && isPlainFileValue(values[1]!)) {
    return { capabilityId: `cat:${values[0]}`, wrapperWords: ["cat", `--${values[0]}`, "10", raw[1]!] };
  }
  if (
    (values[0] === "head" || values[0] === "tail") &&
    values.length === 4 &&
    values[1] === "-n" &&
    /^[1-9][0-9]*$/.test(values[2]!) &&
    isPlainFileValue(values[3]!)
  ) {
    return { capabilityId: `cat:${values[0]}`, wrapperWords: ["cat", `--${values[0]}`, values[2]!, raw[3]!] };
  }
  return null;
}

function isPlainFileValue(value: string): boolean {
  return Boolean(value) && !value.startsWith("-");
}

function commandWordStart(words: readonly ShellWord[]): number {
  let index = 0;
  while (index < words.length && isEnvAssignment(words[index]!.value)) index += 1;
  if (words[index]?.value !== "env") return index;
  index += 1;
  while (index < words.length && isEnvAssignment(words[index]!.value)) index += 1;
  return index;
}

function nextOperator(parts: readonly ShellPart[], index: number): string | undefined {
  for (let cursor = index + 1; cursor < parts.length; cursor += 1) {
    if (parts[cursor]!.kind === "operator") return parts[cursor]!.text;
  }
  return undefined;
}

function splitShellParts(commandLine: string): ShellPart[] {
  const parts: ShellPart[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const op = operatorAt(commandLine, index);
    if (!op) continue;
    if (index > start) parts.push({ kind: "segment", text: commandLine.slice(start, index) });
    parts.push({ kind: "operator", text: op });
    index += op.length - 1;
    start = index + 1;
  }
  if (start < commandLine.length) parts.push({ kind: "segment", text: commandLine.slice(start) });
  return parts;
}

function operatorAt(commandLine: string, index: number): string | undefined {
  const two = commandLine.slice(index, index + 2);
  if (two === "&&" || two === "||") return two;
  const one = commandLine[index];
  return one === ";" || one === "|" ? one : undefined;
}

function parseShellWords(segment: string): ShellWord[] | null {
  const words: ShellWord[] = [];
  let raw = "";
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let inWord = false;

  const push = () => {
    if (!inWord) return;
    words.push({ raw, value });
    raw = "";
    value = "";
    inWord = false;
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index]!;
    if (escaped) {
      raw += char;
      value += char;
      escaped = false;
      inWord = true;
      continue;
    }
    if (char === "\\") {
      raw += char;
      escaped = true;
      inWord = true;
      continue;
    }
    if (quote) {
      raw += char;
      if (char === quote) quote = undefined;
      else value += char;
      inWord = true;
      continue;
    }
    if (char === "'" || char === '"') {
      raw += char;
      quote = char;
      inWord = true;
      continue;
    }
    if (/[ \t]/.test(char)) {
      push();
      continue;
    }
    // Redirections remain raw shell tokens in the rewritten segment. The shell
    // continues to own their byte flow; rsp only prefixes the command argv.
    // Grouping and command substitution are not safely modeled here and keep
    // the original shell path unchanged.
    if (/[()`]/.test(char)) return null;
    raw += char;
    value += char;
    inWord = true;
  }
  if (quote || escaped) return null;
  push();
  return words;
}
