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
import { readBuildInfo } from "@reddb-io/build-info";
import { type ClaudeInput, type ProjectInput } from "../core/statusline.js";
import { renderStatuslineThemed } from "../core/statusline-style.js";
import { loadConfig, getConfig } from "../core/config.js";
import { collectStatuslineAfk, collectStatuslineRepo, collectStatuslineWorkers } from "../runtime/wire.js";
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
  /** Pro/Max rolling usage windows — present only after the first API response of
   * the session, absent entirely for non-Pro/Max accounts. Each window carries a
   * `used_percentage` (and a `resets_at` the renderer does not surface yet). */
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: string };
    seven_day?: { used_percentage?: number; resets_at?: string };
  };
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

/** The block-1 project input: basename, the resolved git ref (branch or detached
 * short sha), and the running `dev` plugin version (build-info → dim `v<version>`
 * tag on the themed header). */
async function resolveProject(root: string): Promise<ProjectInput> {
  const ctx: gitx.GitContext = { cwd: root };
  const version = readBuildInfo("dev").version;
  const base: ProjectInput = { basename: basename(root), version };
  const branch = await gitx.currentBranch(ctx);
  if (branch) return { ...base, branch };
  const sha = await gitx.headShortSha(ctx);
  if (sha) return { ...base, detachedSha: sha };
  return base;
}

/** Project the Claude Code payload into the renderer's block-2/3 input. */
function resolveClaude(payload: ClaudePayload): ClaudeInput | undefined {
  const model = payload.model?.display_name;
  const effort = payload.effort?.level;
  const tokens = payload.context_window?.total_input_tokens;
  const pct = payload.context_window?.used_percentage;
  // Rate-limit windows (Pro/Max only, after the first API response): pass through
  // only when present so the renderer stays graceful for non-Pro/Max sessions.
  const usage5h = payload.rate_limits?.five_hour?.used_percentage;
  const usage7d = payload.rate_limits?.seven_day?.used_percentage;
  if (
    model === undefined &&
    tokens === undefined &&
    usage5h === undefined &&
    usage7d === undefined
  ) {
    return undefined;
  }
  return {
    model: model || undefined,
    effort: effort || undefined,
    contextTokens: tokens,
    contextPercent: pct,
    usage5h,
    usage7d,
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

  // No `gh repo view` round-trip: like statusline.sh, the gh probes run from the
  // project root and let gh infer the repo from cwd (repo slug ""). The repo
  // header stats (line 1) render ALWAYS; the AFK block (line 2) only with live
  // workers, so both collectors run every render (each cheap + cached).
  const repoCtx = { root, repo: "", remote: "origin" };
  // The aggregate AFK block feeds the plain single-line form (NO_COLOR / Codex);
  // the per-worker records feed the themed multi-line form (Claude Code). Both
  // read the same worker states — cheap file reads — so the two forms stay in
  // sync while each renders its own layout.
  const [repo, afk, workers] = await Promise.all([
    collectStatuslineRepo(repoCtx),
    collectStatuslineAfk(repoCtx).then((a) => a ?? undefined),
    collectStatuslineWorkers(repoCtx),
  ]);

  // Theme on by default (the multi-line wine layout: a repo-global header line
  // then one line per live worker); honour NO_COLOR for plain consumers (the
  // single-line aggregate — the Codex-footer form), matching the de-facto colour
  // opt-out. Claude Code exports $COLUMNS (v2.1.153+) as the width budget.
  const color = !process.env.NO_COLOR;
  const columns = Number.parseInt(process.env.COLUMNS ?? "", 10);
  const nowS = Math.floor(Date.now() / 1000);
  const line = renderStatuslineThemed({ project, claude, repo, afk }, color, {
    columns: Number.isFinite(columns) && columns > 0 ? columns : undefined,
    workers,
    now: nowS,
  });
  stdout.write(`${line}\n`);
  return 0;
}
