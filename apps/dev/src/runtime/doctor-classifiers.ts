import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";
import { readBuildInfo } from "@reddb-io/build-info";
import { newestCachedBundleVersion, redSkillsCacheDir, semverParts } from "../core/bundle-version.js";
import { getConfig, loadConfig, readBackpressure, type ConfigValues } from "../core/config.js";
import { HOOK_DEFAULT_NAMES } from "../core/hook-config.js";
import { HOOK_REGISTRY, type ExitPolicy } from "../core/hook-registry.js";
import {
  unknownHookNames,
  validateHookConfig,
  type ClassifyContext,
  type ValidationReport,
} from "../core/hook-doctor.js";
import { auditRuntimes, type PluginRuntimeFacts, type RuntimeReport } from "../core/runtime-doctor.js";
import { auditHostBinaries, type HostBinaryReport } from "../core/host-binary-doctor.js";
import {
  auditMarketplaceSources,
  parseMarketplaceSource,
  RED_SKILLS_MARKETPLACE,
  type MarketplaceHost,
  type MarketplaceSourceFacts,
  type MarketplaceSourceReport,
} from "../core/marketplace-source-doctor.js";
import { readCatalogToonVersion } from "../core/toon-version.js";
import { auditDependencyEdges, type DependencyEdgeReport } from "../core/dependency-edge-doctor.js";
import {
  auditAskRedRouterCoverage,
  type AskRedRouterCoverageReport,
} from "../core/ask-red-router-doctor.js";
import {
  auditRedTaxonomy,
  type RedTaxonomyEntry,
  type RedTaxonomyReport,
} from "../core/red-taxonomy-doctor.js";
import { auditUnlandedDocs, type UnlandedDocsDoctorReport } from "../core/unlanded-docs-doctor.js";
import { collectDocsSweepInput } from "./wire/docs.js";
import type { RepoContext } from "./wire/paths.js";
import { listDependencyEdgeTickets, type GhContext } from "./gh.js";

/**
 * doctor-classifiers.ts — the fact-collection half of the `/red-doctor` checks
 * whose classifiers are pure and IO-free (checks 12, 13, 15, 17, 18, 19, 21, 26).
 *
 * Every classifier under `core/` is injected-facts-only by design, so SOMETHING
 * has to read the repo, the host cache and the tracker and hand it the facts.
 * That reader is this module, and it is the reason a documented, unit-tested
 * classifier can still report on nothing: for a long stretch the doctor command
 * imported none of them (#3034), so seven checks the SKILL.md contract declares
 * — and a docs test asserted — examined nothing at all.
 *
 * Read-only, and degrading rather than throwing: a collection failure becomes a
 * named note plus an empty report for that check, because a doctor that dies on
 * an unreadable `.red/` tells its operator less than one that says which half it
 * could not read.
 */

/**
 * The host CLIs whose marketplace registration the installer writes, so a frozen
 * Directory source is this repo's own defect to heal. Gemini registers through
 * the documented manual flow only (docs/INSTALL.md), which already points at the
 * GitHub source, so it is not probed here.
 */
const MARKETPLACE_HOSTS: readonly MarketplaceHost[] = ["claude", "codex"];

/** The plugins the ADR 0084 control-plane contract covers, in scorecard order. */
const AUDITED_PLUGINS = ["dev", "memory", "brain"] as const;

/** The `red-*` hook targets the library ships (`HOOK_DEFAULTS_REGISTRY`). */
const LIBRARY_HOOK_TARGETS = HOOK_DEFAULT_NAMES.map((name) => `red-${name}`);

export interface HookPointRow {
  readonly hook: string;
  /** How a non-zero exit routes, from the canonical hook registry. */
  readonly exit: ExitPolicy | "unknown";
  readonly commands: number;
}

export interface DoctorClassifierReports {
  /** Check 12 — AFK hook / backpressure static validation. */
  readonly hooks: ValidationReport;
  readonly hookPoints: HookPointRow[];
  /** Check 13 — per-plugin runtime distribution. */
  readonly runtime: RuntimeReport;
  /** Plugins whose installed version could not be resolved, so were not audited. */
  readonly runtimeUnresolved: string[];
  /** Check 18 — required host binaries against the catalog pin. */
  readonly hostBinaries: HostBinaryReport;
  /** Check 26 — marketplace registration source per host CLI. */
  readonly marketplaceSources: MarketplaceSourceReport;
  /** Check 15 — native blocked-by vs `req:N` divergence. */
  readonly dependencyEdges: DependencyEdgeReport;
  /** Open Tickets whose native edges were not read (budget or transport). */
  readonly dependencyEdgesUnread: number[];
  /** Check 17 — ask-red router coverage sync. */
  readonly askRedRouter: AskRedRouterCoverageReport;
  /** Check 19 — `.red` lifecycle taxonomy. */
  readonly redTaxonomy: RedTaxonomyReport;
  /** Check 21 — unlanded `.red/` docs. */
  readonly unlandedDocs: UnlandedDocsDoctorReport;
  /** One line per degraded collection; empty when every check had its facts. */
  readonly notes: string[];
}

const EMPTY_HOOK_REPORT: ValidationReport = { backpressure: [], hooks: [], unknownHooks: [] };

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

// ---------- check 12: AFK hook / backpressure static validation ----------

/**
 * Collect the declared hook points from config keys and the `.red/hooks/` tree.
 *
 * Both surfaces feed `declaredHookNames` because an unknown name is a hard boot
 * error from EITHER: `afk.hooks.pre_wrktree` and `.red/hooks/pre_wrktree/` park
 * the same drain, and the point of pre-catching them here is that the doctor
 * says so read-only before the next one.
 */
function collectDeclaredHooks(
  config: ConfigValues,
  projectHooksDir: string,
): { declared: string[]; commands: Array<{ hook: string; command: string }> } {
  const declared = new Set<string>();
  const commands: Array<{ hook: string; command: string }> = [];

  for (const [key, value] of Object.entries(config)) {
    if (!key.startsWith("afk.hooks.")) continue;
    if (key.startsWith("afk.hooks.defaults.")) continue;
    // A YAML list flattens to `afk.hooks.<point>.<N>`; a scalar has no index.
    const hook = key.slice("afk.hooks.".length).split(".")[0]!;
    if (!hook) continue;
    declared.add(hook);
    for (const line of value.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      commands.push({ hook, command: line });
    }
  }

  for (const entry of listDir(projectHooksDir)) {
    if (entry.startsWith(".")) continue;
    const pointDir = join(projectHooksDir, entry);
    if (!isDir(pointDir)) continue;
    declared.add(entry);
    for (const script of listDir(pointDir)) {
      if (script.startsWith(".")) continue;
      commands.push({ hook: entry, command: join(projectHooksDir, entry, script) });
    }
  }

  return { declared: [...declared].sort((a, b) => a.localeCompare(b)), commands };
}

function collectHookReport(
  root: string,
  config: ConfigValues,
): { report: ValidationReport; points: HookPointRow[] } {
  const projectHooksDir = join(root, ".red", "hooks");
  const { declared, commands } = collectDeclaredHooks(config, projectHooksDir);

  const packageScripts = new Set<string>();
  const packageText = readOptionalText(join(root, "package.json"));
  if (packageText) {
    try {
      const scripts = (JSON.parse(packageText) as { scripts?: Record<string, unknown> }).scripts;
      for (const name of Object.keys(scripts ?? {})) packageScripts.add(name);
    } catch {
      // A malformed package.json leaves the script set empty; every `pnpm run x`
      // then classifies as a missing script, which is the honest read.
    }
  }

  // A `red-*` target resolves against the library's shipped hooks plus any
  // project shadow of the same name — never by running the command.
  const libraryScripts = new Set<string>(LIBRARY_HOOK_TARGETS);
  for (const entry of listDir(projectHooksDir)) {
    if (entry.startsWith("red-")) libraryScripts.add(entry);
  }

  const ctx: ClassifyContext = {
    packageScripts,
    fileExists: (path) => existsSync(path.startsWith("/") ? path : join(root, path)),
    libraryScripts,
  };

  const report = validateHookConfig(
    { backpressure: readBackpressure(config), hookCommands: commands, declaredHookNames: declared },
    ctx,
  );

  const unknown = new Set(unknownHookNames(declared));
  const points = declared.map((hook) => ({
    hook,
    // The registry owns the exit-code policy, so the scorecard can say whether a
    // broken hook ABORTS the step or is only logged — a `pre_*` failure parks a
    // drain, a `post_*` one does not.
    exit: unknown.has(hook)
      ? ("unknown" as const)
      : (HOOK_REGISTRY[hook as keyof typeof HOOK_REGISTRY]?.exit ?? ("unknown" as const)),
    commands: report.hooks.filter((entry) => entry.hook === hook).length,
  }));

  return { report, points };
}

// ---------- check 13: per-plugin runtime distribution ----------

function readPluginManifestVersion(root: string, plugin: string): string | undefined {
  const text = readOptionalText(join(root, "plugins", plugin, ".claude-plugin", "plugin.json"));
  if (!text) return undefined;
  try {
    const version = (JSON.parse(text) as { version?: unknown }).version;
    return typeof version === "string" && version.trim() !== "" ? version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Observe one plugin's cached-bundle state without fetching anything.
 *
 * Since the ADR 0091 npm cutover there is no client-side checksum manifest —
 * integrity is npm's, verified at fetch time — so the local integrity fact is
 * the one a reader can actually see: the cached bundle is readable and carries
 * bytes. A staging directory with no bundle beside it IS the inert marker a
 * failed fetch leaves behind.
 */
function readPluginCacheState(
  cacheDir: string,
  plugin: string,
  version: string,
): PluginRuntimeFacts["cache"] {
  const bundle = join(cacheDir, `${plugin}-${version}.bundle.min.mjs`);
  if (!existsSync(bundle)) {
    const staging = join(cacheDir, `.staging-${plugin}-${version}`);
    return existsSync(staging) ? { kind: "inert" } : { kind: "absent" };
  }
  try {
    const size = statSync(bundle).size;
    return { kind: "present", version, readable: true, checksumOk: size > 0 };
  } catch {
    return { kind: "present", version, readable: false, checksumOk: false };
  }
}

function collectRuntimeReport(
  root: string,
  configText: string | undefined,
): { report: RuntimeReport; unresolved: string[] } {
  const cacheDir = redSkillsCacheDir();
  const facts: PluginRuntimeFacts[] = [];
  const unresolved: string[] = [];

  // The build-info sentinel for an UNSTAMPED run (a checkout, not a bundle).
  // It names no distributed runtime, so auditing against it would look for a
  // `dev-0.0.0-dev` bundle nothing ever fetched and call the absence a defect.
  const unstamped = "0.0.0-dev";

  for (const plugin of AUDITED_PLUGINS) {
    const stamped = plugin === "dev" ? readBuildInfo("dev").version : undefined;
    const installedVersion =
      readPluginManifestVersion(root, plugin) ?? (stamped === unstamped ? undefined : stamped);
    if (!installedVersion || !semverParts(installedVersion)) {
      // No version means no cache key to look for; auditing anyway would report
      // `runtime-missing` for a bundle nobody ever named.
      unresolved.push(plugin);
      continue;
    }
    const enabled = configText ? pluginEnabledInConfig(configText, plugin) : false;
    // The drift signal stays local: the newest bundle already cached for this
    // plugin. Resolving the latest RELEASE would touch the network, which Pass 1
    // never does — and an unresolved latest suppresses the drift check by design.
    const latestVersion = newestCachedBundleVersion(plugin, installedVersion);
    facts.push({
      plugin,
      enabled,
      installedVersion,
      cache: readPluginCacheState(cacheDir, plugin, installedVersion),
      ...(latestVersion ? { latestVersion } : {}),
    });
  }

  return { report: auditRuntimes(facts), unresolved };
}

// ---------- check 17: ask-red router coverage sync ----------

function readRegisteredDevSkills(root: string): string[] | undefined {
  const text = readOptionalText(join(root, "plugins", "dev", ".claude-plugin", "plugin.json"));
  if (!text) return undefined;
  try {
    const skills = (JSON.parse(text) as { skills?: unknown }).skills;
    if (!Array.isArray(skills)) return undefined;
    return skills
      .map((entry) => String(entry).replace(/\/+$/, "").split("/").pop() ?? "")
      .filter((name) => name.length > 0);
  } catch {
    return undefined;
  }
}

/**
 * The slash-command names the ask-red router mentions.
 *
 * Fenced blocks are stripped first: an odd backtick inside a fence re-pairs
 * every inline span after it, which silently halves the router set and invents
 * `missing-from-router` findings for skills the router does name. Namespaced
 * routes (`/memory:wiki`) are deliberately excluded — the inventory says they
 * ship with another plugin.
 */
export function extractAskRedRouterSkills(markdown: string): string[] {
  const withoutFences = markdown.replace(/^```[\s\S]*?^```/gm, "");
  const names = new Set<string>();
  for (const match of withoutFences.matchAll(/`([^`\n]+)`/g)) {
    const route = /^\/([a-z0-9][a-z0-9-]*)$/.exec(match[1]!.trim());
    if (route) names.add(route[1]!);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ---------- check 19: `.red` lifecycle taxonomy ----------

/**
 * Enumerate the `.red/` entries ADR 0098's taxonomy classifies: every top-level
 * entry, every direct child of `.red/tmp/`, and every `.red/tmp/worktrees/` lane.
 * Nothing deeper — the classifier only rules on those three levels.
 */
export function collectRedTaxonomyEntries(root: string): RedTaxonomyEntry[] {
  const entries: RedTaxonomyEntry[] = [];
  const push = (relative: string, absolute: string) => {
    entries.push({ path: relative, kind: isDir(absolute) ? "dir" : "file" });
  };

  const redDir = join(root, ".red");
  for (const name of listDir(redDir)) {
    push(`.red/${name}`, join(redDir, name));
  }

  const tmpDir = join(redDir, "tmp");
  for (const name of listDir(tmpDir)) {
    push(`.red/tmp/${name}`, join(tmpDir, name));
  }

  const worktreesDir = join(tmpDir, "worktrees");
  for (const name of listDir(worktreesDir)) {
    push(`.red/tmp/worktrees/${name}`, join(worktreesDir, name));
  }

  return entries;
}

// ---------- the aggregate ----------

export interface DoctorClassifierOptions {
  /** Injected for tests; defaults to the shared ADR 0092 Docs Sweep collector. */
  readonly collectDocsSweep?: typeof collectDocsSweepInput;
  /** Injected for tests; defaults to the read-only dependency-edge scan. */
  readonly listDependencyEdges?: typeof listDependencyEdgeTickets;
  /** Injected for tests; defaults to observing `tq --version` on this host. */
  readonly readToolVersion?: (tool: string) => Promise<string | undefined>;
  /** Injected for tests; defaults to listing each host CLI's marketplaces. */
  readonly readMarketplaceList?: (host: MarketplaceHost) => Promise<MarketplaceListProbe>;
}

/**
 * Collect facts for, and run, every pure doctor classifier the SKILL.md names.
 *
 * Each check is independently degradable: a failure names itself in `notes` and
 * leaves an empty report, so one unreachable surface never blanks the other six.
 */
export async function collectDoctorClassifierReports(
  ctx: RepoContext,
  options: DoctorClassifierOptions = {},
): Promise<DoctorClassifierReports> {
  const notes: string[] = [];
  const configPath = join(ctx.root, ".red", "config.yaml");
  const configText = readOptionalText(configPath);
  const config = loadConfig(configPath, { ignoreActivationGate: true, warn: () => undefined });

  let hooks = EMPTY_HOOK_REPORT;
  let hookPoints: HookPointRow[] = [];
  try {
    const collected = collectHookReport(ctx.root, config);
    hooks = collected.report;
    hookPoints = collected.points;
  } catch (error) {
    notes.push(`hook validation unavailable: ${message(error)}`);
  }

  let runtime: RuntimeReport = { findings: [], rows: [] };
  let runtimeUnresolved: string[] = [];
  try {
    const collected = collectRuntimeReport(ctx.root, configText);
    runtime = collected.report;
    runtimeUnresolved = collected.unresolved;
  } catch (error) {
    notes.push(`runtime distribution audit unavailable: ${message(error)}`);
  }

  let hostBinaries: HostBinaryReport = { findings: [], rows: [] };
  try {
    // The catalog pin only exists inside this workspace; an adopter repo has no
    // `pnpm-workspace.yaml` catalog, and that absence is a skipped check rather
    // than a red one.
    const catalog = readCatalogToonVersion(ctx.root);
    const observed = await (options.readToolVersion ?? readObservedToolVersion)("tq");
    const recordedVersion = getConfig(config, "host_binaries.tq.version");
    hostBinaries = auditHostBinaries([
      {
        name: "tq",
        catalog,
        ...(recordedVersion ? { recordedVersion } : {}),
        ...(observed ? { observedVersion: observed } : {}),
      },
    ]);
  } catch (error) {
    notes.push(`host binary pin audit skipped: ${message(error)}`);
  }

  let marketplaceSources: MarketplaceSourceReport = { findings: [], rows: [] };
  try {
    const readList = options.readMarketplaceList ?? readHostMarketplaceList;
    const facts: MarketplaceSourceFacts[] = [];
    for (const host of MARKETPLACE_HOSTS) {
      const probe = await readList(host);
      const parsed = parseMarketplaceSource(probe.output, RED_SKILLS_MARKETPLACE);
      facts.push({
        host,
        // A CLI that is not installed registered nothing, so it can freeze
        // nothing; that is an ordinary machine, never a finding.
        hostPresent: probe.present,
        marketplace: RED_SKILLS_MARKETPLACE,
        kind: parsed.kind,
        ...(parsed.detail ? { detail: parsed.detail } : {}),
      });
    }
    marketplaceSources = auditMarketplaceSources(facts);
  } catch (error) {
    notes.push(`marketplace source audit unavailable: ${message(error)}`);
  }

  let dependencyEdges: DependencyEdgeReport = { findings: [], rows: [] };
  let dependencyEdgesUnread: number[] = [];
  if (ctx.repo) {
    try {
      const scan = await (options.listDependencyEdges ?? listDependencyEdgeTickets)(
        { cwd: ctx.root, repo: ctx.repo } satisfies GhContext,
      );
      dependencyEdges = auditDependencyEdges(scan.tickets);
      dependencyEdgesUnread = [...scan.unread];
    } catch (error) {
      notes.push(`dependency-edge audit unavailable: ${message(error)}`);
    }
  } else {
    notes.push("dependency-edge audit skipped: no issue tracker for this repo");
  }

  let askRedRouter: AskRedRouterCoverageReport = { findings: [], rows: [] };
  const registeredSkills = readRegisteredDevSkills(ctx.root);
  const routerText = readOptionalText(
    join(ctx.root, "plugins", "dev", "skills", "engineering", "ask-red", "SKILL.md"),
  );
  if (registeredSkills && routerText) {
    askRedRouter = auditAskRedRouterCoverage({
      registeredSkills,
      routerSkills: extractAskRedRouterSkills(routerText),
    });
  } else {
    notes.push("ask-red router sync skipped: this repo hosts no dev plugin manifest or router");
  }

  let redTaxonomy: RedTaxonomyReport = { findings: [] };
  try {
    redTaxonomy = auditRedTaxonomy(collectRedTaxonomyEntries(ctx.root));
  } catch (error) {
    notes.push(`.red taxonomy audit unavailable: ${message(error)}`);
  }

  const base = getConfig(config, "dev.trunk")?.trim() || "main";
  let unlandedDocs: UnlandedDocsDoctorReport = auditUnlandedDocs({ base, files: [] });
  try {
    unlandedDocs = auditUnlandedDocs(
      await (options.collectDocsSweep ?? collectDocsSweepInput)(ctx, base),
    );
  } catch (error) {
    notes.push(`unlanded .red docs audit unavailable: ${message(error)}`);
  }

  return {
    hooks,
    hookPoints,
    runtime,
    runtimeUnresolved,
    hostBinaries,
    marketplaceSources,
    dependencyEdges,
    dependencyEdgesUnread,
    askRedRouter,
    redTaxonomy,
    unlandedDocs,
    notes,
  };
}

/** What one host CLI answered when asked to list its marketplaces. */
export interface MarketplaceListProbe {
  /** False only when the CLI itself is not installed on this machine. */
  readonly present: boolean;
  /** The transcript; absent when the CLI could not answer. */
  readonly output?: string;
}

/**
 * List one host CLI's marketplaces. Read-only: it never adds, removes, or
 * updates a registration — repointing is the gated `--fix` lane's job.
 */
async function readHostMarketplaceList(host: MarketplaceHost): Promise<MarketplaceListProbe> {
  const { execTool } = await import("./exec.js");
  const result = await execTool(host, ["plugin", "marketplace", "list"], { timeoutMs: 20_000 });
  // 127 is the spawn failure `execTool` reports for a binary that does not
  // resolve — an uninstalled host, not an unreadable one.
  if (result.code === 127) return { present: false };
  if (result.code !== 0) return { present: true };
  return { present: true, output: result.stdout };
}

/** Observe an installed host binary's version. Never installs or upgrades it. */
async function readObservedToolVersion(tool: string): Promise<string | undefined> {
  const { execTool } = await import("./exec.js");
  const result = await execTool(tool, ["--version"], {});
  if (result.code !== 0) return undefined;
  return /(\d+\.\d+\.\d+)/.exec(result.stdout)?.[1];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
