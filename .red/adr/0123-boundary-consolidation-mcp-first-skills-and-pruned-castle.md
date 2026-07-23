# 0123 — Boundary consolidation: every castle-verb skill is an MCP-first client, and red-castle carries only RedSkills' shape

- **Status**: accepted
- **Date**: 2026-07-23
- **Related**: ADR 0120 (red-castle is the AFK MCP), ADR 0113 (castle owns the truth, dev owns the host boundary), ADR 0101 (vendored source), ADR 0114 (CLI args: one contract, two implementations), wayfinder #2230

## Context

ADR 0120 made red-castle's `castle` MCP the canonical complete interface and
rewrote `/afk` and `/go` as its clients, enforced by a doc-contract test. Three
gaps remained around that seam:

1. **Uncovered clients.** The queue-repair and reporting skills (`/hitl`,
   `/triage`, `/retake`, `/dashboard`, `/daily-review`) still hand-rolled
   engine flows — raw `gh` label flips, blocker-section edits, CLI-primary
   invocations — because the doc-contract test bound only afk/go/fleet/monitor.
2. **Adapter round-trips.** Several MCP tool operations in `apps/dev` violated
   ADR 0120 rule 2 by invoking the CLI command handler in-process, capturing
   its printed stream, and re-parsing the text back into a value.
3. **Unconsumed upstream surface.** The vendored red-castle package shipped
   sandbox providers (vercel, daytona) and agent providers (cursor, copilot,
   devin) with zero consumers anywhere in RedSkills — paid for on every
   upstream sync, test run, and audit, while diluting what the package is for.

Separately, two live claim engines wrote the same `<!-- afk:claim -->` wire
format with the same marker version (dev's proven `core/claim.ts` vs castle's
unconsumed tracker twin) — the active ghost-claim incident class.

## Decision

Four rules complete the ADR 0113/0120 boundary:

1. **Every castle-verb skill is an MCP-first client.** A skill whose verb the
   castle exposes as a tool names that tool as its primary surface and keeps
   the CLI only as the documented unreachable-MCP fallback. The doc-contract
   test (`castle-mcp-client-docs.test.ts`) binds each such skill to its tools;
   a castle-verb skill outside that test is a contract gap, not a style choice.
   `gh` remains legitimate for *reading*; state transitions go through tools.

2. **MCP tool operations return values, never re-parsed render output.** The
   capture-and-reparse pattern (spawn command handler → capture stdout →
   decode) is banned in the MCP adapter; every operation calls a
   value-returning core shared with the CLI handler, and a guard test pins the
   adapter source against reintroduction.

3. **red-castle ships only the providers RedSkills runs.** Sandboxes: docker,
   podman, no-sandbox. Agent providers: claudeCode, codex, opencode (the only
   factories `RUNNER_SPECS` selects) plus pi (kept whole — factory and
   implementer-environment projection). This is a permanent divergence from
   upstream sandcastle, recorded in the package CLAUDE.md with a
   cherry-picks-must-be-adapted clause; the public `SandboxProvider` /
   `AgentProvider` seams remain for out-of-tree integrations.

4. **The claim wire format has one owner.** The proven dev implementation was
   absorbed into `packages/red-castle/src/engine/tracker/claim.ts` (per the
   #2230 doctrine: absorb the proven implementation, delete the unconsumed
   twin); `apps/dev`'s `core/claim.ts` and `core/claim-staleness.ts` are
   re-export shims. A pinned wire fixture (`claim-wire-fixture.ts`) is asserted
   on both sides of the seam, so any parser or renderer change is a conscious
   wire-format decision.

## Consequences

- Adding a castle capability now means: tool in red-castle's `mcp/` registry,
  value-returning core behind it, MCP.md row, and — if a skill owns the verb —
  a doc-contract binding. The CLI remains a fallback transport, never a second
  implementation.
- Upstream syncs re-drop the pruned providers rather than re-adopting them;
  re-adding one is a deliberate decision that revisits `.out-of-scope/`.
- The local-lease twin (`tryAcquireClaimDir` in dev vs castle's
  `createFsIssueLeaseStore`, two on-disk formats over `.red/tmp/claims/`) is
  explicitly out of scope here; the tracker-port `claimIssueLease` must not be
  promoted into a production path until that twin is reconciled (tracked as
  #2578 on map #2230).
- The dead tested-but-unwired modules deleted alongside this decision
  (`self-repair`, `proof-by-drain`, `hitl-resolution-plan`, `suggest-hooks`,
  `worktree-manager`, `validation-routing`, the retired `attempt-reader` /
  `attempt-sidecars`, the `opencode-host` mirror sink, `src/prototypes/`, and
  the dead exports `runSharedGate` and `runSession`/`selectIssues`) are
  recoverable from git history; a wanted-again module returns via a ticket,
  not by keeping green-forever test files alive. Two classes survived the
  sweep deliberately: repo-invariant guard tests whose module's only importer
  IS the guard (`adr-governance`, `toon-json-guard`), and the doctor
  classifiers the `/red-doctor` and `/review-adrs` skill flows consume as
  their documented check surface — skill prose is a production consumer the
  import graph cannot see.
