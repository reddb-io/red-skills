// engine-floor-check — the ONE reading every dispatch surface takes (#3031).
//
// `core/engine-floor.ts` decides; this collects the three facts it decides on —
// the declared policy, the version of the engine that would actually run, and
// the published dist-tag — so `/go`, `/go --scout` and the MCP `worker_dispatch`
// cannot drift into three different verdicts about the same host.
//
// The engine version is the version of the bundle a Worker born right now would
// RUN (`publishedEntryVersion`), not the version of the process asking. Those
// differ exactly when it matters: a caller behind the published lane is
// redirected to the published bundle (#2808), so flooring the caller's own
// build-info would refuse dispatches whose engine was fine and pass ones whose
// engine was not.
//
// The registry read is the only IO, and its failure is contained here: a throw
// becomes a `registryError` string that the pure evaluator degrades to a
// warning. Nothing in this module can make a dispatch die of being offline.

import { loadConfig, getConfig } from "../core/config.js";
import {
  evaluateEngineFloor,
  parseEngineFloorPolicy,
  ENGINE_FLOOR_CONFIG_KEY,
  type EngineFloorPolicy,
  type EngineFloorVerdict,
} from "../core/engine-floor.js";
import {
  refreshPublishedBundleVersion,
  type PublishedVersionObservation,
} from "../core/published-version.js";
import { publishedEntryVersion } from "./published-entry.js";
import { afkPaths } from "./wire/paths.js";

/** The env escape hatch, for a headless host that must dispatch NOW. */
export const ENGINE_FLOOR_ENV = "RED_DEV_ENGINE_FLOOR";

/** Everything a test poses as; a real dispatch passes none of it. */
export interface EngineFloorCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Override the declared policy (the env var, then config, decide by default). */
  readonly policy?: EngineFloorPolicy;
  /** Override the resolved engine version. */
  readonly engineVersion?: string;
  /** Resolve the published dist-tag; a throw is read as unreachable. */
  readonly resolvePublished?: (engineVersion: string | undefined) => Promise<PublishedVersionObservation>;
}

/**
 * Read the declared policy: the env override first (an operator at a keyboard
 * outranks a file), then `dev.dispatch.engine_floor`, then the default.
 */
export function resolveEngineFloorPolicy(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): EngineFloorPolicy {
  const override = String(env[ENGINE_FLOOR_ENV] ?? "").trim();
  if (override) return parseEngineFloorPolicy(override);
  const config = loadConfig(afkPaths(root).configPath, { warn: () => undefined });
  return parseEngineFloorPolicy(getConfig(config, ENGINE_FLOOR_CONFIG_KEY));
}

/**
 * Judge the engine this dispatch would run. Never throws: a verdict is owed
 * even — especially — when the machine underneath is broken.
 */
export async function checkDispatchEngineFloor(
  root: string,
  options: EngineFloorCheckOptions = {},
): Promise<EngineFloorVerdict> {
  const env = options.env ?? process.env;
  const policy = options.policy ?? resolveEngineFloorPolicy(root, env);
  const engineVersion = options.engineVersion ?? safeEngineVersion(env);

  // `off` reads nothing — no registry call, no cache write, no cost.
  if (policy === "off") {
    return evaluateEngineFloor({ engineVersion, published: null, policy });
  }

  const resolve =
    options.resolvePublished ??
    ((version: string | undefined) => refreshPublishedBundleVersion(version, env));
  try {
    const published = await resolve(engineVersion);
    return evaluateEngineFloor({ engineVersion, published, policy });
  } catch (error) {
    return evaluateEngineFloor({
      engineVersion,
      published: null,
      registryError: error instanceof Error ? error.message : String(error),
      policy,
    });
  }
}

function safeEngineVersion(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return publishedEntryVersion({ env });
  } catch {
    // `publishedEntryVersion` already swallows its own resolution failure; this
    // only covers a build-info read that cannot answer at all, which is
    // `engine-unknown` — a warning, never a silent pass.
    return undefined;
  }
}
