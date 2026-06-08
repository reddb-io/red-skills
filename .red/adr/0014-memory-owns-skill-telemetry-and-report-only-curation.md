# Memory owns skill telemetry and report-only curation

## Status

accepted.

Skill usage needs durable local evidence, but the `dev` plugin must not learn
about RedDB persistence. **Skill telemetry** is therefore a Graph-mode Memory
capability: runner-specific Claude Code and Codex adapters emit a high-level
Memory event contract, and the Memory plugin persists detailed relationships in
Graph mode plus aggregate rollups through RedDB Statistics.

## Decision

The Memory plugin owns **Skill telemetry** and the report-only **Skill curator**.
`dev` and skill runtimes may emit high-level skill events, but they do not know
whether those events become graph rows, statistics rollups, or no-ops. Skill
telemetry is available only in Graph mode and is enabled explicitly by
`memory init`; when unavailable, normal skill use silently no-ops while
telemetry/curator status commands explain the missing prerequisite.

The Skill curator may run explicitly or in the background, but inside Memory it
only computes evidence and recommendations. Any mutation of **Curatable skills**
— patching, consolidating, archiving, or restoring files — remains a separate
workflow outside the Memory plugin.

## Why

- **Plugin boundaries stay clean.** Memory is the only plugin that knows RedDB;
  `dev` remains a soft-using workflow plugin.
- **Telemetry is broader than mutation.** Usage can be observed for all skills,
  but curator actions must be limited to user-owned or agent-created skills.
- **Hermes provides the shape, not the boundary.** Hermes combines background
  review, usage counters, and curator mutation in one runtime; RedSkills keeps
  lightweight telemetry updates separate from heavier report-only review.

## Consequences

- Claude Code and Codex need runner-specific adapters that understand their own
  hook/loading mechanics while producing the same logical Memory event contract.
- The stored event set stays small (`viewed`, `used`, `result`, `changed`,
  `state_changed`); curator-friendly counters such as use count, view count,
  patch count, last activity, success/failure, archive, and consolidation are
  derived rollups.
- Background operation has two levels: lightweight checks can follow user-turn
  counts and process only new skill events, while report-only curator reviews
  follow interval/idle gates.

## Status

Accepted; post-0041 supersession applies **on migration**. The surviving
decision is ownership: Memory owns Skill telemetry persistence, rollups, and
report-only curation evidence, while mutation remains outside Memory. What is
obsoleted on migration is the repo-local placement of that runtime inside
red-skills. Once ADR 0041 lands, the telemetry and report-only curation runtime
live in `red-memory` and are consumed from red-skills through the `red-memory`
MCP, not through an in-repo `memory ...` CLI. This record only narrows the
historical co-location claim; it does not perform the migration.

## Related

- ADR 0041 — red-skills consumes the `red-memory` and `red-ui` MCPs instead of
  building the memory plugin in this repo.
