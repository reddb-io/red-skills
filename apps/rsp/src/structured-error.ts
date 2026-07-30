import { GITHUB_QUOTA_REMEDY, isGithubQuotaText } from "@reddb-io/shared/github-quota.js";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";

/**
 * `transient` is a failure that clears on its own — a GitHub quota window
 * resetting, not anything the operator must repair. It exits non-zero like a
 * `real-error`, but its help describes the wait instead of a fix (#2830).
 */
export type RspErrorCategory = "usage" | "real-error" | "transient" | "no-op";

export interface RspStructuredErrorOptions {
  command: string;
  category: RspErrorCategory;
  error: string;
  help: string;
  exitCode?: 0 | 1 | 2;
  validFlags?: readonly string[];
  diagnostics?: string;
}

export function structuredExitCode(category: RspErrorCategory): 0 | 1 | 2 {
  if (category === "no-op") return 0;
  if (category === "usage") return 2;
  // `transient` joins `real-error` at 1: the command still failed, so the caller
  // must not treat it as success — only the remedy differs.
  return 1;
}

export function renderStructuredError(options: RspStructuredErrorOptions): Buffer {
  return Buffer.from(`${encode(structuredErrorPayload(options))}\n`);
}

export function structuredErrorPayload(options: RspStructuredErrorOptions): JsonObject {
  const payload: JsonObject = {
    command: options.command,
    category: options.category,
    exit_code: options.exitCode ?? structuredExitCode(options.category),
    error: options.error,
    help: [options.help] as JsonValue,
  };
  if (options.validFlags && options.validFlags.length > 0) payload.valid_flags = [...options.validFlags] as JsonValue;
  if (options.diagnostics) payload.diagnostics = firstLines(options.diagnostics, 3);
  return payload;
}

export function renderNoop(command: string, summary: string, help: string): Buffer {
  const payload: JsonObject = {
    command,
    category: "no-op",
    exit_code: 0,
    noop: true,
    summary,
    help: [help] as JsonValue,
  };
  return Buffer.from(`${encode(payload)}\n`);
}

export function classifyWrappedFailure(command: string, stdout: string, stderr: string): RspStructuredErrorOptions {
  const diagnostics = [stderr, stdout].find((text) => text.trim()) ?? "";
  const normalized = diagnostics.trim();
  const lower = normalized.toLowerCase();
  // Quota first: GitHub's rate-limit bodies advertise that "authenticated
  // requests get a higher rate limit", so an auth-keyed match would claim them
  // and send the operator to inspect a token that is perfectly fine.
  if (/\bgh\b/.test(command) && isGithubQuotaText(normalized)) {
    return {
      command,
      category: "transient",
      error: firstLine(normalized) || "GitHub API rate limit exceeded",
      help: GITHUB_QUOTA_REMEDY,
      diagnostics: normalized,
    };
  }
  if (/\bgh\b/.test(command) && (lower.includes("gh_token") || lower.includes("not logged in") || lower.includes("authentication"))) {
    return {
      command,
      category: "real-error",
      error: firstLine(normalized) || "GitHub authentication failed",
      help: "gh auth login",
      diagnostics: normalized,
    };
  }
  if (lower.includes("not a git repository")) {
    return {
      command,
      category: "real-error",
      error: firstLine(normalized) || "not a git repository",
      help: "git status",
      diagnostics: normalized,
    };
  }
  if (lower.includes("repository not found") || lower.includes("could not resolve host")) {
    return {
      command,
      category: "real-error",
      error: firstLine(normalized) || "repository is unavailable",
      help: command.startsWith("gh ") ? "gh repo view" : "git remote -v",
      diagnostics: normalized,
    };
  }
  return {
    command,
    category: "real-error",
    error: firstLine(normalized) || "command failed",
    help: `${command} --help`,
    diagnostics: normalized,
  };
}

export function renderUnknownFlag(command: string, flag: string, validFlags: readonly string[], help: string): Buffer {
  return renderStructuredError({
    command,
    category: "usage",
    error: `unknown flag: ${flag}`,
    help,
    validFlags,
  });
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function firstLines(text: string, maxLines: number): string {
  return text.split(/\r?\n/).slice(0, maxLines).join("\n").trim();
}
