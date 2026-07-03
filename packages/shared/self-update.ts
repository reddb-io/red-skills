/**
 * self-update.ts — background, in-range bundle self-update (ADR 0084).
 *
 * ADR 0038/0058 pin every installation to the bundle for its *installed* plugin
 * version (read from `.claude-plugin/plugin.json`). That is safe but forces an
 * operational dance: to run a just-released fix you hand-download the new bundle
 * into the cache. This module ends that dance. On an enabled session start the
 * launcher spawns a **background** check — is there a newer Release bundle within
 * the compatible version range (same channel, same major)? If yes, it downloads,
 * checksum-verifies, and atomically swaps a *pointer* so the **next** session
 * serves it. The current session is never touched.
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

import {
  type BundleIO,
  ensureBundle,
  fetchManifest,
  resolveBundle,
} from "./bundle-fetch.js";
import type { ReleaseChannel } from "./channel.js";

/**
 * IO surface for self-update: the {@link BundleIO} download/read/write/hash set
 * plus an atomic {@link rename} (write-temp-then-rename) for the pointer swap.
 */
export interface SelfUpdateIO extends BundleIO {
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
 * when the channel is `stable` (canary already self-refreshes via checksum on
 * its floating cache key — ADR 0058), it is in the same major range as the
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

/**
 * The floating GitHub release tag whose manifest names the newest in-range
 * (same-major) bundle for a version, e.g. `1.145.0` → `v1`. Publishing that tag
 * is a release-workflow concern; the launcher only *reads* its manifest.
 */
export function inRangeReleaseRef(version: string): string {
  const p = parseSemver(version);
  return p ? `v${p.major}` : `v${version}`;
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

/** Serialise a pointer payload. */
function pointerContent(version: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ version }));
}

/** Read a version out of a pointer body: `{ "version": "x" }` or a bare `x.y.z`. */
function readPointer(text: string): string {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed) as { version?: unknown };
    if (parsed && typeof parsed.version === "string") return parsed.version.trim();
  } catch {
    /* fall through to a bare-version tolerance */
  }
  return /^\d+\.\d+\.\d+/.test(trimmed) ? trimmed : "";
}

export interface ResolveActiveVersionInput {
  plugin: string;
  installedVersion: string;
  cacheDir: string;
  channel: ReleaseChannel;
}

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
  io: Pick<SelfUpdateIO, "exists" | "readFile">,
  input: ResolveActiveVersionInput,
): Promise<string> {
  const { plugin, installedVersion, cacheDir, channel } = input;
  // Canary keys by the floating tag, not a version; only stable has a pointer.
  if (channel !== "stable" || !installedVersion) return installedVersion;

  const ptr = pointerPath(cacheDir, plugin);
  if (!(await io.exists(ptr))) return installedVersion;

  let pointed: string;
  try {
    pointed = readPointer(new TextDecoder().decode(await io.readFile(ptr)));
  } catch {
    return installedVersion;
  }
  if (!pointed) return installedVersion;
  if (!isInRange(installedVersion, pointed)) return installedVersion;
  if (compareSemver(pointed, installedVersion) < 0) return installedVersion;

  // Only trust the pointer if the bundle it names is actually cached.
  const bundle = resolveBundle({ plugin, version: pointed, cacheDir, channel });
  if (!(await io.exists(bundle))) return installedVersion;
  return pointed;
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
}

export interface SelfUpdateInput {
  plugin: string;
  installedVersion: string;
  repo: string;
  cacheDir: string;
  channel: ReleaseChannel;
}

/**
 * Best-effort, background, in-range self-update. **Never throws** — every
 * failure mode (offline, out-of-range candidate, checksum mismatch, malformed
 * manifest) resolves to a typed {@link SelfUpdateResult} and leaves the cache /
 * pointer untouched, so the already-cached bundle keeps serving and the check is
 * simply retried on a later boot. Do NOT call this from a render/hook path; the
 * launcher runs it as a detached process.
 *
 * Sequence: resolve the currently-served version → read the floating major-line
 * manifest → decide the in-range target → (if any) fetch+verify its pinned
 * bundle → atomically swap the pointer (write temp, rename over the live file).
 * The pointer flips **last** and **atomically**, so a half-written bundle is
 * never pointed at and the swap is all-or-nothing.
 */
export async function backgroundSelfUpdate(
  io: SelfUpdateIO,
  input: SelfUpdateInput,
): Promise<SelfUpdateResult> {
  const { plugin, installedVersion, repo, cacheDir, channel } = input;
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
    const manifest = await fetchManifest(io, repo, plugin, inRangeReleaseRef(installedVersion));
    const target = selectInRangeUpdate({
      installed: installedVersion,
      current,
      candidate: manifest.version,
      channel,
    });
    if (!target) return { status: "up-to-date", version: current };

    // Fetch + checksum-verify the pinned target bundle before touching anything
    // the launcher will serve. ensureBundle never caches an unverified payload.
    await ensureBundle(io, { plugin, version: target, repo, cacheDir, channel });

    // Atomic pointer swap: write temp, then rename over the live pointer.
    const ptr = pointerPath(cacheDir, plugin);
    const tmp = `${ptr}.${target}.tmp`;
    await io.writeFile(tmp, pointerContent(target));
    await io.rename(tmp, ptr);
    return { status: "updated", version: target };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Minimal POSIX-style join (cache paths only), matching bundle-fetch.ts. */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}
