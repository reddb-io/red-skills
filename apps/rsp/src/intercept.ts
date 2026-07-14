import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveRspConfig, type RspRuntimeConfig } from "./config.js";
import {
  kickResidentServer,
  resolveResidentPaths,
} from "./resident-client.js";

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

export interface HookDecisionOptions {
  cwd: string;
  isEnabled?: (cwd: string) => boolean | Promise<boolean>;
  isResidentHealthy?: (cwd: string) => boolean | Promise<boolean>;
  wakeResident?: (cwd: string) => void | Promise<void>;
  rewrite?: (command: string) => RewriteDecision;
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
  { id: "vitest", command: ["vitest"], wrapper: ["vitest"] },
  { id: "vitest:run", command: ["vitest", "run"], wrapper: ["vitest", "run"] },
  { id: "cargo:test", command: ["cargo", "test"], wrapper: ["cargo", "test"] },
];

const DEFAULT_REWRITE_TABLE = rewriteTableFromCapabilities(RSP_WRAPPER_CAPABILITIES);

export function rewriteTableFromCapabilities(capabilities: readonly RspWrapperCapability[]): Map<string, readonly string[]> {
  const table = new Map<string, readonly string[]>();
  for (const entry of capabilities) table.set(commandKey(entry.command), ["rsp", ...entry.wrapper]);
  return table;
}

export function rewriteCommand(command: string): RewriteDecision {
  const tokens = tokenizeCertainSimpleCommand(command);
  if (!tokens) return rewriteCompoundCommand(command);
  if (tokens.length > 0 && isEnvAssignment(tokens[0]!)) return rewriteCompoundCommand(command);

  const fileRead = rewriteFileReadCommand(tokens);
  if (fileRead) return fileRead;

  const rewritten = DEFAULT_REWRITE_TABLE.get(commandKey(tokens));
  if (!rewritten) return rewriteCompoundCommand(command);
  const capability = RSP_WRAPPER_CAPABILITIES.find((entry) => commandKey(entry.command) === commandKey(tokens));
  return {
    kind: "rewrite",
    command: rewritten.join(" "),
    capabilityId: capability?.id ?? commandKey(tokens),
  };
}

function rewriteFileReadCommand(tokens: readonly string[]): RewriteDecision | null {
  const command = tokens[0];
  if (command === "cat" && tokens.length === 2 && isPlainFileToken(tokens[1]!)) {
    return { kind: "rewrite", command: `rsp cat ${tokens[1]}`, capabilityId: "cat:file" };
  }
  if ((command === "head" || command === "tail") && tokens.length === 2 && isPlainFileToken(tokens[1]!)) {
    return { kind: "rewrite", command: `rsp cat --${command} 10 ${tokens[1]}`, capabilityId: `cat:${command}` };
  }
  if (
    (command === "head" || command === "tail") &&
    tokens.length === 4 &&
    tokens[1] === "-n" &&
    /^[1-9][0-9]*$/.test(tokens[2]!) &&
    isPlainFileToken(tokens[3]!)
  ) {
    return { kind: "rewrite", command: `rsp cat --${command} ${tokens[2]} ${tokens[3]}`, capabilityId: `cat:${command}` };
  }
  return null;
}

function isPlainFileToken(token: string): boolean {
  return Boolean(token) && !token.startsWith("-") && !/[ \t]/.test(token);
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
  const parsed = parseJsonRecord(raw);
  if (!parsed.ok) return { kind: "passthrough", reason: parsed.reason };
  const payload = parsed.payload;
  const cwd = stringAt(payload, ["cwd"]) || stringAt(payload, ["tool_input", "cwd"]) || options.cwd;
  const enabled = await (options.isEnabled ?? isRspHookEnabled)(cwd);
  if (!enabled) return { kind: "passthrough", reason: "disabled" };

  const command = extractHookCommand(payload);
  if (!command) return { kind: "passthrough", reason: "missing-command" };
  const decision = (options.rewrite ?? rewriteCommand)(command);
  if (decision.kind !== "rewrite") return decision.reason ? decision : { ...decision, reason: "unsupported-command" };

  await wakeResidentForRewrite(cwd, options.wakeResident ?? wakeRspResident);
  return decision;
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
  try {
    const raw = stdinPath ? readFileSync(stdinPath, "utf8") : readFileSync(0, "utf8");
    const decision = await hookDecisionFromClaudePreExecJson(raw, { cwd: process.cwd() });
    debugHookDecision("claude-pre-exec", decision);
    const formatted = formatHookDecision(decision);
    if (formatted.stdout) process.stdout.write(formatted.stdout);
    return formatted.status;
  } catch (err) {
    debugHookException("claude-pre-exec", err);
    return 0;
  }
}

export async function runCodexPreExecHook(stdinPath?: string): Promise<number> {
  try {
    const raw = stdinPath ? readFileSync(stdinPath, "utf8") : readFileSync(0, "utf8");
    const decision = await hookDecisionFromCodexPreExecJson(raw, { cwd: process.cwd() });
    debugHookDecision("codex-pre-exec", decision);
    const formatted = formatCodexHookDecision(decision);
    if (formatted.stdout) process.stdout.write(formatted.stdout);
    return formatted.status;
  } catch (err) {
    debugHookException("codex-pre-exec", err);
    return 0;
  }
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

function debugHookWakeFailure(err: unknown): void {
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

function tokenizeCertainSimpleCommand(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (/[\n\r|&;()$<>`'"]/.test(trimmed)) return null;
  const tokens = trimmed.split(/[ \t]+/).filter(Boolean);
  if (tokens.length === 0) return null;
  if (tokens.some((token) => token.includes("=") && isEnvAssignment(token))) return null;
  return tokens;
}

function rewriteCompoundCommand(command: string): RewriteDecision {
  const trimmed = command.trim();
  if (!isSafeNoisyCompoundCommand(trimmed)) return { kind: "passthrough" };
  return {
    kind: "rewrite",
    command: `rsp exec -- ${shellSingleQuote(trimmed)}`,
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

function commandSegments(command: string): string[] {
  return command.split(/&&|[;|]/).map((segment) => segment.trim()).filter(Boolean);
}

function shellishWords(segment: string): string[] {
  return segment.split(/[ \t]+/).filter(Boolean).map((token) => token.replace(/^env$/, ""));
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
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
