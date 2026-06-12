/**
 * channel.ts — pure resolution of the AFK bundle *release channel* (ADR 0058).
 *
 * The ADR 0038 launcher fetches the dev bundle from a GitHub Release. A
 * *channel* selects WHICH release a given installation tracks:
 *
 *   - `stable` (default) — the version-pinned release `v<installed-version>`.
 *     This is exactly today's behaviour, so an installation with no channel
 *     config keeps working unchanged.
 *   - `canary` (opt-in)  — the floating `canary` release tag, re-pointed at each
 *     pre-release build. Promotion to stable is a tag move (see the ADR); the
 *     proof-by-drain gate is read from the AFK history telemetry.
 *
 * This module is dependency-free and side-effect-free so it can be bundled into
 * the dependency-free entrypoint (`entrypoint-cli.ts` → `afk.mjs` /
 * `red-fetch.mjs`) and unit-tested without IO.
 */

export type ReleaseChannel = "stable" | "canary";

/** The canonical channels, in promotion order (canary → stable). */
export const RELEASE_CHANNELS: readonly ReleaseChannel[] = ["stable", "canary"];

/** Absent channel config resolves here — today's version-pinned behaviour. */
export const DEFAULT_CHANNEL: ReleaseChannel = "stable";

/** Env var that overrides the configured channel for a single process/fleet. */
export const CHANNEL_ENV_VAR = "RED_SKILLS_CHANNEL";

/** The floating release tag the `canary` channel tracks. */
export const CANARY_TAG = "canary";

/**
 * Normalise a raw channel string to a canonical {@link ReleaseChannel}, or
 * `null` when it is empty/missing/unrecognised. Case- and space-insensitive so
 * `" Canary "` and `RED_SKILLS_CHANNEL=CANARY` both resolve. Never throws — an
 * unknown value is a soft miss the caller falls through, not a hard error, so a
 * typo can never strand a fleet with no resolvable bundle.
 */
export function normalizeChannel(raw: string | null | undefined): ReleaseChannel | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (RELEASE_CHANNELS as readonly string[]).includes(v) ? (v as ReleaseChannel) : null;
}

export interface ResolveChannelOptions {
  /** Process env; `RED_SKILLS_CHANNEL` here wins over `configValue`. */
  env?: Record<string, string | undefined>;
  /** The `plugins.dev.afk.release.channel` value read from `.red/config.yaml`. */
  configValue?: string | null;
}

/**
 * Resolve the active channel with precedence `env > config > default`. Each
 * source is normalised independently; an unrecognised value at one level is
 * skipped so the next source still applies (and a fully unknown stack lands on
 * the safe {@link DEFAULT_CHANNEL}).
 */
export function resolveChannel(opts: ResolveChannelOptions = {}): ReleaseChannel {
  const fromEnv = normalizeChannel(opts.env?.[CHANNEL_ENV_VAR]);
  if (fromEnv) return fromEnv;
  const fromConfig = normalizeChannel(opts.configValue);
  if (fromConfig) return fromConfig;
  return DEFAULT_CHANNEL;
}

/**
 * The GitHub Release tag a channel resolves to for a given installed version.
 * `stable` stays version-pinned (`v<version>`) — byte-identical to the pre-ADR
 * 0058 fetch — while `canary` tracks the floating {@link CANARY_TAG}.
 */
export function channelReleaseRef(channel: ReleaseChannel, version: string): string {
  return channel === "canary" ? CANARY_TAG : `v${version}`;
}
