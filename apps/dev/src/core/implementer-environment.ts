import { pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";
import { parseConfigYaml } from "./config.js";

export const IMPLEMENTER_PLUGIN_NAMES = ["dev", "memory", "brain"] as const;
export type ImplementerPluginName = (typeof IMPLEMENTER_PLUGIN_NAMES)[number];

/**
 * Skills that can help an inner issue implementer change or verify code.
 * Operator/queue ownership flows (afk, go, triage, manager, dashboards, setup)
 * and the dev knowledge/productivity buckets stay out of the default payload.
 */
export const DEFAULT_IMPLEMENTER_DEV_SKILLS = [
  "code-review",
  "context",
  "diagnose",
  "ground-truth",
  "migrate-to-shoehorn",
  "prototype",
  "resolving-merge-conflicts",
  "setup-pre-commit",
  "tdd",
  "verify",
  "zoom-out",
] as const;

export interface ImplementerSkill {
  plugin: ImplementerPluginName;
  name: string;
  /** Absolute path to the skill directory in the installed/source plugin. */
  path: string;
}

export interface ImplementerProjection {
  source: "implementer-default" | "operator-allowlist";
  enabledPlugins: ImplementerPluginName[];
  catalog: ImplementerSkill[];
  skills: ImplementerSkill[];
  excluded: ImplementerSkill[];
}

export interface BeforeAfterDelta {
  before: number;
  after: number;
  delta: number;
}

export interface ImplementerMetrics {
  version: 1;
  projection: ImplementerProjection["source"];
  enabled_plugins: ImplementerPluginName[];
  /** Catalog discovery/projection construction only; not runner boot. */
  projection_setup_time_ms: BeforeAfterDelta;
  /** Invocation to first runner stream event, against a historical baseline. */
  runner_startup_ms: BeforeAfterDelta;
  /** Exact bytes of the serialized plugin manifests read at runner discovery. */
  skill_manifest_bytes: BeforeAfterDelta;
  skill_count: BeforeAfterDelta;
}

const ALLOWLIST_KEY = "plugins.dev.afk.implementer.skills";

function parseAllowlist(configText: string): Set<string> | undefined {
  let parsed: Record<string, string>;
  try {
    parsed = parseConfigYaml(configText);
  } catch {
    return undefined;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, ALLOWLIST_KEY))
    return undefined;
  return new Set(
    (parsed[ALLOWLIST_KEY] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function defaultIncludes(skill: ImplementerSkill): boolean {
  if (skill.plugin !== "dev") return true;
  return (DEFAULT_IMPLEMENTER_DEV_SKILLS as readonly string[]).includes(
    skill.name,
  );
}

/**
 * Resolve the implementer-visible skill catalog from ADR 0067 activation gates.
 * An explicit allowlist replaces (rather than extends) the default selection,
 * but it can never make a disabled plugin visible.
 */
export function resolveImplementerProjection(
  configText: string,
  catalog: readonly ImplementerSkill[],
): ImplementerProjection {
  const enabledPlugins = IMPLEMENTER_PLUGIN_NAMES.filter((plugin) =>
    pluginEnabledInConfig(configText, plugin),
  );
  const enabled = new Set<ImplementerPluginName>(enabledPlugins);
  const allowlist = parseAllowlist(configText);
  const selected = catalog.filter((skill) => {
    if (!enabled.has(skill.plugin)) return false;
    if (allowlist) return allowlist.has(`${skill.plugin}:${skill.name}`);
    return defaultIncludes(skill);
  });
  const selectedPaths = new Set(selected.map((skill) => skill.path));

  return {
    source: allowlist ? "operator-allowlist" : "implementer-default",
    enabledPlugins,
    catalog: [...catalog],
    skills: selected,
    excluded: catalog.filter((skill) => !selectedPaths.has(skill.path)),
  };
}

function delta(before: number, after: number): BeforeAfterDelta {
  return { before, after, delta: after - before };
}

/** Build the stable, dashboard-readable metrics payload written per run. */
export function buildImplementerMetrics(
  projection: ImplementerProjection,
  measurements: {
    legacyProjectionSetupMs: number;
    projectedProjectionSetupMs: number;
    historicalRunnerStartupMs: number;
    projectedRunnerStartupMs: number;
    legacySkillManifestBytes: number;
    projectedSkillManifestBytes: number;
  },
): ImplementerMetrics {
  return {
    version: 1,
    projection: projection.source,
    enabled_plugins: projection.enabledPlugins,
    projection_setup_time_ms: delta(
      measurements.legacyProjectionSetupMs,
      measurements.projectedProjectionSetupMs,
    ),
    runner_startup_ms: delta(
      measurements.historicalRunnerStartupMs,
      measurements.projectedRunnerStartupMs,
    ),
    skill_manifest_bytes: delta(
      measurements.legacySkillManifestBytes,
      measurements.projectedSkillManifestBytes,
    ),
    skill_count: delta(projection.catalog.length, projection.skills.length),
  };
}
