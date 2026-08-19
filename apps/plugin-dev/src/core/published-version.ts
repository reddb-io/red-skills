import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compareSemver,
  fetchNpmNewestDevBundleVersion,
  readDevBundleCacheState,
  redSkillsCacheDir,
  semverParts,
} from "./bundle-version.js";
import { decodeDevSnapshotSniff, encodeDevSnapshotToon } from "./toon-snapshot.js";

/**
 * ONE owner answers "what version is published" (#2809). The Worker boot probe
 * and every reporting surface derive from this module, so a dashboard can no
 * longer contradict the path that halts a boot. The two-source contradiction
 * ADR 0128 §5 forbids for liveness is forbidden here for version.
 *
 * The resolution is deliberately independent of the CALLER's running bundle: the
 * answer must not change with who is asking. Substituting the caller's own
 * version as "the published one" is exactly the bug this replaces — it
 * manufactures a confident `version_skew: 0` out of a value that measured
 * nothing. The host's installed plugin is a different thing and does count
 * (#2924): it is an operator's declared intent, read off disk, identical for
 * every asker on the host — not the asker's own version reflected back.
 */

/** How long a recorded registry answer stays current before it reads as stale. */
export const PUBLISHED_VERSION_STALE_AFTER_MS = 30 * 60_000;

/**
 * Where the published-version answer came from. `registry` is a live read;
 * `recorded` replays the last registry read this host made; `installed-plugin`
 * is the operator's declared intent — somebody chose to install that version,
 * which proves publication and local availability but not currency (#2924);
 * `bundle-cache` is the weakest — a downloaded bundle proves that version was
 * published once, but nothing vouches for it still being the newest.
 */
export type PublishedVersionSource = "registry" | "recorded" | "installed-plugin" | "bundle-cache" | "unresolved";

export type PublishedVersionReason = "fresh" | "aged-out" | "installed-only" | "cache-only" | "never-observed";

/**
 * The published-version answer WITH its own currency attached (ADR 0128 §6).
 * Staleness travels inside the payload so no consumer can render a cached read
 * as current, and `version === null` is unknown — a distinct answer from a
 * measured match, never collapsed into one (#2752).
 */
export interface PublishedVersionObservation {
  readonly version: string | null;
  readonly source: PublishedVersionSource;
  /** Milliseconds since the answer was observed; -1 when it was never observed. */
  readonly age_ms: number;
  readonly stale_after_ms: number;
  readonly stale: boolean;
  readonly reason: PublishedVersionReason;
}

export interface PublishedVersionRecord {
  readonly version: string;
  readonly observedAtMs: number;
}

export interface PublishedVersionInputs {
  /** A live registry read, when the caller just performed one. */
  readonly fetched?: string | undefined;
  readonly record?: PublishedVersionRecord | null;
  /** Newest RedSkills plugin version installed on this host, from the plugin cache. */
  readonly installed?: string | undefined;
  /** Newest version this host has a bundle for, from the local bundle cache. */
  readonly cached?: string | undefined;
  readonly nowMs?: number;
  readonly staleAfterMs?: number;
}

export function publishedVersionRecordPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(redSkillsCacheDir(env), "dev-published.toon");
}

/**
 * Resolve the published version from the evidence at hand. Pure — every source
 * is passed in, so the boot probe and the reporting surfaces can be shown to
 * agree on identical inputs.
 */
export function resolvePublishedVersion(inputs: PublishedVersionInputs): PublishedVersionObservation {
  const staleAfterMs = inputs.staleAfterMs ?? PUBLISHED_VERSION_STALE_AFTER_MS;
  const nowMs = inputs.nowMs ?? Date.now();

  const fetched = normalizeVersion(inputs.fetched);
  if (fetched) {
    return { version: fetched, source: "registry", age_ms: 0, stale_after_ms: staleAfterMs, stale: false, reason: "fresh" };
  }

  const recorded = inputs.record && normalizeVersion(inputs.record.version) ? inputs.record : null;
  const recordedAgeMs = recorded ? Math.max(0, nowMs - recorded.observedAtMs) : -1;
  const recordedStale = recorded ? recordedAgeMs > staleAfterMs : true;
  const recordedObservation = (): PublishedVersionObservation => ({
    version: (recorded as PublishedVersionRecord).version,
    source: "recorded",
    age_ms: recordedAgeMs,
    stale_after_ms: staleAfterMs,
    stale: recordedStale,
    reason: recordedStale ? "aged-out" : "fresh",
  });
  if (recorded && !recordedStale) return recordedObservation();

  // An installed plugin is an operator's decision, a cached bundle only a
  // byproduct of once having run a version — so intent outranks the byproduct
  // (#2924). It stays below an aged-out record that already proved a NEWER
  // publication: adding intent must never walk the answer backwards.
  const installed = normalizeVersion(inputs.installed);
  if (installed && !(recorded && compareSemver(recorded.version, installed) > 0)) {
    return {
      version: installed,
      source: "installed-plugin",
      age_ms: -1,
      stale_after_ms: staleAfterMs,
      stale: true,
      reason: "installed-only",
    };
  }

  if (recorded) return recordedObservation();

  const cached = normalizeVersion(inputs.cached);
  if (cached) {
    // A cached bundle proves publication but not currency, so it is always
    // stale: nothing here can say whether the registry moved past it.
    return { version: cached, source: "bundle-cache", age_ms: -1, stale_after_ms: staleAfterMs, stale: true, reason: "cache-only" };
  }

  // Unknown stays unknown. The alternative — substituting the installed version —
  // is what let `fleet_status` report a confident zero skew while every Worker
  // was boot-halting on the version it claimed to measure (#2809).
  return { version: null, source: "unresolved", age_ms: -1, stale_after_ms: staleAfterMs, stale: true, reason: "never-observed" };
}

/**
 * The single local read every surface uses: the recorded registry answer first,
 * the bundle cache as weaker fallback. No network, so a status render stays the
 * passive local read it is (ADR 0084).
 */
export function readPublishedBundleVersion(
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  staleAfterMs = PUBLISHED_VERSION_STALE_AFTER_MS,
): PublishedVersionObservation {
  return resolvePublishedVersion({
    record: readPublishedVersionRecord(env),
    installed: newestInstalledPluginVersion(env),
    cached: newestPublishedEvidenceInCache(env),
    nowMs,
    staleAfterMs,
  });
}

/** The agent homes an operator's RedSkills plugin install lands under. */
const PLUGIN_CACHE_AGENT_HOMES = [".claude", ".codex"] as const;

/**
 * Newest RedSkills plugin version installed on this host. A local directory
 * read: it costs no network call and no registry quota, which is why the answer
 * was available all along while every surface reported `cache-only` (#2924).
 */
export function newestInstalledPluginVersion(
  env: NodeJS.ProcessEnv = process.env,
  plugin = "dev",
): string | undefined {
  const home = env.HOME || homedir();
  let best: string | undefined;
  for (const agentHome of PLUGIN_CACHE_AGENT_HOMES) {
    let entries;
    try {
      entries = readdirSync(join(home, agentHome, "plugins", "cache", "red-skills", plugin), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const version = normalizeVersion(entry.name);
      if (!version) continue;
      if (best === undefined || compareSemver(version, best) > 0) best = version;
    }
  }
  return best;
}

/** Read the last registry answer this host recorded. */
export function readPublishedVersionRecord(env: NodeJS.ProcessEnv = process.env): PublishedVersionRecord | null {
  try {
    const parsed = decodeDevSnapshotSniff(readFileSync(publishedVersionRecordPath(env), "utf8"));
    const rec = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const version = normalizeVersion(typeof rec.version === "string" ? rec.version : undefined);
    const observedAtMs = Number(rec.observed_at_ms);
    if (!version || !Number.isFinite(observedAtMs)) return null;
    return { version, observedAtMs };
  } catch {
    return null;
  }
}

/** Record a registry answer so every later surface replays it instead of guessing. */
export function writePublishedVersionRecord(
  record: PublishedVersionRecord,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const path = publishedVersionRecordPath(env);
    mkdirSync(redSkillsCacheDir(env), { recursive: true });
    writeFileSync(path, encodeDevSnapshotToon({ version: record.version, observed_at_ms: record.observedAtMs }), "utf8");
  } catch {
    // A cache we cannot write costs the replay, never the caller's boot.
  }
}

/**
 * Consult the registry and record the answer, so the one path that pays for the
 * network call feeds every path that cannot.
 */
export async function refreshPublishedBundleVersion(
  installedVersion: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
  fetchNewest = fetchNpmNewestDevBundleVersion,
): Promise<PublishedVersionObservation> {
  const fetched = await fetchNewest(installedVersion);
  if (normalizeVersion(fetched)) writePublishedVersionRecord({ version: fetched as string, observedAtMs: nowMs }, env);
  return resolvePublishedVersion({
    fetched,
    record: readPublishedVersionRecord(env),
    installed: newestInstalledPluginVersion(env),
    cached: newestPublishedEvidenceInCache(env),
    nowMs,
  });
}

/** The version block every operator-facing status payload carries, verbatim. */
export interface PublishedVersionReport {
  readonly bundle_latest: string;
  /** 1 when the running bundle version was never measured (#2752). */
  readonly version_unknown: number;
  /** 1 when the published version could not be resolved at all (#2809). */
  readonly published_unknown: number;
  readonly version_skew: number;
  readonly published_version: {
    readonly version: string;
    readonly source: PublishedVersionSource;
    readonly age_ms: number;
    readonly stale_after_ms: number;
    readonly stale: boolean;
    readonly reason: PublishedVersionReason;
  };
}

/**
 * ONE projection builds the version block for every surface, so the MCP tool and
 * the CLI cannot drift into two different verdicts from one observation.
 * A skew verdict requires BOTH sides measured: an unresolved published version
 * reports `published_unknown`, never a confident `version_skew: 0`.
 */
export function publishedVersionReport(
  bundleVersion: string | undefined,
  published: PublishedVersionObservation,
): PublishedVersionReport {
  const running = normalizeVersion(bundleVersion) ?? (bundleVersion?.trim() ? bundleVersion.trim() : undefined);
  const latest = published.version;
  return {
    bundle_latest: latest ?? "",
    version_unknown: Number(!running),
    published_unknown: Number(!latest),
    version_skew: Number(Boolean(running && latest && running !== latest)),
    published_version: {
      version: latest ?? "",
      source: published.source,
      age_ms: published.age_ms,
      stale_after_ms: published.stale_after_ms,
      stale: published.stale,
      reason: published.reason,
    },
  };
}

/**
 * Newest bundle present in the local cache, resolved against a zero floor rather
 * than the caller's installed version — the published answer must not depend on
 * who asks.
 */
function newestPublishedEvidenceInCache(env: NodeJS.ProcessEnv): string | undefined {
  const state = readDevBundleCacheState("0.0.0", env);
  const candidates = [state.laneNewestVersion, state.pointerVersion].filter(
    (v): v is string => Boolean(normalizeVersion(v)),
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((best, v) => (compareSemver(v, best) > 0 ? v : best));
}

function normalizeVersion(value: string | undefined | null): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed && semverParts(trimmed) ? trimmed : undefined;
}
