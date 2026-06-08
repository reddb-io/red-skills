// commands/route-model-tier.ts — the IO half of the interactive model-tier
// routing hook (issue #456, ADR 0049).
//
// Wired as a Claude Code PreToolUse hook on the subagent-dispatch tool
// (`Task`/`Agent`) via plugins/dev/hooks/claude.hooks.json. The hook pipes the
// PreToolUse payload to this command on stdin; the command resolves the project
// `.red/config.yaml`, asks the PURE decision in core/model-tier-route.ts how to
// route the dispatch, and prints the host's PreToolUse response on stdout.
//
// It is best-effort and never wedges a dispatch: any error (no stdin, malformed
// payload, no config) prints `{}` (no change) and exits 0.
//
// Invocation: `node bin/afk.mjs route-model-tier [--host claude|codex]` with the
// PreToolUse JSON on stdin.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "../core/config.js";
import {
  routeModelTier,
  type EnforcementCapability,
  type PreToolUseInput,
  type RouteAction,
} from "../core/model-tier-route.js";

function readStdin(stdin: NodeJS.ReadableStream & { isTTY?: boolean }): Promise<string> {
  return new Promise((resolve) => {
    if (stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    stdin.on("end", done);
    stdin.on("error", done);
    stdin.on("close", done);
  });
}

function parsePayload(text: string): PreToolUseInput {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as PreToolUseInput) : {};
  } catch {
    return {};
  }
}

/** The cwd a PreToolUse payload carries, if any (Claude sends `cwd`). */
interface PayloadDirs {
  cwd?: unknown;
  workspace?: { current_dir?: unknown };
}

function payloadCwd(payload: PreToolUseInput): string | undefined {
  const p = payload as PayloadDirs;
  const dir = p.workspace?.current_dir ?? p.cwd;
  return typeof dir === "string" && dir.length > 0 ? dir : undefined;
}

/**
 * Find the project `.red/config.yaml` by walking up from `start`. Returns the
 * first existing config path, or the `start/.red/config.yaml` candidate (which
 * `loadConfig` resolves to all-defaults when absent — the correct degrade).
 */
export function resolveConfigPath(start: string): string {
  let dir = start;
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, ".red", "config.yaml");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(start, ".red", "config.yaml");
}

/**
 * Serialize a `RouteAction` into a Claude Code PreToolUse response.
 *
 *  - `noop`    → `{}` (no change; normal permission flow).
 *  - `rewrite` → `hookSpecificOutput.updatedInput` applies the corrected model;
 *                a `systemMessage` surfaces the routing to the operator.
 *  - `block`   → `permissionDecision: "deny"` so the orchestrator retries.
 *  - `audit`   → `permissionDecision: "allow"` + the reason as a nudge.
 */
export function renderClaudeDecision(action: RouteAction): Record<string, unknown> {
  if (action.kind === "noop") return {};
  if (action.kind === "rewrite") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: action.updatedInput,
      },
      systemMessage: `[model-tier] routed to ${action.tier} (${action.model}). ${action.reason}`,
    };
  }
  if (action.kind === "block") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: action.reason,
      },
    };
  }
  // audit
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: action.reason,
    },
  };
}

function parseHost(args: string[]): "claude" | "codex" {
  const i = args.indexOf("--host");
  if (i >= 0 && args[i + 1] === "codex") return "codex";
  return "claude";
}

/**
 * `route-model-tier [--host claude|codex]` — read a PreToolUse payload on
 * stdin, decide the routing against `.red/config.yaml`, and print the host
 * response. Claude enforces via rewrite (path a). Codex degrades to a safe
 * no-op audit until its per-task subagent-with-model capability lands (#457).
 */
export async function routeModelTierCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<number> {
  const host = parseHost(args);
  const text = await readStdin(stdin);
  const payload = parsePayload(text);

  // Codex cannot yet rewrite a per-task subagent model (#457). Until it can,
  // never enforce on Codex: emit no change. The Claude path rewrites in place.
  if (host === "codex") {
    stdout.write("{}\n");
    return 0;
  }

  const root = payloadCwd(payload) ?? cwd;
  const configPath = resolveConfigPath(root);
  const config = loadConfig(configPath, { warn: () => undefined });

  const capability: EnforcementCapability = "rewrite";
  const action = routeModelTier(payload, config, capability);
  stdout.write(`${JSON.stringify(renderClaudeDecision(action))}\n`);
  return 0;
}
