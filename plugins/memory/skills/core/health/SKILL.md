---
name: health
description: Report Memory plugin operational health. Use before memory self-improvement, CI checks, or large agent runs to verify initialization, graph mode, freshness, Skill telemetry, ranked proposal candidates, and pending proposal files without mutating anything.
---

# memory health

Read-only operational healthcheck for the Memory plugin.

<what-to-do>

**Run the healthcheck in JSON mode, interpret every counter against the state table, and report `recommendedNextActions` — never mutate any file from this diagnostic.**

## 1. Run the healthcheck

```bash
memory health --json
```

Use `--root <dir>` when checking a repository other than the current working directory.

## 2. Interpret the state

- `missing` — Memory is not initialized. Recommend graph mode with Skill telemetry when self-improvement is desired.
- `degraded` — Memory exists but graph mode, Skill telemetry, or graph freshness is not ready.
- `attention` — Memory is operational and has pending/high-priority improvement work.
- `ready` — Memory is operational and no immediate action is needed.

## 3. Use the operational counters

Read these JSON fields before deciding the next action:

- `initialized` — whether memory is configured (a `plugins.memory` block in `.red/config.yaml`, or the legacy `.red/memory/config.json`).
- `graphMode` — whether graph mode is configured and the graph store exists.
- `skillTelemetry` — `enabled` or `unavailable`.
- `graphFreshness` — freshness of the graph store versus project files.
- `rollups` — number of observed Skill telemetry rollups.
- `proposalCandidates` — number of ranked improvement candidates.
- `highPriorityProposals` — candidates that should be reviewed first.
- `pendingProposalFiles` — pending `.md` files directly under `.red/memory/proposals/`; archived files are excluded.
- `topProposals` — top ranked proposals, already sorted by deterministic score.
- `recommendedNextActions` — concrete next steps for the agent or CI.

## DOs / DON'Ts

- ✅ Run this before `memory improve skills --write-proposal` in automated workflows.
- ✅ Treat `attention` as actionable, not as failure.
- ✅ Use `recommendedNextActions` rather than inventing recovery steps.
- ✅ When `pendingProposalFiles > 0`, inspect them with `memory improve proposals list/show --json`; proposal fingerprints let repeated generation refresh existing work instead of creating duplicates.
- ❌ Do not mutate graph, proposal, or Skill files from this healthcheck.
- ❌ Do not parse human text when `--json` is available.

</what-to-do>
