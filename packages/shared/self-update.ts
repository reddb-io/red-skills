/**
 * self-update.ts — background, in-range bundle self-update (ADR 0084, amended by
 * ADR 0091 for the npm transport cutover).
 *
 * ADR 0038/0058 pin every installation to the bundle for its *installed* plugin
 * version (read from `.claude-plugin/plugin.json`). That is safe but forces an
 * operational dance: to run a just-released fix you hand-download the new bundle
 * into the cache. This module ends that dance. On an enabled session start the
 * launcher spawns a **background** check — is there a newer version within the
 * compatible range (same channel, same major)? Discovery now queries the **npm
 * registry** for the package's published versions (ADR 0091) instead of the
 * phantom `releases/download/v1/` release ref that never existed. If a newer
 * in-range version is found, it materialises the pinned npm bundle and atomically
 * swaps a *pointer* so the **next** session serves it. The current session is
 * never touched.
 *
 * Two hard invariants, both encoded structurally here:
 *
 *   1. **Never synchronous in a render/hook path.** {@link resolveActiveVersion}
 *      — the function the launcher calls while serving — touches only
 *      `exists`/`readFile`. It CANNOT fetch (the statusline went blank once
 *      because a launcher fetched synchronously in the render; that class stays
 *      dead). The actual fetch lives in {@link backgroundSelfUpdate}, which the
 *      launcher runs as a detached process.
 *   2. **Out-of-range jumps are never auto-applied.** A new major or an explicit
 *      pin stays an operator action ({@link selectInRangeUpdate} rejects any
 *      different-major candidate).
 *
 * Like `bundle-fetch.ts`, this module holds ZERO real IO: every side effect is
 * injected via {@link SelfUpdateIO}. The launcher wires node built-ins; the test
 * wires in-memory fakes, so the whole policy is unit-testable with no network.
 */

import { decode, encode, type JsonValue } from "@reddb-io/toon";

import {
  type BundleIO,
  ensureBundle,
  fetchNewestSameMajor,
  resolveBundle,
} from "./bundle-fetch.js";
import type { ReleaseChannel } from "./channel.js";

/**
 * IO surface for self-update: the {@link BundleIO} download/read/write/hash set
 * plus an atomic {@link rename} (write-temp-then-rename) for the pointer swap.
 */
export interface SelfUpdateIO extends BundleIO {
  readdir(path: string): Promise<readonly string[]>;
  rename(from: string, to: string): Promise<void>;
}

// ── Semver (compatible-range) policy ─────────────────────────────────────────

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a leading `x.y.z` out of a version string; null when it has no such prefix. */
export function parseSemver(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Compare two versions numerically (major, then minor, then patch). Unparseable → 0. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/**
 * The *compatible range* is the same major line: `1.140.0` and `1.145.2` are in
 * range; `2.0.0` is not. This is the boundary an auto-update must never cross.
 */
export function isInRange(installed: string, candidate: string): boolean {
  const pi = parseSemver(installed);
  const pc = parseSemver(candidate);
  return !!pi && !!pc && pi.major === pc.major;
}

/**
 * Decide the version to self-update to, or `null`. A candidate qualifies only
 * when the channel is `stable` (canary refreshes directly from npm's floating
 * dist-tag cache key — ADR 0058/0091), it is in the same major range as the
 * *installed* version, and it is strictly newer than `current` (the version
 * currently being served). Everything else — a downgrade, an equal version, a
 * new major, a canary — resolves to `null`, leaving the cache untouched.
 */
export function selectInRangeUpdate(opts: {
  installed: string;
  current: string;
  candidate: string;
  channel: ReleaseChannel;
}): string | null {
  const { installed, current, candidate, channel } = opts;
  if (channel !== "stable") return null;
  if (!isInRange(installed, candidate)) return null;
  if (compareSemver(candidate, current) <= 0) return null;
  return candidate;
}

// ── Pointer file (what the launcher serves next boot) ────────────────────────

/** Cache filename of the stable-channel self-update pointer for a plugin. */
export function pointerFileName(plugin: string): string {
  return `${plugin}-stable.current`;
}

/** Absolute pointer path inside the bundle cache. */
export function pointerPath(cacheDir: string, plugin: string): string {
  return joinPath(cacheDir, pointerFileName(plugin));
}

/** Cache filename of the stable-channel self-update status record for a plugin. */
export function statusFileName(plugin: string): string {
  return `${plugin}-stable.self-update.json`;
}

/** Absolute self-update status path inside the bundle cache. */
export function statusPath(cacheDir: string, plugin: string): string {
  return joinPath(cacheDir, statusFileName(plugin));
}

/** Serialise a pointer payload. */
function pointerContent(version: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version }));
}

/** Read a version out of a pointer body: `{ "version": "x" }` or a bare `x.y.z`. */
export function readPointer(text: string): string {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as { version?: unknown };
    if (parsed && typeof parsed.version === "string") return parsed.version.trim();
  } catch {
    /* fall through to a bare-version tolerance */
  }
  return /^\d+\.\d+\.\d+/.test(trimmed) ? trimmed : "";
}

export interface SelfUpdateStateRecord {
  lastCheckAtMs?: number;
  lastSuccessAtMs?: number;
  lastFailureAtMs?: number;
  lastError?: string;
  lastStatus?: SelfUpdateStatus;
}

function readState(text: string): SelfUpdateStateRecord {
  try {
    const body = text.trim();
    if (!body) return {};
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      const decoded = decode(body);
      parsed = decoded && typeof decoded === "object" && !Array.isArray(decoded)
        ? decoded as Record<string, unknown>
        : {};
    }
    const out: SelfUpdateStateRecord = {};
    if (Number.isFinite(parsed.lastCheckAtMs)) out.lastCheckAtMs = Number(parsed.lastCheckAtMs);
    if (Number.isFinite(parsed.lastSuccessAtMs)) out.lastSuccessAtMs = Number(parsed.lastSuccessAtMs);
    if (Number.isFinite(parsed.lastFailureAtMs)) out.lastFailureAtMs = Number(parsed.lastFailureAtMs);
    if (typeof parsed.lastError === "string") out.lastError = parsed.lastError;
    if (
      parsed.lastStatus === "updated" ||
      parsed.lastStatus === "up-to-date" ||
      parsed.lastStatus === "skipped-channel" ||
      parsed.lastStatus === "error"
    ) {
      out.lastStatus = parsed.lastStatus;
    }
    return out;
  } catch {
    return {};
  }
}

async function readStateFile(
  io: Pick<SelfUpdateIO, "exists" | "readFile">,
  cacheDir: string,
  plugin: string,
): Promise<SelfUpdateStateRecord> {
  const path = statusPath(cacheDir, plugin);
  try {
    if (!(await io.exists(path))) return {};
    return readState(new TextDecoder().decode(await io.readFile(path)));
  } catch {
    return {};
  }
}

async function writeStateFile(
  io: Pick<SelfUpdateIO, "exists" | "readFile" | "writeFile">,
  cacheDir: string,
  plugin: string,
  patch: SelfUpdateStateRecord,
): Promise<void> {
  const prior = await readStateFile(io, cacheDir, plugin);
  await io.writeFile(statusPath(cacheDir, plugin), new TextEncoder().encode(`${encode(toJsonValue({ ...prior, ...patch }))}\n`));
}

async function tryWriteStateFile(
  io: Pick<SelfUpdateIO, "exists" | "readFile" | "writeFile">,
  cacheDir: string,
  plugin: string,
  patch: SelfUpdateStateRecord,
): Promise<void> {
  try {
    await writeStateFile(io, cacheDir, plugin, patch);
  } catch {
    /* self-update status is diagnostic; it must never break serving */
  }
}

export interface ResolveActiveVersionInput {
  plugin: string;
  installedVersion: string;
  cacheDir: string;
  channel: ReleaseChannel;
}

export interface ResolveActiveVersionOptions {
  nowMs?: number;
  staleAfterMs?: number;
}

export interface ActiveVersionResolution {
  version: string;
  pointerVersion?: string;
  laneNewestVersion?: string;
  reconciled?: {
    from?: string;
    to: string;
  };
  staleFailure?: {
    ageMs: number;
    lastError?: string;
  };
  /** The persisted verdict together with when it was formed. A status without
   * this age is not evidence about the current registry horizon. */
  selfUpdateStatus?: {
    status: SelfUpdateStatus;
    checkedAtMs: number;
    ageMs: number;
  };
  /** A successful registry check loses its authority at the same boundary as a
   * failed check. Callers can distinguish stale success from live evidence. */
  staleSuccess?: {
    status: "updated" | "up-to-date";
    ageMs: number;
  };
  logNotes: string[];
}

export const DEFAULT_SELF_UPDATE_STALE_AFTER_MS = 4 * 60 * 60 * 1000;

/**
 * The version the launcher should serve **right now**, using only local reads.
 *
 * Reads the self-update pointer and honours it only when it is a real in-range,
 * non-downgrade version whose cached bundle actually exists; otherwise falls
 * back to the installed version. This is the render/hook-path entry point — it
 * takes `Pick<SelfUpdateIO, "exists" | "readFile">`, so it is *type-level*
 * impossible for it to reach the network. That impossibility is the fix for the
 * blank-statusline class of bug.
 */
export async function resolveActiveVersion(
  io: Pick<SelfUpdateIO, "exists" | "readFile" | "writeFile" | "readdir" | "rename">,
  input: ResolveActiveVersionInput,
): Promise<string> {
  return (await resolveActiveVersionDetailed(io, input)).version;
}

export async function resolveActiveVersionDetailed(
  io: Pick<SelfUpdateIO, "exists" | "readFile" | "writeFile" | "readdir" | "rename">,
  input: ResolveActiveVersionInput,
  options: ResolveActiveVersionOptions = {},
): Promise<ActiveVersionResolution> {
  const { plugin, installedVersion, cacheDir, channel } = input;
  // Canary keys by the floating dist-tag, not a version; only stable has a pointer.
  if (channel !== "stable" || !installedVersion) {
    return { version: installedVersion, logNotes: [] };
  }

  const ptr = pointerPath(cacheDir, plugin);
  let pointed = "";
  try {
    if (await io.exists(ptr)) {
      pointed = readPointer(new TextDecoder().decode(await io.readFile(ptr)));
    }
  } catch {
    pointed = "";
  }
  let version = installedVersion;
  let pointerVersion: string | undefined;
  if (pointed && isInRange(installedVersion, pointed) && compareSemver(pointed, installedVersion) >= 0) {
    const bundle = resolveBundle({ plugin, version: pointed, cacheDir, channel });
    if (await io.exists(bundle)) {
      version = pointed;
      pointerVersion = pointed;
    }
  }

  const logNotes: string[] = [];
  const laneNewestVersion = await newestCachedLaneVersion(io, { plugin, installedVersion, cacheDir });
  let reconciled: ActiveVersionResolution["reconciled"];
  if (laneNewestVersion && compareSemver(laneNewestVersion, version) > 0) {
    await swapPointer(io, cacheDir, plugin, laneNewestVersion);
    reconciled = { from: pointerVersion, to: laneNewestVersion };
    logNotes.push(
      `self-update reconciled pointer ${pointerVersion ?? "none"} -> ${laneNewestVersion} from cached lane`,
    );
    version = laneNewestVersion;
    pointerVersion = laneNewestVersion;
  }

  const state = await readStateFile(io, cacheDir, plugin);
  const nowMs = options.nowMs ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_SELF_UPDATE_STALE_AFTER_MS;
  const selfUpdateStatus =
    state.lastStatus !== undefined && state.lastCheckAtMs !== undefined
      ? {
          status: state.lastStatus,
          checkedAtMs: state.lastCheckAtMs,
          ageMs: Math.max(0, nowMs - state.lastCheckAtMs),
        }
      : undefined;
  let staleFailure: ActiveVersionResolution["staleFailure"];
  if (
    state.lastFailureAtMs !== undefined &&
    state.lastFailureAtMs > (state.lastSuccessAtMs ?? 0) &&
    nowMs - state.lastFailureAtMs > staleAfterMs
  ) {
    staleFailure = { ageMs: nowMs - state.lastFailureAtMs, lastError: state.lastError };
    logNotes.push(`self-update stale: last check failed ${formatAgeMs(staleFailure.ageMs)} ago`);
  }
  let staleSuccess: ActiveVersionResolution["staleSuccess"];
  if (
    selfUpdateStatus !== undefined &&
    (selfUpdateStatus.status === "updated" || selfUpdateStatus.status === "up-to-date")
  ) {
    logNotes.push(
      `self-update ${selfUpdateStatus.status}: checked ${formatAgeMs(selfUpdateStatus.ageMs)} ago`,
    );
    if (selfUpdateStatus.ageMs > staleAfterMs) {
      staleSuccess = {
        status: selfUpdateStatus.status,
        ageMs: selfUpdateStatus.ageMs,
      };
      logNotes.push(
        `self-update stale: last successful check was ${formatAgeMs(staleSuccess.ageMs)} ago`,
      );
    }
  }

  return {
    version,
    ...(pointerVersion ? { pointerVersion } : {}),
    ...(laneNewestVersion ? { laneNewestVersion } : {}),
    ...(reconciled ? { reconciled } : {}),
    ...(staleFailure ? { staleFailure } : {}),
    ...(selfUpdateStatus ? { selfUpdateStatus } : {}),
    ...(staleSuccess ? { staleSuccess } : {}),
    logNotes,
  };
}

// ── Background self-update (the only place a fetch happens) ───────────────────

export type SelfUpdateStatus =
  | "updated"
  | "up-to-date"
  | "skipped-channel"
  | "error";

export interface SelfUpdateResult {
  status: SelfUpdateStatus;
  /** The version the pointer now targets (`updated`) or is already on. */
  version?: string;
  /** Present only on `status: "error"`. */
  error?: string;
  attempts?: number;
}

export interface SelfUpdateInput {
  plugin: string;
  installedVersion: string;
  repo: string;
  cacheDir: string;
  channel: ReleaseChannel;
}

export interface SelfUpdateRunOptions {
  nowMs?: () => number;
}

export interface SelfUpdateRetryOptions extends SelfUpdateRunOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: { attempt: number; nextAttempt: number; delayMs: number; error?: string }) => void | Promise<void>;
}

/**
 * Best-effort, background, in-range self-update. **Never throws** — every
 * failure mode (offline, out-of-range candidate, checksum mismatch, malformed
 * manifest) resolves to a typed {@link SelfUpdateResult} and leaves the cache /
 * pointer untouched, so the already-cached bundle keeps serving and the check is
 * simply retried on a later boot. Do NOT call this from a render/hook path; the
 * launcher runs it as a detached process.
 *
 * Sequence: resolve the currently-served version → query the npm registry for
 * the newest same-major version → decide the in-range target → (if any)
 * materialise its pinned npm bundle → atomically swap the pointer (write temp,
 * rename over the live file). The pointer flips **last** and **atomically**, so a
 * half-written bundle is never pointed at and the swap is all-or-nothing.
 */
export async function backgroundSelfUpdate(
  io: SelfUpdateIO,
  input: SelfUpdateInput,
  options: SelfUpdateRunOptions = {},
): Promise<SelfUpdateResult> {
  const { plugin, installedVersion, repo, cacheDir, channel } = input;
  const nowMs = options.nowMs ?? Date.now;
  if (channel !== "stable" || !parseSemver(installedVersion)) {
    return { status: "skipped-channel" };
  }
  try {
    const current = await resolveActiveVersion(io, {
      plugin,
      installedVersion,
      cacheDir,
      channel,
    });
    // Registry discovery (ADR 0091): newest published same-major version. No
    // GitHub release ref is ever constructed.
    const candidate = await fetchNewestSameMajor(io, installedVersion);
    const target = candidate
      ? selectInRangeUpdate({
          installed: installedVersion,
          current,
          candidate,
          channel,
        })
      : null;
    if (!target) {
      await tryWriteStateFile(io, cacheDir, plugin, {
        lastCheckAtMs: nowMs(),
        lastSuccessAtMs: nowMs(),
        lastStatus: "up-to-date",
        // Clearing the failure is what makes the canonical fix reachable: the
        // merge-write keeps every prior key, so a failure left behind here can
        // never be healed by running a shim, only by editing the file by hand.
        lastFailureAtMs: undefined,
        lastError: undefined,
      });
      return { status: "up-to-date", version: current };
    }

    // Materialise the pinned target bundle from npm before touching anything the
    // launcher will serve. ensureBundle never caches a partial payload.
    await ensureBundle(io, { plugin, version: target, repo, cacheDir, channel });

    // Atomic pointer swap: write temp, then rename over the live pointer.
    await swapPointer(io, cacheDir, plugin, target);
    await tryWriteStateFile(io, cacheDir, plugin, {
      lastCheckAtMs: nowMs(),
      lastSuccessAtMs: nowMs(),
      lastStatus: "updated",
      lastFailureAtMs: undefined,
      lastError: undefined,
    });
    return { status: "updated", version: target };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await tryWriteStateFile(io, cacheDir, plugin, {
      lastCheckAtMs: nowMs(),
      lastFailureAtMs: nowMs(),
      lastError: error,
      lastStatus: "error",
    });
    return { status: "error", error };
  }
}

export async function backgroundSelfUpdateWithRetry(
  io: SelfUpdateIO,
  input: SelfUpdateInput,
  options: SelfUpdateRetryOptions = {},
): Promise<SelfUpdateResult> {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 4));
  const initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs ?? 30_000));
  const maxDelayMs = Math.max(initialDelayMs, Math.floor(options.maxDelayMs ?? 15 * 60_000));
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let attempt = 1;
  let delayMs = initialDelayMs;
  for (;;) {
    const result = await backgroundSelfUpdate(io, input, options);
    if (result.status !== "error" || attempt >= maxAttempts) {
      return { ...result, attempts: attempt };
    }
    await options.onRetry?.({
      attempt,
      nextAttempt: attempt + 1,
      delayMs,
      error: result.error,
    });
    await sleep(delayMs);
    delayMs = Math.min(maxDelayMs, Math.max(delayMs * 2, initialDelayMs));
    attempt += 1;
  }
}

async function swapPointer(
  io: Pick<SelfUpdateIO, "writeFile" | "rename">,
  cacheDir: string,
  plugin: string,
  version: string,
): Promise<void> {
  const ptr = pointerPath(cacheDir, plugin);
  const tmp = `${ptr}.${version}.tmp`;
  await io.writeFile(tmp, pointerContent(version));
  await io.rename(tmp, ptr);
}

async function newestCachedLaneVersion(
  io: Pick<SelfUpdateIO, "readdir">,
  input: { plugin: string; installedVersion: string; cacheDir: string },
): Promise<string | undefined> {
  let best: string | undefined;
  let entries: readonly string[];
  try {
    entries = await io.readdir(input.cacheDir);
  } catch {
    return undefined;
  }
  const pattern = new RegExp(`^${escapeRegExp(input.plugin)}-(\\d+\\.\\d+\\.\\d+(?:[-+][A-Za-z0-9.-]+)?)\\.bundle\\.min\\.mjs$`);
  for (const name of entries) {
    const m = pattern.exec(name);
    if (!m) continue;
    const version = m[1]!;
    if (!isInRange(input.installedVersion, version)) continue;
    if (compareSemver(version, input.installedVersion) <= 0) continue;
    if (best === undefined || compareSemver(version, best) > 0) best = version;
  }
  return best;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toJsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) out[key] = toJsonValue(child);
    }
    return out;
  }
  return String(value);
}

function formatAgeMs(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

/** Minimal POSIX-style join (cache paths only), matching bundle-fetch.ts. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
