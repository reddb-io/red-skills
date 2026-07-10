import { readFileSync } from "node:fs";
import { resolveRspConfig } from "./config.js";

export interface RspWrapperCapability {
  id: string;
  command: readonly string[];
  wrapper: readonly string[];
}

export type RewriteDecision =
  | { kind: "rewrite"; command: string; capabilityId: string }
  | { kind: "passthrough"; reason?: string };

export interface HookDecisionOptions {
  cwd: string;
  isEnabled?: (cwd: string) => boolean | Promise<boolean>;
  rewrite?: (command: string) => RewriteDecision;
}

export const RSP_WRAPPER_CAPABILITIES: readonly RspWrapperCapability[] = [
  { id: "git:status", command: ["git", "status"], wrapper: ["git", "status"] },
  { id: "git:log", command: ["git", "log"], wrapper: ["git", "log"] },
  { id: "git:diff", command: ["git", "diff"], wrapper: ["git", "diff"] },
  { id: "git:commit", command: ["git", "commit"], wrapper: ["git", "commit"] },
  { id: "git:push", command: ["git", "push"], wrapper: ["git", "push"] },
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
  if (!tokens) return { kind: "passthrough" };
  if (tokens.length > 0 && isEnvAssignment(tokens[0]!)) return { kind: "passthrough" };

  const rewritten = DEFAULT_REWRITE_TABLE.get(commandKey(tokens));
  if (!rewritten) return { kind: "passthrough" };
  const capability = RSP_WRAPPER_CAPABILITIES.find((entry) => commandKey(entry.command) === commandKey(tokens));
  return {
    kind: "rewrite",
    command: rewritten.join(" "),
    capabilityId: capability?.id ?? commandKey(tokens),
  };
}

export async function hookDecisionFromClaudePreExecJson(
  raw: string,
  options: HookDecisionOptions,
): Promise<RewriteDecision> {
  const payload = parseJsonRecord(raw);
  const cwd = stringAt(payload, ["cwd"]) || stringAt(payload, ["tool_input", "cwd"]) || options.cwd;
  const enabled = await (options.isEnabled ?? isRspHookEnabled)(cwd);
  if (!enabled) return { kind: "passthrough", reason: "disabled" };

  const command = extractHookCommand(payload);
  if (!command) return { kind: "passthrough", reason: "missing-command" };
  return (options.rewrite ?? rewriteCommand)(command);
}

export function formatHookDecision(decision: RewriteDecision): { stdout: string; status: number } {
  if (decision.kind === "rewrite") return { stdout: `${decision.command}\n`, status: 0 };
  return { stdout: "", status: 1 };
}

export async function runClaudePreExecHook(stdinPath?: string): Promise<number> {
  const raw = stdinPath ? readFileSync(stdinPath, "utf8") : readFileSync(0, "utf8");
  const decision = await hookDecisionFromClaudePreExecJson(raw, { cwd: process.cwd() });
  const formatted = formatHookDecision(decision);
  if (formatted.stdout) process.stdout.write(formatted.stdout);
  return formatted.status;
}

function isRspHookEnabled(cwd: string): boolean {
  return resolveRspConfig(cwd, process.env).enabled;
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

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function commandKey(tokens: readonly string[]): string {
  return tokens.join("\0");
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
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
