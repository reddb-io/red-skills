import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  commandFamily,
  commandSegments,
  isEnvAssignment,
  isGhJsonJqSelection,
  shellishWords,
} from "./command-classifier.js";
import { resolveRspConfig, type RspRuntimeConfig } from "./config.js";
import {
  kickResidentServer,
  resolveResidentPaths,
} from "./resident-client.js";
import { reportResidentEntryDiagnostic } from "./resident-store.js";
import { resolveRspInvocationPrefix } from "./rsp-cli.js";
import {
  appendTelemetryEvent,
  RSP_DECISIONS_COLLECTION,
  type RspTelemetryEvent,
} from "./telemetry.js";

export interface RspWrapperCapability {
  id: string;
  command: readonly string[];
  wrapper: readonly string[];
}

export type RewriteDecision =
  | { kind: "rewrite"; command: string; capabilityId: string }
  | { kind: "passthrough"; reason?: string };

type HookPayloadParse =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

type HookDecisionResult = {
  decision: RewriteDecision;
  telemetryRoot: string;
  event: RspTelemetryEvent;
};

type ShellToken = {
  text: string;
  quoted: boolean;
};

type ParsedSimpleCommand = {
  tokens: ShellToken[];
  redirectSuffix: ShellToken[];
};

export interface HookDecisionOptions {
  cwd: string;
  isEnabled?: (cwd: string) => boolean | Promise<boolean>;
  isResidentHealthy?: (cwd: string) => boolean | Promise<boolean>;
  wakeResident?: (cwd: string) => void | Promise<void>;
  rewrite?: (command: string) => RewriteDecision;
  resolveBinary?: () => boolean;
  rspInvocationPrefix?: string[];
}

let _cachedBinaryResolved: boolean | undefined;
let _binaryHintEmitted = false;

export function _testOnlyResetBinaryState(): void {
  _cachedBinaryResolved = undefined;
  _binaryHintEmitted = false;
}

function resolveRspBinaryFromPath(): boolean {
  const dirs = (process.env.PATH ?? "").split(":");
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      accessSync(`${dir}/rsp`, constants.X_OK);
      return true;
    } catch {
      // not in this dir
    }
  }
  return false;
}

function resolveBinaryOnce(resolver: () => boolean): boolean {
  if (_cachedBinaryResolved === undefined) {
    _cachedBinaryResolved = resolver();
  }
  return _cachedBinaryResolved;
}

function emitBinaryHint(): void {
  if (_binaryHintEmitted) return;
  _binaryHintEmitted = true;
  process.stderr.write(
    "rsp: entrypoint not found on PATH; run `rsp setup` to provision. See apps/rsp/docs/TROUBLESHOOTING.md\n",
  );
}

export const RSP_WRAPPER_CAPABILITIES: readonly RspWrapperCapability[] = [
  { id: "git:status", command: ["git", "status"], wrapper: ["git", "status"] },
  { id: "git:log", command: ["git", "log"], wrapper: ["git", "log"] },
  { id: "git:diff", command: ["git", "diff"], wrapper: ["git", "diff"] },
  { id: "git:commit", command: ["git", "commit"], wrapper: ["git", "commit"] },
  { id: "git:push", command: ["git", "push"], wrapper: ["git", "push"] },
  { id: "git:blame", command: ["git", "blame"], wrapper: ["git", "blame"] },
  { id: "git:branch:av", command: ["git", "branch", "-av"], wrapper: ["git", "branch", "-av"] },
  { id: "git:show", command: ["git", "show"], wrapper: ["git", "show"] },
  { id: "gh:pr:list", command: ["gh", "pr", "list"], wrapper: ["gh", "pr", "list"] },
  { id: "gh:pr:view", command: ["gh", "pr", "view"], wrapper: ["gh", "pr", "view"] },
  { id: "gh:issue:list", command: ["gh", "issue", "list"], wrapper: ["gh", "issue", "list"] },
  { id: "gh:issue:view", command: ["gh", "issue", "view"], wrapper: ["gh", "issue", "view"] },
  { id: "gh:run:list", command: ["gh", "run", "list"], wrapper: ["gh", "run", "list"] },
  { id: "gh:run:view", command: ["gh", "run", "view"], wrapper: ["gh", "run", "view"] },
  { id: "gh:issues:batch", command: ["gh", "issues"], wrapper: ["gh", "issues"] },
  { id: "gh:prs:batch", command: ["gh", "prs"], wrapper: ["gh", "prs"] },
  { id: "gh:edit-labels:batch", command: ["gh", "edit-labels"], wrapper: ["gh", "edit-labels"] },
  { id: "gh:link-sub-issues:batch", command: ["gh", "link-sub-issues"], wrapper: ["gh", "link-sub-issues"] },
  { id: "vitest", command: ["vitest"], wrapper: ["vitest"] },
  { id: "vitest:run", command: ["vitest", "run"], wrapper: ["vitest", "run"] },
  { id: "cargo:test", command: ["cargo", "test"], wrapper: ["cargo", "test"] },
];

const DEFAULT_REWRITE_TABLE = rewriteTableFromCapabilities(RSP_WRAPPER_CAPABILITIES);
const LOSSLESS_GH_JSON_JQ_REASON = "lossless-gh-json-jq";

export function rewriteTableFromCapabilities(capabilities: readonly RspWrapperCapability[]): Map<string, readonly string[]> {
  const table = new Map<string, readonly string[]>();
  for (const entry of capabilities) table.set(commandKey(entry.command), ["rsp", ...entry.wrapper]);
  return table;
}

export function rewriteCommand(command: string, rspPrefix: string[] = resolveRspInvocationPrefix()): RewriteDecision {
  const losslessGh = losslessGhJsonJqPassthrough(command);
  if (losslessGh) return losslessGh;

  const parsed = parseCertainSimpleCommand(command);
  if (!parsed) return rewriteCompoundCommand(command, rspPrefix);
  const tokens = parsed.tokens.map((token) => token.text);
  if (tokens.length > 0 && isEnvAssignment(tokens[0]!)) return rewriteCompoundCommand(command, rspPrefix);

  const fileRead = rewriteFileReadCommand(parsed, rspPrefix);
  if (fileRead) return fileRead;

  if (parsed.tokens.some((token) => token.quoted)) return rewriteCompoundCommand(command, rspPrefix);

  const capability = [...RSP_WRAPPER_CAPABILITIES]
    .sort((left, right) => right.command.length - left.command.length)
    .find((entry) => tokensStartWith(tokens, entry.command));
  if (!capability) return rewriteCompoundCommand(command, rspPrefix);
  const rewritten = [...rspPrefix, ...capability.wrapper, ...tokens.slice(capability.command.length)];
  const redirectSuffix = formatRedirectSuffix(parsed.redirectSuffix);
  return {
    kind: "rewrite",
    command: [...rewritten.map(shellQuoteIfNeeded), ...redirectSuffix].join(" "),
    capabilityId: capability.id,
  };
}

function rewriteFileReadCommand(parsed: ParsedSimpleCommand, rspPrefix: string[]): RewriteDecision | null {
  const tokens = parsed.tokens.map((token) => token.text);
  const command = tokens[0];
  const redirectSuffix = formatRedirectSuffix(parsed.redirectSuffix);
  const prefix = rspPrefix.map(shellQuoteIfNeeded);
  if (command === "cat" && tokens.length === 2 && isPlainFileToken(tokens[1]!)) {
    return { kind: "rewrite", command: [...prefix, "cat", shellQuoteIfNeeded(tokens[1]!), ...redirectSuffix].join(" "), capabilityId: "cat:file" };
  }
  if ((command === "head" || command === "tail") && tokens.length === 2 && isPlainFileToken(tokens[1]!)) {
    return { kind: "rewrite", command: [...prefix, "cat", `--${command}`, "10", shellQuoteIfNeeded(tokens[1]!), ...redirectSuffix].join(" "), capabilityId: `cat:${command}` };
  }
  if (
    (command === "head" || command === "tail") &&
    tokens.length === 4 &&
    tokens[1] === "-n" &&
    /^[1-9][0-9]*$/.test(tokens[2]!) &&
    isPlainFileToken(tokens[3]!)
  ) {
    return { kind: "rewrite", command: [...prefix, "cat", `--${command}`, tokens[2]!, shellQuoteIfNeeded(tokens[3]!), ...redirectSuffix].join(" "), capabilityId: `cat:${command}` };
  }
  if (
    (command === "head" || command === "tail") &&
    tokens.length === 3 &&
    /^-[1-9][0-9]*$/.test(tokens[1]!) &&
    isPlainFileToken(tokens[2]!)
  ) {
    return { kind: "rewrite", command: [...prefix, "cat", `--${command}`, tokens[1]!.slice(1), shellQuoteIfNeeded(tokens[2]!), ...redirectSuffix].join(" "), capabilityId: `cat:${command}` };
  }
  return null;
}

function isPlainFileToken(token: string): boolean {
  return Boolean(token) && !token.startsWith("-");
}

export async function hookDecisionFromClaudePreExecJson(
  raw: string,
  options: HookDecisionOptions,
): Promise<RewriteDecision> {
  return await hookDecisionFromPreExecJson(raw, options);
}

export async function hookDecisionFromCodexPreExecJson(
  raw: string,
  options: HookDecisionOptions,
): Promise<RewriteDecision> {
  return await hookDecisionFromPreExecJson(raw, options);
}

async function hookDecisionFromPreExecJson(
  raw: string,
  options: HookDecisionOptions,
): Promise<RewriteDecision> {
  return (await hookDecisionResultFromPreExecJson(raw, options, "pre-exec")).decision;
}

async function hookDecisionResultFromPreExecJson(
  raw: string,
  options: HookDecisionOptions,
  hook: string,
): Promise<HookDecisionResult> {
  const parsed = parseJsonRecord(raw);
  if (!parsed.ok) {
    const decision: RewriteDecision = { kind: "passthrough", reason: parsed.reason };
    return {
      decision,
      telemetryRoot: options.cwd,
      event: hookDecisionEvent({ hook, command: "", decision, reason: parsed.reason }),
    };
  }
  const payload = parsed.payload;
  const cwd = stringAt(payload, ["cwd"]) || stringAt(payload, ["tool_input", "cwd"]) || options.cwd;
  const enabled = await (options.isEnabled ?? isRspHookEnabled)(cwd);
  if (!enabled) {
    const decision: RewriteDecision = { kind: "passthrough", reason: "disabled" };
    return {
      decision,
      telemetryRoot: cwd,
      event: hookDecisionEvent({ hook, command: extractHookCommand(payload), decision, reason: "disabled" }),
    };
  }

  const command = extractHookCommand(payload);
  if (!command) {
    const decision: RewriteDecision = { kind: "passthrough", reason: "missing-command" };
    return {
      decision,
      telemetryRoot: cwd,
      event: hookDecisionEvent({ hook, command, decision, reason: "missing-command" }),
    };
  }
  const rspPrefix = options.rspInvocationPrefix ?? resolveRspInvocationPrefix();
  const binaryResolved = resolveBinaryOnce(
    options.resolveBinary
      ?? (() => options.rspInvocationPrefix !== undefined || rspPrefix[0] !== "rsp" || resolveRspBinaryFromPath()),
  );
  if (!binaryResolved) {
    emitBinaryHint();
    const decision: RewriteDecision = { kind: "passthrough", reason: "binary-unresolved" };
    return {
      decision,
      telemetryRoot: cwd,
      event: hookDecisionEvent({ hook, command, decision, reason: "binary-unresolved" }),
    };
  }

  const started = process.hrtime.bigint();
  const config = resolveRspConfig(cwd, process.env);
  const decision = config.proxyEnabled
    ? proxyCommand(command, rspPrefix)
    : (options.rewrite ?? ((cmd: string) => rewriteCommand(cmd, rspPrefix)))(command);
  const decisionMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (decision.kind !== "rewrite") {
    const passed = decision.reason ? decision : { ...decision, reason: "unsupported-command" };
    return {
      decision: passed,
      telemetryRoot: cwd,
      event: hookDecisionEvent({ hook, command, decision: passed, reason: passed.reason ?? "unsupported-command", decisionMs }),
    };
  }

  await wakeResidentForRewrite(cwd, options.wakeResident ?? wakeRspResident);
  return {
    decision,
    telemetryRoot: cwd,
    event: hookDecisionEvent({
      hook,
      command,
      decision,
      reason: decision.capabilityId === "proxy:universal" ? "universal-proxy" : "matched-capability",
      decisionMs,
    }),
  };
}

export function formatHookDecision(decision: RewriteDecision): { stdout: string; status: number } {
  if (decision.kind === "rewrite") return formatUpdatedInputDecision(decision.command);
  return { stdout: "", status: 0 };
}

export function formatCodexHookDecision(decision: RewriteDecision): { stdout: string; status: number } {
  if (decision.kind === "rewrite") return formatUpdatedInputDecision(decision.command);
  return { stdout: "", status: 0 };
}

function formatUpdatedInputDecision(command: string): { stdout: string; status: number } {
  return {
    stdout: `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command },
      },
    })}\n`,
    status: 0,
  };
}

export async function runClaudePreExecHook(stdinPath?: string): Promise<number> {
  let raw = "";
  try {
    raw = stdinPath ? readFileSync(stdinPath, "utf8") : readFileSync(0, "utf8");
    const result = await hookDecisionResultFromPreExecJson(raw, { cwd: process.cwd() }, "claude-pre-exec");
    recordHookDecision(result.telemetryRoot, result.event);
    const decision = result.decision;
    debugHookDecision("claude-pre-exec", decision);
    const formatted = formatHookDecision(decision);
    if (formatted.stdout) process.stdout.write(formatted.stdout);
    return formatted.status;
  } catch (err) {
    recordHookDecision(process.cwd(), failedOpenHookEvent("claude-pre-exec", raw, err));
    debugHookException("claude-pre-exec", err);
    return 0;
  }
}

export async function runCodexPreExecHook(stdinPath?: string): Promise<number> {
  let raw = "";
  try {
    raw = stdinPath ? readFileSync(stdinPath, "utf8") : readFileSync(0, "utf8");
    const result = await hookDecisionResultFromPreExecJson(raw, { cwd: process.cwd() }, "codex-pre-exec");
    recordHookDecision(result.telemetryRoot, result.event);
    const decision = result.decision;
    debugHookDecision("codex-pre-exec", decision);
    const formatted = formatCodexHookDecision(decision);
    if (formatted.stdout) process.stdout.write(formatted.stdout);
    return formatted.status;
  } catch (err) {
    recordHookDecision(process.cwd(), failedOpenHookEvent("codex-pre-exec", raw, err));
    debugHookException("codex-pre-exec", err);
    return 0;
  }
}

function recordHookDecision(rootDir: string, event: RspTelemetryEvent): void {
  appendTelemetryEvent(rootDir, event).catch(() => undefined);
}

function hookDecisionEvent(input: {
  hook: string;
  command: string;
  decision: RewriteDecision;
  reason: string;
  decisionMs?: number;
}): RspTelemetryEvent {
  const command = input.command.trim();
  const capabilityId = input.decision.kind === "rewrite" ? input.decision.capabilityId : undefined;
  return {
    collection: RSP_DECISIONS_COLLECTION,
    event_type: "decision",
    ts: new Date().toISOString(),
    hook: input.hook,
    command: command || "unknown",
    command_family: commandFamily(command),
    decision: capabilityId ? "contributed" : "passed",
    reason: input.reason,
    capability_id: capabilityId,
    decision_ms: input.decisionMs,
  };
}

function failedOpenHookEvent(hook: string, raw: string, err: unknown): RspTelemetryEvent {
  const parsed = parseJsonRecord(raw);
  const command = parsed.ok ? extractHookCommand(parsed.payload) : "";
  return {
    collection: RSP_DECISIONS_COLLECTION,
    event_type: "decision",
    ts: new Date().toISOString(),
    hook,
    command: command || "unknown",
    command_family: commandFamily(command),
    decision: "failed-open",
    reason: "hook-exception",
    error: errorLabel(err),
  };
}

function isRspHookEnabled(cwd: string): boolean {
  return resolveRspConfig(cwd, process.env).enabled;
}

async function wakeRspResident(cwd: string): Promise<void> {
  const config = resolveRspConfig(cwd, process.env);
  if (!config.enabled) return;
  if (!storeIsProvisioned(config)) return;
  const paths = resolveResidentPaths(cwd);
  await kickResidentServer(paths, toResidentConfig(config));
}

async function wakeResidentForRewrite(
  cwd: string,
  wakeResident: (cwd: string) => void | Promise<void>,
): Promise<void> {
  try {
    await Promise.resolve(wakeResident(cwd));
  } catch (err) {
    debugHookWakeFailure(err);
  }
}

function debugHookDecision(hook: string, decision: RewriteDecision): void {
  if (process.env.RSP_DEBUG !== "1") return;
  if (decision.kind === "rewrite") {
    process.stderr.write(`rsp hook ${hook}: rewrite ${decision.capabilityId}\n`);
    return;
  }
  process.stderr.write(`rsp hook ${hook}: passthrough ${decision.reason ?? "unsupported-command"}\n`);
}

function debugHookException(hook: string, err: unknown): void {
  if (process.env.RSP_DEBUG !== "1") return;
  process.stderr.write(`rsp hook ${hook}: exception ${errorLabel(err)}\n`);
}

/**
 * A wake that failed is debug-only noise — except when the host cannot resolve
 * an rsp entry at all. That one always says its name (#2736), and the command
 * still runs raw.
 */
function debugHookWakeFailure(err: unknown): void {
  if (reportResidentEntryDiagnostic(err)) return;
  if (process.env.RSP_DEBUG !== "1") return;
  process.stderr.write(`rsp hook pre-exec: resident-wake-failed ${errorLabel(err)}\n`);
}

function errorLabel(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return typeof err;
}

function toResidentConfig(config: RspRuntimeConfig) {
  return {
    storeUri: config.storeUri,
    ttlDays: config.ttlDays,
    ephemeralTtlHours: config.ephemeralTtlHours,
    byteBudget: config.byteBudget,
    telemetryTtlDays: config.telemetryTtlDays,
    telemetryByteBudget: config.telemetryByteBudget,
    telemetryDrainIntervalMs: config.telemetryDrainIntervalMs,
    telemetryDrainTimeoutMs: config.telemetryDrainTimeoutMs,
    idleMs: config.idleMs,
  };
}

function storeIsProvisioned(config: RspRuntimeConfig): boolean {
  if (!config.storeUri.startsWith("file://")) return true;
  try {
    return existsSync(fileURLToPath(config.storeUri));
  } catch {
    return false;
  }
}

function extractHookCommand(payload: Record<string, unknown>): string {
  return (
    stringAt(payload, ["tool_input", "command"]) ||
    stringAt(payload, ["tool_input", "cmd"]) ||
    stringAt(payload, ["tool_input", "args", "command"]) ||
    stringAt(payload, ["input", "command"]) ||
    stringAt(payload, ["input", "cmd"]) ||
    stringAt(payload, ["arguments", "command"]) ||
    stringAt(payload, ["arguments", "cmd"]) ||
    stringAt(payload, ["command"]) ||
    stringAt(payload, ["cmd"])
  );
}

function parseCertainSimpleCommand(command: string): ParsedSimpleCommand | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/[\n\r|;()$`]/.test(trimmed)) return null;
  const tokens = shellTokens(trimmed);
  if (tokens.length === 0) return null;
  if (tokens[0]?.quoted) return null;
  if (tokens.some((token) => /[()$`]/.test(token.text))) return null;
  if (tokens.some((token) => token.text.includes("=") && isEnvAssignment(token.text))) return null;
  const commandTokens: ShellToken[] = [];
  const redirectSuffix: ShellToken[] = [];
  for (const token of tokens) {
    if (token.text.includes(">") || token.text.includes("<")) {
      if (token.quoted || (token.text !== "2>/dev/null" && token.text !== "2>&1")) return null;
      redirectSuffix.push(token);
      continue;
    }
    commandTokens.push(token);
  }
  if (commandTokens.length === 0) return null;
  return { tokens: commandTokens, redirectSuffix };
}

function shellTokens(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let text = "";
  let quoted = false;
  let quote: "'" | "\"" | null = null;

  const push = () => {
    if (!text && !quoted) return;
    tokens.push({ text, quoted });
    text = "";
    quoted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === "\"" && ch === "\\" && index + 1 < command.length) {
        index += 1;
        text += command[index]!;
        continue;
      }
      text += ch;
      continue;
    }
    if (ch === "'" || ch === "\"") {
      quote = ch;
      quoted = true;
      continue;
    }
    if (ch === "\\" && index + 1 < command.length) {
      index += 1;
      text += command[index]!;
      continue;
    }
    if (/[ \t]/.test(ch)) {
      push();
      continue;
    }
    text += ch;
  }

  if (quote) return [];
  push();
  return tokens;
}

function tokensStartWith(tokens: readonly string[], prefix: readonly string[]): boolean {
  if (tokens.length < prefix.length) return false;
  return prefix.every((token, index) => tokens[index] === token);
}

function losslessGhJsonJqPassthrough(command: string): RewriteDecision | null {
  const tokens = shellTokens(command.trim()).map((token) => token.text);
  if (!isGhJsonJqSelection(tokens)) return null;
  return { kind: "passthrough", reason: LOSSLESS_GH_JSON_JQ_REASON };
}

function formatRedirectSuffix(tokens: readonly ShellToken[]): string[] {
  return tokens.map((token) => token.text);
}

function shellQuoteIfNeeded(value: string): string {
  return /[^\w@%+=:,./-]/.test(value) ? shellSingleQuote(value) : value;
}

function proxyCommand(command: string, rspPrefix: string[]): RewriteDecision {
  const reason = universalProxyPassthroughReason(command);
  if (reason) return { kind: "passthrough", reason };
  const prefixStr = rspPrefix.map(shellQuoteIfNeeded).join(" ");
  return {
    kind: "rewrite",
    command: `${prefixStr} proxy -- ${shellSingleQuote(command.trim())}`,
    capabilityId: "proxy:universal",
  };
}

function isRspBundledCommand(command: string): boolean {
  if (!process.argv[1]) return false;
  const tokens = shellTokens(command);
  return tokens[0]?.text === process.execPath && tokens[1]?.text === process.argv[1];
}

function universalProxyPassthroughReason(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return "missing-command";
  if (hasSingleAmpersand(trimmed)) return "background";
  if (/\b(?:RSP_NO_PROXY|RED_SKILLS_RSP_NO_PROXY)=1\b/.test(trimmed)) return "opt-out";
  const first = shellishWords(commandSegments(trimmed)[0] ?? "")[0];
  if (first === "rsp") return "opt-out";
  if (isRspBundledCommand(trimmed)) return "opt-out";
  if (first && INTERACTIVE_COMMANDS.has(first)) return "interactive";
  return undefined;
}

function rewriteCompoundCommand(command: string, rspPrefix: string[]): RewriteDecision {
  const trimmed = command.trim();
  if (!isSafeNoisyCompoundCommand(trimmed)) return { kind: "passthrough" };
  const prefixStr = rspPrefix.map(shellQuoteIfNeeded).join(" ");
  return {
    kind: "rewrite",
    command: `${prefixStr} exec -- ${shellSingleQuote(trimmed)}`,
    capabilityId: "exec:compound",
  };
}

function isSafeNoisyCompoundCommand(command: string): boolean {
  if (!command) return false;
  if (!hasCompoundOperator(command)) return false;
  if (!hasKnownNoisyFamily(command)) return false;
  if (hasSingleAmpersand(command)) return false;
  if (/<<-?/.test(command)) return false;
  if (/\$\(|`/.test(command)) return false;
  if (/[<>]/.test(command)) return false;
  if (containsCommandWord(command, "rsp")) return false;
  if (containsAnyCommandWord(command, INTERACTIVE_COMMANDS)) return false;
  if (containsQuietGrep(command)) return false;
  return true;
}

const INTERACTIVE_COMMANDS = new Set([
  "bash",
  "fish",
  "htop",
  "less",
  "more",
  "nano",
  "node",
  "python",
  "python3",
  "ssh",
  "top",
  "vi",
  "vim",
  "zsh",
]);

function hasCompoundOperator(command: string): boolean {
  return /&&|[;|]/.test(command);
}

function hasSingleAmpersand(command: string): boolean {
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] !== "&") continue;
    if (command[index - 1] === "&" || command[index + 1] === "&") continue;
    if (command[index - 1] === ">" || command[index + 1] === ">") continue;
    return true;
  }
  return false;
}

function hasKnownNoisyFamily(command: string): boolean {
  return commandSegments(command).some((segment) => {
    const tokens = shellishWords(segment);
    if (tokens.length === 0) return false;
    if (tokens[0] === "git") return ["log", "diff", "show", "blame"].includes(tokens[1] ?? "");
    if (tokens[0] === "gh") return tokens.some((token, index) => index > 0 && (token === "list" || token === "view"));
    if (tokens[0] === "vitest") return true;
    return tokens[0] === "cargo" && tokens[1] === "test";
  });
}

function containsAnyCommandWord(command: string, words: ReadonlySet<string>): boolean {
  return commandSegments(command).some((segment) => {
    const first = shellishWords(segment)[0];
    return first ? words.has(first) : false;
  });
}

function containsCommandWord(command: string, word: string): boolean {
  return containsAnyCommandWord(command, new Set([word]));
}

function containsQuietGrep(command: string): boolean {
  return commandSegments(command).some((segment) => {
    const tokens = shellishWords(segment);
    return tokens[0] === "grep" && tokens.includes("-q");
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandKey(tokens: readonly string[]): string {
  return tokens.join("\0");
}

function parseJsonRecord(raw: string): HookPayloadParse {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? { ok: true, payload: parsed } : { ok: false, reason: "payload-not-object" };
  } catch {
    return { ok: false, reason: "payload-parse-error" };
  }
}

function stringAt(record: Record<string, unknown>, path: readonly string[]): string {
  let cursor: unknown = record;
  for (const key of path) {
    if (!isRecord(cursor)) return "";
    cursor = cursor[key];
  }
  return typeof cursor === "string" ? cursor : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
