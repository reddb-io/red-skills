import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchNewestSameMajor } from "@reddb-io/shared/bundle-fetch.js";
import { pointerFileName, readPointer, statusFileName, type SelfUpdateStateRecord } from "@reddb-io/shared/self-update.js";
import { decodeDevSnapshotSniff } from "./toon-snapshot.js";

export function semverParts(version: string | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareSemver(a: string | undefined, b: string | undefined): number {
  const pa = semverParts(a);
  const pb = semverParts(b);
  if (!pa || !pb) return 0;
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

export function redSkillsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.RED_SKILLS_CACHE_DIR) return env.RED_SKILLS_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "red-skills", "bundles");
  return join(homedir(), ".cache", "red-skills", "bundles");
}

export function newestCachedDevBundleVersion(
  installedVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return newestCachedBundleVersion("dev", installedVersion, env);
}

export function newestCachedBundleVersion(
  plugin: string,
  installedVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!semverParts(installedVersion)) return undefined;
  const cacheDir = redSkillsCacheDir(env);
  let best: string | undefined;
  const pattern = new RegExp(`^${escapeRegExp(plugin)}-(\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?)\\.bundle\\.min\\.mjs$`);
  try {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const m = pattern.exec(entry.name);
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

export interface DevBundleCacheState {
  readonly installedVersion?: string;
  readonly pointerVersion?: string;
  readonly laneNewestVersion?: string;
  readonly lastFailureAtMs?: number;
  readonly lastFailureAgeMs?: number;
  readonly lastError?: string;
}

export function readDevBundleCacheState(
  installedVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): DevBundleCacheState {
  const cacheDir = redSkillsCacheDir(env);
  const pointerVersion = readPointerVersion(join(cacheDir, pointerFileName("dev")));
  const laneNewestVersion = newestCachedDevBundleVersion(installedVersion, env);
  const state = readSelfUpdateState(join(cacheDir, statusFileName("dev")));
  // A failure only counts once it is newer than the last success — the same rule
  // `resolveActiveVersionDetailed` applies. Without it a single old failure keeps
  // the coherence probe red forever, however many checks have succeeded since.
  const live =
    state.lastFailureAtMs !== undefined && state.lastFailureAtMs > (state.lastSuccessAtMs ?? 0)
      ? state
      : {};
  return {
    ...(installedVersion ? { installedVersion } : {}),
    ...(pointerVersion ? { pointerVersion } : {}),
    ...(laneNewestVersion ? { laneNewestVersion } : {}),
    ...(live.lastFailureAtMs !== undefined ? { lastFailureAtMs: live.lastFailureAtMs } : {}),
    ...(live.lastFailureAtMs !== undefined ? { lastFailureAgeMs: Math.max(0, nowMs - live.lastFailureAtMs) } : {}),
    ...(live.lastError ? { lastError: live.lastError } : {}),
  };
}

/**
 * The published dev bundle version this host would run — the single definition
 * of "published" shared by the boot probe (which reports `version_skew` against
 * it) and the fleet launch (which must spawn the supervisor from it, #2808).
 * Both reading the same function is what makes the probe's prescribed fix true:
 * after a launch, the supervisor's version IS the version the probe compares to.
 *
 * Returns undefined when the installed version is not a semver point at all —
 * an unresolvable published version, which the launch must report loudly rather
 * than paper over with the caller's own bundle.
 */
export function resolvePublishedDevBundleVersion(
  installedVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!semverParts(installedVersion)) return undefined;
  const cached = newestCachedDevBundleVersion(installedVersion, env);
  return cached && compareSemver(cached, installedVersion) > 0 ? cached : installedVersion;
}

export async function fetchNpmNewestDevBundleVersion(
  installedVersion: string | undefined,
  fetchText: (url: string) => Promise<string> = async (url) => {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return await res.text();
  },
): Promise<string | undefined> {
  const installed = installedVersion ?? "";
  if (!semverParts(installed)) return undefined;
  return (await fetchNewestSameMajor({ fetchText }, installed)) ?? undefined;
}

function readPointerVersion(path: string): string | undefined {
  try {
    const version = readPointer(readFileSync(path, "utf8"));
    return version || undefined;
  } catch {
    return undefined;
  }
}

function readSelfUpdateState(path: string): SelfUpdateStateRecord {
  try {
    const parsed = decodeDevSnapshotSniff(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      ...(Number.isFinite(parsed.lastSuccessAtMs) ? { lastSuccessAtMs: Number(parsed.lastSuccessAtMs) } : {}),
      ...(Number.isFinite(parsed.lastFailureAtMs) ? { lastFailureAtMs: Number(parsed.lastFailureAtMs) } : {}),
      ...(typeof parsed.lastError === "string" ? { lastError: parsed.lastError } : {}),
    };
  } catch {
    return {};
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
