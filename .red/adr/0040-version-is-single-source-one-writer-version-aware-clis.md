# Version is a single source, written by one script; CLIs and MCP launchers are version-aware

## Context

The plugin version is duplicated across many files: `plugins/<plugin>/.claude-plugin/plugin.json`, `plugins/<plugin>/.codex-plugin/plugin.json`, the version-keyed bundle assets (`dev-<version>.bundle.min.mjs`, ADR 0038), and their manifests. `red-release` already has a "Sync plugin manifest versions" step that writes the manifests together, and `scripts/validate-install-metadata.sh` is a CI **gate** that rejects a release when a plugin's Claude and Codex manifest versions disagree.

The gate works — but there is **no single committed writer**, so any flow *outside* the release can drift one file. This bit us on 2026-06-02: landing `/dev:doctor` and `/dev:review-adrs` via worktrees copied a stale local `plugins/dev/.claude-plugin/plugin.json` (version `1.147.6`) over `main`'s `1.148.2` while `.codex-plugin` stayed `1.148.2`; `validate-install-metadata.sh` then failed `red-release` on three consecutive pushes, so the skills did not publish until the version was resynced (#384 → v1.149.0). The gate caught it loudly (good) but the drift was avoidable.

Separately, the runtime bundles must be **version-aware**: the ADR 0038 launcher already resolves `dev-<version>.bundle.min.mjs` by the plugin version, and the memory plugin will fetch `red-memory` + `red-ui` by version too (ADR 0041). Version is therefore the coordination key across manifests, bundles, and the fetch — it must come from one place.

## Decision

1. **One source of truth for the version, one writer.** A single committed script (`scripts/set-version.sh <version>`, deriving from the release-computed next version / git tag) is the **only** thing that writes a version. It propagates the value to **every** version-bearing file for a plugin — both `.claude-plugin` and `.codex-plugin` manifests (and any future manifest) — atomically. The `red-release` "sync" step **calls this script** instead of inlining the write; any manual flow uses the same script. Hand-editing a manifest version is disallowed.

2. **`validate-install-metadata.sh` stays the gate.** Belt-and-suspenders: the single writer prevents drift; the validator still fails the release if drift ever appears (the two are independent defenses).

3. **CLIs and MCP launchers are version-aware from that same source.** Each shipped CLI/bundle (`afk`, `code-nav`, the dev runtime, `red-memory`, `red-ui`) derives its version from `build-info` (already embedded at build) and reports it (`--version`). The version-keyed fetch launchers (ADR 0038/0039) resolve their bundle by that same version, so manifests, bundle filenames, and the running CLI all agree on one id.

4. **`/dev:doctor` gains a version-coherence check** (cross-manifest equality per plugin) so the drift class is surfaced read-only, before a release ever fails on it.

## Consequences

- The "edit one manifest, forget the other" footgun is removed; manual landings can no longer desync versions.
- Manifests, bundle assets, and CLI `--version` all coordinate on one id — the prerequisite for the ADR 0038/0039 version-keyed fetch to be reliable.
- A small migration: extract the release's inline version write into `scripts/set-version.sh`, repoint `red-release` at it, add `--version` where a CLI lacks it, and wire the doctor check.

## Status

Accepted (direction); implementation pending. The validator gate and the version-keyed launchers already exist; the single-writer script and the `--version`/doctor-check wiring are the new work.

## Related

- ADR 0038 — version-keyed fetch launcher (the runtime's version-awareness).
- ADR 0041 — memory plugin fetches `red-memory` + `red-ui` by version.
- ADR 0029 — release-asset bundle fetch.
- `scripts/validate-install-metadata.sh` — the CI gate this decision keeps.
