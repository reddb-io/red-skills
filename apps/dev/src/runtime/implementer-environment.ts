import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import {
  IMPLEMENTER_PLUGIN_NAMES,
  buildImplementerMetrics,
  resolveImplementerProjection,
  type ImplementerMetrics,
  type ImplementerPluginName,
  type ImplementerSkill,
} from "../core/implementer-environment.js";
import type { ImplementerRuntimeProjection } from "../core/execution.js";
import { assertDevSnapshotToonLossless } from "../core/toon-snapshot.js";

export type ImplementerPluginRoots = Partial<
  Record<ImplementerPluginName, string>
>;

export interface PreparedImplementerEnvironment {
  runtime: ImplementerRuntimeProjection;
  metrics: ImplementerMetrics;
  artifactPath: string;
}

interface PluginManifest {
  name?: string;
  skills?: string[];
  [key: string]: unknown;
}

function skillDirs(entry: string): string[] {
  const skillFile = join(entry, "SKILL.md");
  if (existsSync(skillFile)) return [entry];
  if (!existsSync(entry)) return [];
  return readdirSync(entry, { withFileTypes: true })
    .filter((item) => item.isDirectory() || item.isSymbolicLink())
    .flatMap((item) => skillDirs(join(entry, item.name)));
}

function frontmatterValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(text);
  return match?.[1]?.trim();
}

function readManifest(
  pluginRoot: string,
  host: "claude" | "codex",
): PluginManifest {
  const path = join(pluginRoot, `.${host}-plugin`, "plugin.json");
  return JSON.parse(readFileSync(path, "utf8")) as PluginManifest;
}

export function discoverImplementerCatalog(
  pluginRoots: ImplementerPluginRoots,
): ImplementerSkill[] {
  return IMPLEMENTER_PLUGIN_NAMES.flatMap((plugin) => {
    const root = pluginRoots[plugin];
    if (!root) return [];
    const manifest = readManifest(root, "claude");
    return (manifest.skills ?? []).flatMap((entry) =>
      skillDirs(join(root, entry)).map((path) => {
        const skillFile = join(path, "SKILL.md");
        const text = readFileSync(skillFile, "utf8");
        const name = frontmatterValue(text, "name") ?? basename(path);
        const description = frontmatterValue(text, "description") ?? "";
        const catalogLine = `${plugin}:${name}\n${description}\n${skillFile}\n`;
        return {
          plugin,
          name,
          path,
          payloadBytes: Buffer.byteLength(catalogLine, "utf8"),
        };
      }),
    );
  });
}

function newestVersionDir(root: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const versions = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return versions[0] ? join(root, versions[0]) : undefined;
}

/** Locate RedSkills plugin roots without requiring every plugin to be installed. */
export function resolveImplementerPluginRoots(input: {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  userHome?: string;
}): ImplementerPluginRoots {
  const env = input.env ?? process.env;
  const userHome = input.userHome ?? homedir();
  const activeRoot = env.CODEX_PLUGIN_ROOT || env.CLAUDE_PLUGIN_ROOT;
  const activePluginsRoot = activeRoot ? dirname(activeRoot) : undefined;
  const roots: ImplementerPluginRoots = {};
  for (const plugin of IMPLEMENTER_PLUGIN_NAMES) {
    const candidates = [
      join(input.repoRoot, "plugins", plugin),
      activePluginsRoot ? join(activePluginsRoot, plugin) : undefined,
      join(
        userHome,
        ".codex",
        ".tmp",
        "marketplaces",
        "red-skills",
        "plugins",
        plugin,
      ),
      newestVersionDir(
        join(userHome, ".codex", "plugins", "cache", "red-skills", plugin),
      ),
      newestVersionDir(
        join(userHome, ".claude", "plugins", "cache", "red-skills", plugin),
      ),
    ];
    const found = candidates.find((candidate): candidate is string =>
      Boolean(
        candidate &&
        existsSync(join(candidate, ".claude-plugin", "plugin.json")),
      ),
    );
    if (found) roots[plugin] = found;
  }
  return roots;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function copy(source: string, target: string): void {
  if (!existsSync(source) || existsSync(target)) return;
  ensureParent(target);
  cpSync(source, target, { recursive: true, dereference: true });
}

function writeProjectedPlugin(
  plugin: ImplementerPluginName,
  sourceRoot: string,
  targetRoot: string,
  skills: readonly ImplementerSkill[],
): void {
  rmSync(targetRoot, { recursive: true, force: true });
  cpSync(sourceRoot, targetRoot, { recursive: true, dereference: true });
  const relativeSkills = skills.map(
    (skill) => `./${relative(sourceRoot, skill.path)}`,
  );
  const selectedSkillPaths = new Set(
    skills.map((skill) => relative(sourceRoot, skill.path)),
  );
  for (const skillPath of skillDirs(join(targetRoot, "skills"))) {
    if (!selectedSkillPaths.has(relative(targetRoot, skillPath))) {
      // A plugin hook may execute a helper below an operator-facing skill
      // directory (branch-lock is one example). Keep those runtime assets but
      // remove the discovery entrypoint so the skill is not exposed.
      rmSync(join(skillPath, "SKILL.md"), { force: true });
    }
  }
  for (const host of ["claude", "codex"] as const) {
    const manifest = {
      ...readManifest(sourceRoot, host),
      skills: relativeSkills,
    };
    const target = join(targetRoot, `.${host}-plugin`, "plugin.json");
    ensureParent(target);
    writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  // Keep the plugin name discoverable even when an enabled plugin has no skills.
  if (skills.length === 0)
    mkdirSync(join(targetRoot, "skills"), { recursive: true });
  void plugin;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexOverrides(
  projection: ReturnType<typeof resolveImplementerProjection>,
): string[] {
  const enabled = new Set(projection.enabledPlugins);
  const overrides = IMPLEMENTER_PLUGIN_NAMES.map(
    (plugin) =>
      `plugins.${tomlString(`${plugin}@red-skills`)}.enabled=${String(enabled.has(plugin))}`,
  );
  const disabledSkillPaths = projection.excluded
    .filter((skill) => enabled.has(skill.plugin))
    .map(
      (skill) =>
        `{path=${tomlString(join(skill.path, "SKILL.md"))},enabled=false}`,
    );
  if (disabledSkillPaths.length > 0) {
    overrides.push(`skills.config=[${disabledSkillPaths.join(",")}]`);
  }
  return overrides;
}

export function prepareImplementerEnvironment(input: {
  attemptDir: string;
  configText: string;
  pluginRoots: ImplementerPluginRoots;
  nowMs?: () => number;
}): PreparedImplementerEnvironment {
  const nowMs = input.nowMs ?? (() => performance.now());
  const legacyStarted = nowMs();
  const catalog = discoverImplementerCatalog(input.pluginRoots);
  const legacyBootMs = Math.max(0, nowMs() - legacyStarted);

  const projectedStarted = nowMs();
  const projection = resolveImplementerProjection(input.configText, catalog);
  const runtimeRoot = join(input.attemptDir, "implementer");
  const pluginDirs: string[] = [];
  for (const plugin of projection.enabledPlugins) {
    const sourceRoot = input.pluginRoots[plugin];
    if (!sourceRoot) {
      throw new Error(
        `enabled implementer plugin '${plugin}' is not installed`,
      );
    }
    const target = join(runtimeRoot, "plugins", plugin);
    writeProjectedPlugin(
      plugin,
      sourceRoot,
      target,
      projection.skills.filter((skill) => skill.plugin === plugin),
    );
    pluginDirs.push(target);
  }
  const opencodeConfigDir = join(runtimeRoot, "opencode");
  for (const skill of projection.skills) {
    copy(
      skill.path,
      join(opencodeConfigDir, "skills", `${skill.plugin}-${skill.name}`),
    );
  }
  const projectedBootMs = Math.max(0, nowMs() - projectedStarted);
  const metrics = buildImplementerMetrics(projection, {
    legacyBootMs,
    projectedBootMs,
  });
  const artifactPath = join(input.attemptDir, "implementer-runtime.toon");
  writeFileSync(
    artifactPath,
    assertDevSnapshotToonLossless({
      ...metrics,
      skills: projection.skills.map((skill) => `${skill.plugin}:${skill.name}`),
    } as unknown as Parameters<typeof assertDevSnapshotToonLossless>[0]),
    "utf8",
  );

  return {
    runtime: {
      claudePluginDirs: pluginDirs,
      codexConfigOverrides: codexOverrides(projection),
      opencodeConfigDir,
    },
    metrics,
    artifactPath,
  };
}
