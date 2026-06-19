// commands/statusline.ts — native port of scripts/statusline.sh (the /afk
// statusline aggregator for Claude Code).
//
// This is the IO half: it reads the Claude Code statusline JSON payload from
// stdin (cwd, model, effort, context window), resolves the project root, honours
// the per-project `.red/config.yaml` opt-out, reads the git branch, aggregates
// the live /afk worker state (with a 60 s GitHub-count cache), and feeds it all
// into the PURE renderer in core/statusline.ts. The render assembly itself —
// block order, optional-drop, ` · ` joins, token humanizing — lives entirely in
// core/statusline.ts and is exercised by tests/statusline.test.ts.
//
// Invocation: `node bin/afk.mjs statusline "<project-root>"` with the payload on
// stdin. The root arg wins when it is a real directory (wire it as
// `… statusline "$CLAUDE_PROJECT_DIR"`), else the payload's
// `.workspace.project_dir` (the fixed session root — survives `cd` into subdirs),
// else `.workspace.current_dir // .cwd`, else `process.cwd()`.

import { existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { renderStatusline, type ClaudeInput, type ProjectInput } from "../core/statusline.js";
import { loadConfig, getConfig } from "../core/config.js";
import { collectStatuslineAfk } from "../runtime/wire.js";
import * as gitx from "../runtime/git.js";

/** Read the entire stdin stream as a UTF-8 string (empty when there is none). */
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

interface ClaudePayload {
  workspace?: { project_dir?: string; current_dir?: string };
  cwd?: string;
  model?: { display_name?: string };
  effort?: { level?: string };
  context_window?: { total_input_tokens?: number; used_percentage?: number };
}

function parsePayload(text: string): ClaudePayload {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ClaudePayload) : {};
  } catch {
    return {};
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the project root: an explicit first-arg directory wins, then the
 * payload's `.workspace.project_dir` — the directory the Claude Code session was
 * STARTED in, which stays fixed as you `cd` into subdirectories — then the older
 * `.workspace.current_dir // .cwd` (which track the live cwd) as fallbacks, then
 * `cwd`. Preferring `project_dir` keeps the statusline anchored to the project
 * you opened: the basename, git ref, and AFK worker block (resolved under
 * `<root>/.red/tmp`) no longer change when you wander into a subdir.
 */
export function resolveRoot(rootArg: string | undefined, payload: ClaudePayload, fallback: string): string {
  if (rootArg && isDir(rootArg)) return rootArg;
  const fromPayload = payload.workspace?.project_dir || payload.workspace?.current_dir || payload.cwd;
  if (fromPayload) return fromPayload;
  return fallback;
}

/**
 * Per-project opt-out, mirroring statusline.sh: a top-level `statusline: false`
 * OR a nested `afk.statusline: false` in `.red/config.yaml` suppresses the line.
 * Returns true when the statusline should be emitted.
 */
export function statuslineEnabled(root: string): boolean {
  const configPath = join(root, ".red", "config.yaml");
  if (!existsSync(configPath)) return true;
  const cfg = loadConfig(configPath, { warn: () => undefined });
  if (getConfig(cfg, "statusline") === "false") return false;
  if (getConfig(cfg, "afk.statusline") === "false") return false;
  return true;
}

/** The block-1 project input: basename plus the resolved git ref (branch or
 * detached short sha), like statusline.sh's block 1. */
async function resolveProject(root: string): Promise<ProjectInput> {
  const ctx: gitx.GitContext = { cwd: root };
  const branch = await gitx.currentBranch(ctx);
  if (branch) return { basename: basename(root), branch };
  const sha = await gitx.headShortSha(ctx);
  if (sha) return { basename: basename(root), detachedSha: sha };
  return { basename: basename(root) };
}

/** Project the Claude Code payload into the renderer's block-2/3 input. */
function resolveClaude(payload: ClaudePayload): ClaudeInput | undefined {
  const model = payload.model?.display_name;
  const effort = payload.effort?.level;
  const tokens = payload.context_window?.total_input_tokens;
  const pct = payload.context_window?.used_percentage;
  if (model === undefined && tokens === undefined) return undefined;
  return {
    model: model || undefined,
    effort: effort || undefined,
    contextTokens: tokens,
    contextPercent: pct,
  };
}

/**
 * `statusline "<project-root>"` — read the Claude Code payload on stdin, resolve
 * the root, honour the opt-out, and emit ONE compact line via the pure renderer.
 * Emits nothing (and exits 0) when the per-project opt-out is set.
 */
export async function statuslineCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin,
): Promise<number> {
  const rootArg = args[0];
  const text = await readStdin(stdin);
  const payload = parsePayload(text);
  const root = resolveRoot(rootArg, payload, cwd);

  if (!statuslineEnabled(root)) return 0;

  const project = await resolveProject(root);
  const claude = resolveClaude(payload);

  // No `gh repo view` round-trip: like statusline.sh, the gh count probes run
  // from the project root and let gh infer the repo from cwd (repo slug "").
  const afk = (await collectStatuslineAfk({ root, repo: "", remote: "origin" })) ?? undefined;

  const line = renderStatusline({ project, claude, afk });
  stdout.write(`${line}\n`);
  return 0;
}
