import { homedir, hostname as osHostname, userInfo } from "node:os";
import { hostFingerprint } from "../core/host-identity.js";

const CLAUDE_SESSION_RE = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+/g;
const SECRET_KEY_RE = /(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|BEARER|COOKIE|SESSION|ANTHROPIC|OPENAI|MINIMAX|OPENROUTER|AWS_|GOOGLE_|SLACK_|NPM_|GH_|GITHUB_)/i;
const FALSEY_SECRET_VALUES = new Set(["true", "false", "null", "0", "1"]);

export interface ScrubOutboundOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  hostname?: string;
  username?: string;
  hostReplacement?: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function replaceLiteral(input: string, needle: string, replacement: string): string {
  if (!needle || needle === replacement || !input.includes(needle)) return input;
  return input.split(needle).join(replacement);
}

function validSecretValue(value: string | undefined): value is string {
  if (!value || value.length < 8) return false;
  return !FALSEY_SECRET_VALUES.has(value.trim().toLowerCase());
}

function envSecretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!SECRET_KEY_RE.test(key)) continue;
    if (validSecretValue(value)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function replaceTokenBoundary(input: string, token: string, replacement: string): string {
  if (token.length < 3 || token === replacement) return input;
  const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(token)}(?![A-Za-z0-9_-])`, "g");
  return input.replace(re, replacement);
}

function defaultHostReplacement(): string {
  try {
    return hostFingerprint();
  } catch {
    return "[REDACTED_HOST]";
  }
}

function scrubKeyValueSecrets(input: string): string {
  const key = String.raw`[A-Za-z0-9_.-]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH|BEARER|COOKIE|SESSION|ANTHROPIC|OPENAI|MINIMAX|OPENROUTER|AWS_|GOOGLE_|SLACK_|NPM_|GH_|GITHUB_)[A-Za-z0-9_.-]*`;
  const assignment = new RegExp(`\\b(${key})(\\s*=\\s*)([^\\s"'\\\`]+)`, "gi");
  const jsonish = new RegExp(`(["']?${key}["']?\\s*:\\s*["'])([^"'\\n\\r]{8,})(["'])`, "gi");
  return input
    .replace(assignment, (_m, name: string, sep: string, value: string) =>
      value === "[REDACTED_SECRET]" ? `${name}${sep}${value}` : `${name}${sep}[REDACTED_SECRET]`,
    )
    .replace(jsonish, (_m, prefix: string, value: string, suffix: string) =>
      value === "[REDACTED_SECRET]" ? `${prefix}${value}${suffix}` : `${prefix}[REDACTED_SECRET]${suffix}`,
    );
}

function scrubHomeIdentity(input: string, options: ScrubOutboundOptions): string {
  let out = input;
  const home = options.homeDir || homedir();
  out = replaceLiteral(out, "/home/cyber", "[REDACTED_HOME]");
  if (home) out = replaceLiteral(out, home, "[REDACTED_HOME]");
  out = out.replace(/\/home\/([A-Za-z0-9._-]+)\//g, "/home/[REDACTED_USER]/");
  out = out.replace(/\/Users\/([A-Za-z0-9._-]+)\//g, "/Users/[REDACTED_USER]/");
  return out;
}

export function scrubOutbound(value: unknown, options: ScrubOutboundOptions = {}): string {
  try {
    let out = typeof value === "string" ? value : String(value ?? "");
    out = out.replace(CLAUDE_SESSION_RE, "[REDACTED_CLAUDE_SESSION]");
    for (const secret of envSecretValues(options.env ?? process.env)) {
      out = replaceLiteral(out, secret, "[REDACTED_SECRET]");
    }
    out = scrubKeyValueSecrets(out);
    out = scrubHomeIdentity(out, options);

    const host = options.hostname ?? osHostname();
    out = replaceTokenBoundary(out, host, options.hostReplacement ?? defaultHostReplacement());
    let username = options.username;
    if (username === undefined) {
      try {
        username = userInfo().username;
      } catch {
        username = undefined;
      }
    }
    if (username) out = replaceTokenBoundary(out, username, "[REDACTED_USER]");
    return out;
  } catch {
    return typeof value === "string" ? value : String(value ?? "");
  }
}
