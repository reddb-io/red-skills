# 0151 — The daemon owns the version that runs on a machine

- **Status**: accepted
- **Date**: 2026-08-18
- **Related**: ADR 0040 (single version source), ADR 0091 (npm transport), ADR 0145 §3–4 (wire major, quiescent major handover), ADR 0146 (installed tree answers first), ADR 0150 (always-on daemon)
- **Sources**: the `/start` grilling session of 2026-08-18

## Context

Three caches decided the version independently: the host plugin cache
(`~/.claude/plugins/cache/red-skills/dev/<v>`, 21 versions present), the npx
cache (`@reddb-io/red-skills@3.18.12`), and the daemon's own bundle store
(`~/.red/redskilled/bundles/`, nine bundles). A session ran skills from 3.17.1
while its MCP launched 3.18.12 against a daemon left over from an earlier bundle;
`main` was 3.19.3. ADR 0145 gives the compatibility rule (wire major, quiescent
handover) but not who downloads and who decides.

## Decision

**`redskilled` is the single owner of the version that runs.** It fetches and
pins the bundle for its wire major, performs the quiescent handover on a major
change, and tells clients which version it serves. The host plugin cache carries
skills and a thin launcher that asks the daemon; Plugin MCPs are thin enough to be
version-tolerant inside a wire major (ADR 0145 §3). No client-side cache decides
a version, and no client refuses a compatible daemon over a minor difference.

## Considered options

- The host plugin cache pins the version and the daemon follows the newest
  client. Rejected: that is today, and it is how three versions share a machine.
