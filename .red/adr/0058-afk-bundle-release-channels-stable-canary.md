# AFK bundle release channels — stable (default) and canary (opt-in)

## Status

accepted

## Context

The ADR 0038 launcher resolves the dev runtime bundle from a GitHub Release: it
reads the installed plugin version from `.claude-plugin/plugin.json`, fetches
`dev.bundle.min.mjs` + `dev.manifest.json` from the `v<version>` release, checksum-
verifies, and caches it (ADR 0034/0039, `packages/shared/bundle-fetch.ts` +
`entrypoint-cli.ts`). Every installation therefore tracks exactly the bundle for
the version it has installed — a single, version-pinned line.

That is safe but slow to validate a runtime change at fleet scale: a fix lands,
a release is cut, and the only way to exercise it across real drains is to ship
it to everyone at once. We want a way to run a candidate bundle on an opt-in
subset of fleets, measure it against the same telemetry the monitor already
collects, and promote it to everyone only once it has earned trust — without
changing anything for installations that never opt in.

This is the standard *release channel* pattern. PRD #614 scopes the first slice:
wire channel resolution + the promotion mechanics and document the initial
promotion bar; threshold tuning stays operational (PRD Out of Scope).

## Decision

1. **Two channels, `stable` and `canary`.** `stable` is the default and is
   **byte-for-byte today's behaviour**: the launcher resolves the version-pinned
   `v<version>` release and the `<plugin>-<version>.bundle.min.mjs` cache key. An
   installation with no channel configuration keeps tracking stable, unchanged.

2. **`canary` tracks one floating tag.** The `canary` channel resolves the
   `canary` release tag (not a version) and a channel-keyed cache file,
   `<plugin>-canary.bundle.min.mjs`. Because the tag floats, the existing
   checksum re-verification in `ensureBundle` is what refreshes a stale cache:
   when the `canary` tag moves, the manifest sha256 changes, the cached bytes no
   longer match, and the launcher re-downloads. No new cache-invalidation code.

3. **Resolution precedence is `env > config > default`.** The launcher reads
   `RED_SKILLS_CHANNEL` first, then `plugins.dev.afk.release.channel` from
   `.red/config.yaml` (ADR 0042; legacy top-level `afk.release.channel` is a
   read fallback), then falls back to `stable`. An unrecognised value at any
   level is a soft miss that falls through to the next source — a typo can never
   strand a fleet with no resolvable bundle. The resolver is pure and lives in
   the dependency-free `packages/shared/channel.ts` so it bundles into the
   launcher and is unit-tested without IO.

4. **The channel is in the launcher's boot output.** On every `run`/`fetch` the
   launcher writes `entrypoint: resolving <plugin> via <channel> channel (<ref>)`
   to stderr. Because every fleet worker boots through `afk.mjs`, a fleet's
   channel is auditable in its own logs.

5. **Promotion is a tag move, gated by proof-by-drain.** Publishing a canary is
   pointing the `canary` tag at the candidate commit and refreshing the `canary`
   release assets. Promotion to stable advances a `stable` channel tag onto the
   commit the canary has proven (`scripts/afk-promote-channel.sh`). **Rollback is
   the same move in reverse** — re-point the tag at the previous good commit.

6. **The promotion gate is read from the AFK history telemetry.** `proof-by-drain`
   (`apps/dev/src/core/proof-by-drain.ts`) reads the `afk-history.jsonl` ledger
   (the same `done`/`blocked`/`exhausted` records the monitor sparkline uses) and
   evaluates the canary's drain against a `PromotionBar`. The **initial bar** is:
   **≥ 20 landed canary merges**, observed over a **≥ 24h window**, with a
   **failure ratio ((blocked + exhausted) / terminal) ≤ 0.10**. These numbers are
   a starting point; tuning them is operational and out of scope for this slice.

## Consequences

- Existing installations are untouched: no channel config → stable → version-
  pinned fetch with the existing cache key and release tag.
- A canary bug never poisons a stable cache: the cache keys are disjoint
  (`<plugin>-<version>` vs `<plugin>-canary`), so flipping a fleet back to stable
  serves the already-cached version-pinned bundle with no refetch.
- The gate is data, not vibe: promotion is justified by the same telemetry the
  monitor already trusts, and the verdict enumerates every unmet dimension.
- The launcher stays dependency-free. Channel resolution adds a small flat-config
  reader inlined in `entrypoint-cli.ts` (no YAML dependency), consistent with how
  the dev runtime already parses `.red/config.yaml` (ADR 0042).
- Open follow-ups (out of this slice): wiring the proof-by-drain verdict into the
  release workflow so a canary is cut automatically, and letting the `stable`
  channel optionally track the floating `stable` tag instead of `v<version>`.

## Related

- ADR 0034 / 0038 / 0039 — dynamic dist fetch, fetched-not-committed bundle, the
  single dependency-free entrypoint.
- ADR 0042 — plugin config unified under `.red/config.yaml`
  (`plugins.dev.afk.*`).
- ADR 0065 — AFK worker-vitals telemetry vocabulary (the history ledger).
- PRD #614 — the parent program; this is issue #629.
