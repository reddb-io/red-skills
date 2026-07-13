// commands/statusline.ts — native port of scripts/statusline.sh (the /afk
// statusline aggregator for Claude Code).
//
// This is the IO half: it reads the Claude Code statusline JSON payload from
// stdin (cwd, model, effort, context window), resolves the project root, honours
// the per-project `.red/config.yaml` opt-out, reads the git branch, aggregates
// the live /afk worker state (with a 180 s / 3 min GitHub-count cache, configurable
// via RED_AFK_STATUSLINE_CACHE_TTL_S / afk.statusline_cache_ttl), and feeds it all
// into the PURE renderer in core/statusline.ts. The render assembly itself —
// block order, optional-drop, ` · ` joins, token humanizing — lives entirely in
// core/statusline.ts and is exercised by tests/statusline.test.ts.
//
// Invocation: `node bin/afk.mjs statusline "<project-root>"` with the payload on
// stdin. The root arg wins when it is a real directory (wire it as
// `… statusline "$CLAUDE_PROJECT_DIR"`), else the payload's
// `.workspace.project_dir` (the fixed session root — survives `cd` into subdirs),
// else `.workspace.current_dir // .cwd`, else `process.cwd()`.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readBuildInfo } from "@reddb-io/build-info";
import { resolveBase } from "../core/base-resolver.js";
import { type ClaudeInput, type ProjectInput, type RspStatusInput, type StatuslinePreset } from "../core/statusline.js";
import { renderStatuslineLegend } from "../core/statusline-legend.js";
import { renderStatuslineThemed } from "../core/statusline-style.js";
import { loadConfig, getConfig } from "../core/config.js";
import { branchLockPath, readLockedBranch } from "../runtime/lock.js";
import { resolveRspConfig } from "../../../rsp/src/config.js";
import { resolveResidentPaths } from "../../../rsp/src/resident-client.js";
import {
  collectStatuslineAfk,
  collectStatuslineFleet,
  collectStatuslineRepo,
  collectStatuslineWorkers,
  inferGitHubRepoSlug,
  refreshStatuslineCountCache,
  resolveStatuslineCacheTtl,
} from "../runtime/wire.js";
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

function coerceStatuslinePreset(raw: string): StatuslinePreset | undefined {
  return raw === "full" || raw === "short" ? raw : undefined;
}

export function resolveStatuslinePreset(cfg: ReturnType<typeof loadConfig>): StatuslinePreset {
  return (
    coerceStatuslinePreset(getConfig(cfg, "plugins.dev.statusline.preset")) ??
    coerceStatuslinePreset(getConfig(cfg, "dev.statusline.preset")) ??
    coerceStatuslinePreset(getConfig(cfg, "afk.statusline.preset")) ??
    coerceStatuslinePreset(getConfig(cfg, "statusline.preset")) ??
    "full"
  );
}

const RSP_WARMUP_GRACE_MS = 15_000;

interface RspSummaryFile {
  version: number;
  tokens_saved_today: number;
  dollars_saved_today_usd?: number;
  updated_at: string;
}

function parseRspSummary(path: string): RspSummaryFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      typeof (parsed as { tokens_saved_today?: unknown }).tokens_saved_today === "number" &&
      typeof (parsed as { updated_at?: unknown }).updated_at === "string"
    ) {
      return parsed as RspSummaryFile;
    }
  } catch {}
  return undefined;
}

function isRecentFile(path: string, nowMs: number, maxAgeMs: number): boolean {
  try {
    return nowMs - statSync(path).mtimeMs <= maxAgeMs;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function utcDay(iso: string): string | undefined {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

function tokensSavedForCurrentDay(summary: RspSummaryFile, nowMs: number): number {
  if (utcDay(summary.updated_at) !== new Date(nowMs).toISOString().slice(0, 10)) return 0;
  return Math.max(0, Math.floor(summary.tokens_saved_today));
}

function dollarsSavedForCurrentDay(summary: RspSummaryFile, nowMs: number): number | undefined {
  if (utcDay(summary.updated_at) !== new Date(nowMs).toISOString().slice(0, 10)) return undefined;
  if (typeof summary.dollars_saved_today_usd !== "number") return undefined;
  return Math.max(0, summary.dollars_saved_today_usd);
}

function semverParts(version: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a: string, b: string): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (!pa || !pb) return 0;
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

function redSkillsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RED_SKILLS_CACHE_DIR) return env.RED_SKILLS_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "red-skills", "bundles");
  return join(homedir(), ".cache", "red-skills", "bundles");
}

function newestCachedDevBundleVersion(
  installedVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const current = semverParts(installedVersion);
  if (!current) return undefined;
  const cacheDir = redSkillsCacheDir(env);
  let best: string | undefined;
  try {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const m = /^dev-(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\.bundle\.min\.mjs$/.exec(entry.name);
      if (!m) continue;
      const version = m[1];
      if (semverParts(version) === null) continue;
      if (compareSemver(version, installedVersion) <= 0) continue;
      if (best === undefined || compareSemver(version, best) > 0) best = version;
    }
  } catch {
    return undefined;
  }
  return best;
}

export async function resolveStatuslineRsp(root: string, env: NodeJS.ProcessEnv = process.env): Promise<RspStatusInput | undefined> {
  const config = resolveRspConfig(root, env);
  if (!config.enabled) return undefined;
  const paths = resolveResidentPaths(root);
  const nowMs = Date.now();
  const summary = parseRspSummary(paths.summaryPath);
  if (summary) {
    return {
      state: "ready",
      tokensSavedToday: tokensSavedForCurrentDay(summary, nowMs),
      dollarsSavedTodayUsd: dollarsSavedForCurrentDay(summary, nowMs),
    };
  }
  if (isRecentFile(paths.wakeLockPath, nowMs, RSP_WARMUP_GRACE_MS)) return { state: "warming" };
  if (fileExists(paths.wakeLockPath)) return { state: "error" };
  return undefined;
}

/** The block-1 project input: basename, the resolved git ref (branch or detached
 * short sha), and the running `dev` plugin version (build-info → dim `v<version>`
 * tag on the themed header). */
async function resolveProject(root: string): Promise<ProjectInput> {
  const ctx: gitx.GitContext = { cwd: root };
  const version = readBuildInfo("dev").version;
  const latestCachedVersion = newestCachedDevBundleVersion(version);
  const base: ProjectInput = latestCachedVersion === undefined
    ? { basename: basename(root), version }
    : { basename: basename(root), version, latestCachedVersion };
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
  if (args.includes("--legend")) {
    stdout.write(`${renderStatuslineLegend()}\n`);
    return 0;
  }

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
  const repoCtx = { root, repo: inferGitHubRepoSlug(root), remote: "origin" };
  // Resolve the cache TTL ONCE here (env > afk.statusline_cache_ttl config > 180,
  // #1217) and thread it into both collectors — the hot render path never loads
  // config a second time per collector.
  const cfg = loadConfig(join(root, ".red", "config.yaml"), { warn: () => undefined });
  const preset = resolveStatuslinePreset(cfg);
  const cacheTtlS = resolveStatuslineCacheTtl(process.env, (key) => getConfig(cfg, key));
  const base = await resolveBase(
    { issueBody: "" },
    {
      readLockedBranch: () => readLockedBranch(branchLockPath(root)),
      configLockedBranch: getConfig(cfg, "dev.lock.branch"),
      configTrunk: getConfig(cfg, "dev.trunk"),
      fetchIssueBody: async () => undefined,
    },
  );
  const repoLocBaseRef = `origin/${base}`;
  // The aggregate AFK block feeds the plain single-line form (NO_COLOR / Codex);
  // the per-worker records feed the themed multi-line form (Claude Code). Both
  // read the same worker states — cheap file reads — so the two forms stay in
  // sync while each renders its own layout.
  const [repo, afk, fleet, workers, rsp] = await Promise.all([
    collectStatuslineRepo(repoCtx, cacheTtlS, repoLocBaseRef),
    collectStatuslineAfk(repoCtx, cacheTtlS).then((a) => a ?? undefined),
    collectStatuslineFleet(repoCtx),
    collectStatuslineWorkers(repoCtx),
    resolveStatuslineRsp(root),
  ]);

  // Theme on by default (the multi-line wine layout: a repo-global header line
  // then one line per live worker); honour NO_COLOR for plain consumers (the
  // single-line aggregate — the Codex-footer form), matching the de-facto colour
  // opt-out. Claude Code exports $COLUMNS (v2.1.153+) as the width budget.
  const color = !process.env.NO_COLOR;
  const columns = Number.parseInt(process.env.COLUMNS ?? "", 10);
  const nowS = Math.floor(Date.now() / 1000);
  const line = renderStatuslineThemed({ project, claude, repo, fleet, afk, rsp }, color, {
    columns: Number.isFinite(columns) && columns > 0 ? columns : undefined,
    workers,
    now: nowS,
    preset,
  });
  stdout.write(`${line}\n`);
  return 0;
}

export async function statuslineRefreshCountsCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const root = args[0] ?? cwd;
  let repo = "";
  let lock = "";
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo") {
      repo = args[++i] ?? "";
    } else if (arg === "--lock") {
      lock = args[++i] ?? "";
    }
  }
  await refreshStatuslineCountCache(root, repo || inferGitHubRepoSlug(root), lock || undefined);
  return 0;
}
