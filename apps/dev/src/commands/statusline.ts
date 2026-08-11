// commands/statusline.ts — the project command adapter for the host-scoped
// redskilled statusline.
//
// The render path resolves the project root and opt-out, then delegates to the
// daemon client. It performs one local socket read and never runs a project
// collector, tracker client, or CI-log client. The legacy collector helpers stay
// exported below for non-render consumers during their migration, but the prompt
// path cannot reach them (#3546).
//
// Invocation: `node bin/afk.mjs statusline "<project-root>"` with the payload on
// stdin. The root arg wins when it is a real directory (wire it as
// `… statusline "$CLAUDE_PROJECT_DIR"`), else the payload's
// `.workspace.project_dir` (the fixed session root — survives `cd` into subdirs),
// else `.workspace.current_dir // .cwd`, else `process.cwd()`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// From the COMMAND module, never the CLI: cli.ts ends in a self-invocation
// guard that is always true inside a single-file bundle, so importing it ships
// a second argv-reading CLI inside every dev binary (#3546, canary catch).
import { runStatusline as runRedskilledStatusline } from "@reddb-io/redskilled/statusline-command";
import { configFile } from "@reddb-io/shared/red-paths.js";
import { readBuildInfo } from "@reddb-io/build-info";
import { decode } from "@reddb-io/toon";
import { readDevBundleCacheState } from "../core/bundle-version.js";
import {
  type ClaudeInput,
  type ProjectInput,
  type RspStatusInput,
  type StatuslinePreset,
} from "../core/statusline.js";
import {
  composeStatuslineLines,
  renderStatuslineBedrock,
  type StatuslineBedrockInput,
} from "../core/statusline-bedrock.js";
import { renderStatuslineLegend } from "../core/statusline-legend.js";
import { loadConfig, getConfig } from "../core/config.js";
import { resolveRspConfig } from "../../../rsp/src/config.js";
import { resolveResidentPaths } from "../../../rsp/src/resident-client.js";
import {
  collectStatuslineLocalGit,
  inferGitHubRepoSlug,
  refreshStatuslineCountCache,
  refreshStatuslineRepoCache,
  resolveRepoBasename,
  type StatuslineLocalGit,
  type StatuslineLocalGitDeps,
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
 *
 * Reads PAST the activation gate (ADR 0116) because this is a KILL SWITCH, not a
 * setting: fail-closed must never turn an operator's "off" into an "on". A
 * directory that has not opted into the dev plugin gets none of its settings, but
 * if it says "no statusline" and the host still invokes this command directly,
 * the answer is still no.
 */
export function statuslineEnabled(root: string): boolean {
  const configPath = configFile(root);
  if (!existsSync(configPath)) return true;
  const cfg = loadConfig(configPath, { warn: () => undefined, ignoreActivationGate: true });
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
  show_total_today?: number;
  show_hit_rate?: number;
  decisions?: {
    seen?: number;
    contributed?: number;
  };
  updated_at: string;
}

function parseRspSummary(path: string): RspSummaryFile | undefined {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const parsed = raw.startsWith("{") ? JSON.parse(raw) as unknown : decode(raw);
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

function decisionsFromSummary(summary: RspSummaryFile): Extract<RspStatusInput, { state: "ready" }>["decisions"] {
  const seen = summary.decisions?.seen;
  const contributed = summary.decisions?.contributed;
  if (typeof seen !== "number" || !Number.isFinite(seen) || seen <= 0) return undefined;
  if (typeof contributed !== "number" || !Number.isFinite(contributed)) return undefined;
  return {
    seen: Math.floor(seen),
    contributed: Math.max(0, Math.floor(contributed)),
  };
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
      showHitRate: summary.show_total_today && summary.show_total_today > 0 && typeof summary.show_hit_rate === "number"
        ? summary.show_hit_rate
        : undefined,
      decisions: decisionsFromSummary(summary),
    };
  }
  if (isRecentFile(paths.wakeLockPath, nowMs, RSP_WARMUP_GRACE_MS)) return { state: "warming" };
  if (fileExists(paths.wakeLockPath)) return { state: "error" };
  return undefined;
}

/** The block-1 project input: basename, the resolved git ref (branch or detached
 * short sha), and the running `dev` plugin version (build-info → dim `v<version>`
 * tag on the themed header). */
export async function resolveProject(root: string): Promise<ProjectInput> {
  const ctx: gitx.GitContext = { cwd: root };
  const version = readBuildInfo("dev").version;
  const bundleCache = readDevBundleCacheState(version);
  const latestCachedVersion = bundleCache.laneNewestVersion;
  const repoBasename = await resolveRepoBasename(root);
  const base: ProjectInput = latestCachedVersion === undefined
    ? { basename: repoBasename, version }
    : { basename: repoBasename, version, latestCachedVersion };
  const withPointer = bundleCache.pointerVersion ? { ...base, pointerVersion: bundleCache.pointerVersion } : base;
  const branch = await gitx.currentBranch(ctx);
  if (branch) return { ...withPointer, branch };
  const sha = await gitx.headShortSha(ctx);
  if (sha) return { ...withPointer, detachedSha: sha };
  return withPointer;
}

/** The block-2/3 render inputs read straight off the Claude Code stdin payload.
 * They are the freshest facts on the line — this render tick's, with no cache
 * between them and the operator — and the reason the bedrock is stdin-owned. */
function claudeInputFrom(payload: ClaudePayload): ClaudeInput {
  return {
    model: payload.model?.display_name,
    effort: payload.effort?.level,
    contextTokens: payload.context_window?.total_input_tokens,
    contextPercent: payload.context_window?.used_percentage,
    usage5h: payload.rate_limits?.five_hour?.used_percentage,
    usage7d: payload.rate_limits?.seven_day?.used_percentage,
  };
}

/**
 * Resolve the bedrock's inputs: the stdin payload (free), the running bundle
 * version and its cache state (file reads), and the local git facts (one micro-
 * TTL'd read, {@link collectStatuslineLocalGit}). Nothing here touches the
 * network or the daemon — that is the whole membership rule of the segment.
 */
export async function resolveStatuslineBedrock(
  root: string,
  payload: ClaudePayload,
  gitDeps: StatuslineLocalGitDeps = {},
): Promise<StatuslineBedrockInput> {
  const version = readBuildInfo("dev").version;
  const bundleCache = readDevBundleCacheState(version);
  const git: StatuslineLocalGit = await collectStatuslineLocalGit(root, gitDeps);
  const project: ProjectInput = { basename: git.basename, version };
  if (git.branch) project.branch = git.branch;
  else if (git.detachedSha) project.detachedSha = git.detachedSha;
  if (bundleCache.laneNewestVersion !== undefined) {
    project.latestCachedVersion = bundleCache.laneNewestVersion;
  }
  if (bundleCache.pointerVersion) project.pointerVersion = bundleCache.pointerVersion;
  return {
    project,
    claude: claudeInputFrom(payload),
    localDiff: { localAdded: git.localAdded, localRemoved: git.localRemoved },
  };
}

/**
 * `statusline "<project-root>"` — resolve the root and opt-out, render the
 * bedrock, then append the shared redskilled render as the tail. Emits nothing
 * (and exits 0) only when the project opted out.
 *
 * The bedrock renders FIRST and unconditionally (ADR 0141 §1): an unreachable
 * daemon costs the operator the tail, never the model, context, subscription
 * windows, branch, local diff, or bundle version their own machine already
 * holds. The tail is still the daemon's stated absence, never a fallback to
 * project collectors or the tracker (#3546).
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
  // A real directory is the legacy positional root. Other non-flag words (for
  // example redskilled's `global` mode) belong to the daemon renderer.
  const rootArg = args.find((arg) => !arg.startsWith("--") && isDir(arg));
  const text = await readStdin(stdin);
  const payload = parsePayload(text);
  const root = resolveRoot(rootArg, payload, cwd);

  if (!statuslineEnabled(root)) return 0;

  // One local socket read, one shared renderer. The daemon document already
  // carries the Worker rows, repository activity, quota posture, liveness and
  // staleness; asking project collectors for any of those facts here would put
  // tracker and CI clients back in the terminal-prompt path (#3546).
  //
  // `--no-workers` belonged to the retired two-producer adapter. Once the daemon
  // line reached Worker-row parity (#3151), suppressing its rows would discard
  // the document's most useful information, so the compatibility spelling is a
  // no-op. All other flags are taste owned by the redskilled renderer.
  const daemonArgs = args.filter((arg) => arg !== rootArg && arg !== "--no-workers");
  const bedrock = renderStatuslineBedrock(await resolveStatuslineBedrock(root, payload));
  // The tail is buffered rather than streamed so the bedrock can LEAD the header
  // line the daemon opens with — one line, two segments, in that order.
  const tail: string[] = [];
  const code = await runRedskilledStatusline(daemonArgs, {
    cwd: root,
    write: (line) => {
      tail.push(line);
    },
  });
  for (const line of composeStatuslineLines(bedrock, tail.join("").split("\n"))) {
    stdout.write(`${line}\n`);
  }
  return code;
}

export async function statuslineRefreshCountsCommand(args: string[], cwd = process.cwd()): Promise<number> {
  const root = args[0] ?? cwd;
  let repo = "";
  let lock = "";
  let baseRef = "";
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo") {
      repo = args[++i] ?? "";
    } else if (arg === "--lock") {
      lock = args[++i] ?? "";
    } else if (arg === "--base-ref") {
      baseRef = args[++i] ?? "";
    }
  }
  await refreshStatuslineCountCache(root, repo || inferGitHubRepoSlug(root), lock || undefined);
  // Same child, second cache: the repo stats expire on the same render as the
  // counts, and a second detached process would buy nothing but a second lock.
  if (baseRef !== "") {
    await refreshStatuslineRepoCache({ root, repo, remote: "origin" }, baseRef).catch(() => undefined);
  }
  return 0;
}
