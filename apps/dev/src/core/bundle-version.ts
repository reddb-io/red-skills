import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  if (!semverParts(installedVersion)) return undefined;
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

