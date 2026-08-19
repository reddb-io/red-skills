import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type HookConfig,
  type MemoryConfig,
  readConfig,
} from "./config.js";
import type { HookEvent, Runner } from "./hook-runtime.js";

export interface HookCoverageEvent {
  event: HookEvent;
  flag: keyof HookConfig;
  supported: boolean;
  wired: boolean;
  enabled: boolean;
  effectively_covered: boolean;
  command_count: number;
  matcher: string | null;
  fail_open: boolean;
  notes: string[];
}

export interface HookCoverageRunner {
  runner: Runner;
  manifest_path: string;
  manifest_found: boolean;
  events: HookCoverageEvent[];
  coverage: {
    wired: number;
    enabled: number;
    effective: number;
    total: number;
  };
  gaps: string[];
  actionable_gaps: string[];
}

export interface HookCoverageReport {
  schema_version: "memory.hook_coverage.v1";
  read_only: true;
  root: string;
  config_found: boolean;
  mode: MemoryConfig["mode"] | "uninitialized";
  hooks_enabled: Array<keyof HookConfig>;
  runners: HookCoverageRunner[];
  summary: {
    runner_count: number;
    total_events: number;
    wired_events: number;
    enabled_events: number;
    effective_events: number;
    actionable_gaps: number;
  };
  gaps: string[];
  actionable_gaps: string[];
  recommended_next_actions: string[];
}

type Manifest = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
};

const EVENTS: HookEvent[] = ["SessionStart", "PostToolUse", "Stop", "PreCompact"];
const RUNNERS: Runner[] = ["claude", "codex"];
const EVENT_FLAG: Record<HookEvent, keyof HookConfig> = {
  SessionStart: "sessionStart",
  PostToolUse: "postToolUse",
  Stop: "stop",
  PreCompact: "preCompact",
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the plugin root that holds `hooks/<runner>.hooks.json`.
 *
 * The hook manifests live with the plugin *definition* (plugins/memory/hooks/),
 * not with the relocated implementation (apps/plugin-memory/src/). Mirror the
 * resilient pattern in cli.ts::resolveBootstrapPath: prefer the installed
 * plugin root from the environment (which ships `hooks/` alongside the bundled
 * runtime), then fall back through the module-relative and source-tree layouts,
 * picking the first candidate that actually contains a `hooks/` directory.
 */
function resolvePluginRoot(): string {
  const env = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.CODEX_PLUGIN_ROOT;
  const candidates = [
    isMemoryPluginRoot(env) ? env : undefined,
    // Built/legacy layout: dist/hook-coverage.js sits next to a `hooks/` dir.
    dirname(MODULE_DIR),
    // Dev/source layout: this file is <repoRoot>/apps/plugin-memory/src/...,
    // and the manifests stay at <repoRoot>/plugins/memory/hooks/.
    join(MODULE_DIR, "..", "..", "..", "plugins", "memory"),
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "hooks"))) return resolve(candidate);
  }
  // No candidate has hooks/ — return the module-relative root so the report
  // still produces a deterministic (manifest_found=false) result.
  return dirname(MODULE_DIR);
}

const PLUGIN_ROOT = resolvePluginRoot();

function isMemoryPluginRoot(candidate: string | undefined): candidate is string {
  if (!candidate) return false;
  for (const manifest of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    const path = join(candidate, manifest);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown };
      return parsed.name === "memory";
    } catch {
      return false;
    }
  }
  return false;
}

export async function buildHookCoverageReport(
  rootDir: string,
  opts: { pluginRoot?: string } = {},
): Promise<HookCoverageReport> {
  const root = resolve(rootDir);
  const config = await readConfig(root);
  const pluginRoot = opts.pluginRoot ?? PLUGIN_ROOT;
  const runners = await Promise.all(
    RUNNERS.map((runner) => runnerCoverage(runner, pluginRoot, config)),
  );
  const hooksEnabled = config ? enabledHookFlags(config.hooks) : [];
  const gaps = [...new Set(runners.flatMap((runner) => runner.gaps))];
  const actionableGaps = [...new Set(runners.flatMap((runner) => runner.actionable_gaps))];
  if (!config) gaps.unshift("memory is not initialized");
  if (!config) actionableGaps.unshift("memory is not initialized");
  if (config?.mode === "markdown-only") {
    gaps.unshift("markdown-only mode disables auto-firing hooks");
    actionableGaps.unshift("markdown-only mode disables auto-firing hooks");
  }
  const summary = {
    runner_count: runners.length,
    total_events: runners.reduce((sum, runner) => sum + runner.coverage.total, 0),
    wired_events: runners.reduce((sum, runner) => sum + runner.coverage.wired, 0),
    enabled_events: runners.reduce((sum, runner) => sum + runner.coverage.enabled, 0),
    effective_events: runners.reduce((sum, runner) => sum + runner.coverage.effective, 0),
    actionable_gaps: actionableGaps.length,
  };

  return {
    schema_version: "memory.hook_coverage.v1",
    read_only: true,
    root,
    config_found: config != null,
    mode: config?.mode ?? "uninitialized",
    hooks_enabled: hooksEnabled,
    runners,
    summary,
    gaps,
    actionable_gaps: actionableGaps,
    recommended_next_actions: recommendations(config, runners, gaps, actionableGaps),
  };
}

async function runnerCoverage(
  runner: Runner,
  pluginRoot: string,
  config: MemoryConfig | null,
): Promise<HookCoverageRunner> {
  const manifestPath = join(pluginRoot, "hooks", `${runner}.hooks.json`);
  const manifest = await loadManifest(manifestPath);
  const events = EVENTS.map((event) => eventCoverage(runner, event, manifest, config));
  const gaps = runnerGaps(runner, manifest, events, config);
  const actionableGaps = actionableRunnerGaps(runner, manifest, events, config);
  return {
    runner,
    manifest_path: manifestPath,
    manifest_found: manifest != null,
    events,
    coverage: {
      wired: events.filter((event) => event.wired).length,
      enabled: events.filter((event) => event.enabled).length,
      effective: events.filter((event) => event.effectively_covered).length,
      total: events.length,
    },
    gaps,
    actionable_gaps: actionableGaps,
  };
}

async function loadManifest(path: string): Promise<Manifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function eventCoverage(
  runner: Runner,
  event: HookEvent,
  manifest: Manifest | null,
  config: MemoryConfig | null,
): HookCoverageEvent {
  const groups = manifest?.hooks?.[event] ?? [];
  const commands = groups.flatMap((group) =>
    (group.hooks ?? []).map((hook) => hook.command).filter((command): command is string => Boolean(command)),
  );
  const wired = commands.length > 0;
  const supported = !(runner === "codex" && event === "PreCompact" && !wired);
  const flag = EVENT_FLAG[event];
  const enabled = wired && config?.mode === "graph" && config.hooks[flag] === true;
  const fallbackCovered =
    runner === "codex" &&
    event === "PreCompact" &&
    !wired &&
    config?.mode === "graph" &&
    config.hooks.stop === true &&
    config.hooks.sessionStart === true;
  const effectivelyCovered = enabled || fallbackCovered;
  const notes: string[] = [];
  if (!wired && supported) notes.push("not wired by runner manifest");
  if (wired && !config) notes.push("memory config is absent");
  if (wired && config?.mode === "markdown-only") notes.push("disabled by markdown-only mode");
  if (wired && config?.mode === "graph" && !config.hooks[flag]) {
    notes.push(`disabled by config.hooks.${flag}`);
  }
  if (!supported) {
    notes.push("runner has no PreCompact hook surface");
    if (fallbackCovered) {
      notes.push("effectively covered by Stop flush plus SessionStart recall");
    } else {
      notes.push("fallback needs Stop and SessionStart hooks enabled");
    }
  }
  return {
    event,
    flag,
    supported,
    wired,
    enabled,
    effectively_covered: effectivelyCovered,
    command_count: commands.length,
    matcher: groups.map((group) => group.matcher).find((value): value is string => Boolean(value)) ?? null,
    fail_open: commands.length > 0 && commands.every((command) => command.includes("printf \"{}\"")),
    notes,
  };
}

function runnerGaps(
  runner: Runner,
  manifest: Manifest | null,
  events: HookCoverageEvent[],
  config: MemoryConfig | null,
): string[] {
  const gaps: string[] = [];
  if (!manifest) gaps.push(`${runner} hook manifest is missing`);
  for (const event of events) {
    if (!event.wired && event.supported) gaps.push(`${runner} ${event.event} is not wired`);
    if (event.wired && config?.mode === "graph" && !event.enabled) {
      gaps.push(`${runner} ${event.event} is wired but disabled`);
    }
  }
  if (runner === "codex" && !events.find((event) => event.event === "PreCompact")?.wired) {
    gaps.push("codex has no PreCompact equivalent; flush relies on Stop plus SessionStart");
  }
  return [...new Set(gaps)];
}

function actionableRunnerGaps(
  runner: Runner,
  manifest: Manifest | null,
  events: HookCoverageEvent[],
  config: MemoryConfig | null,
): string[] {
  const gaps: string[] = [];
  if (!manifest) gaps.push(`${runner} hook manifest is missing`);
  for (const event of events) {
    if (event.supported && !event.wired) gaps.push(`${runner} ${event.event} is not wired`);
    if (event.wired && config?.mode === "graph" && !event.enabled) {
      gaps.push(`${runner} ${event.event} is wired but disabled`);
    }
    if (!event.supported && !event.effectively_covered) {
      gaps.push(`${runner} ${event.event} fallback is not effectively covered`);
    }
  }
  return [...new Set(gaps)];
}

function enabledHookFlags(hooks: HookConfig): Array<keyof HookConfig> {
  return (Object.entries(hooks) as Array<[keyof HookConfig, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([flag]) => flag);
}

function recommendations(
  config: MemoryConfig | null,
  runners: HookCoverageRunner[],
  gaps: string[],
  actionableGaps: string[],
): string[] {
  const out: string[] = [];
  if (!config) {
    out.push("run `memory init --mode graph --hooks` to enable lifecycle hooks");
    return out;
  }
  if (config.mode === "markdown-only") {
    out.push("switch to graph mode before enabling auto-firing hooks");
    return out;
  }
  if (enabledHookFlags(config.hooks).length === 0) {
    out.push("enable graph hooks when automatic recall, re-index, and extraction are desired");
  }
  if (runners.some((runner) => !runner.manifest_found)) {
    out.push("restore missing hooks/*.hooks.json manifests from the Memory plugin");
  }
  if (
    gaps.some((gap) => gap.includes("codex has no PreCompact")) &&
    actionableGaps.some((gap) => gap.includes("PreCompact fallback"))
  ) {
    out.push("for Codex, rely on Stop extraction plus SessionStart recall around `/clear`");
  }
  if (actionableGaps.some((gap) => gap.includes("not wired") || gap.includes("disabled"))) {
    out.push("wire or enable missing runner hooks for automatic Memory lifecycle coverage");
  }
  if (out.length === 0) out.push("hook coverage is ready; no action required");
  return out;
}
