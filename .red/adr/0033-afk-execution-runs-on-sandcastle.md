# AFK agent execution runs on `@ai-hero/sandcastle`

## Context

ADR 0032 made AFK ship as a committed, dependency-free TypeScript bundle, and the
shell→TS port (PR #282) reimplemented the whole skill — including the **execution
substrate**: spawning the inner agent (`runner-spawn`), creating the git worktree,
streaming/sentinel detection, and landing the branch (`merge`, `remote-branch`).

Midway through that port we recognised that [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle)
— from the same upstream lineage as our skills (Matt Pocock) — is a productized,
maintained library that does **exactly** the generic agent-execution mechanics we
were hand-rolling: it runs a coding agent (Claude Code, Codex, Cursor, OpenCode,
Copilot, Pi) in a configurable sandbox, manages the git worktree, applies a branch
strategy, captures/resumes sessions, extracts structured output, and exposes
lifecycle hooks. Its README literally pitches it for "parallelizing AFK agents."

Our hand-rolled substrate also had a real weakness: a worktree under `.red/tmp/`
is **not** isolation — the inner agent runs with full host access, constrained only
by a prompt (`SAFETY.md`). Sandcastle's `docker()`/`podman()` providers give genuine
container isolation.

## Decision

**AFK's agent execution runs on `@ai-hero/sandcastle`. The GitHub-issue orchestration
layer stays ours.**

The seam is clean — sandcastle owns the *execution substrate*, AFK owns the *issue
policy*:

| Concern | Owner |
|---|---|
| Spawn agent, stream, completion-signal detection | **sandcastle** (`run()`) |
| Git worktree creation + lifecycle | **sandcastle** |
| Sandbox isolation (none / docker / podman / vercel) | **sandcastle** providers |
| Branch strategy + commit landing on a worktree branch | **sandcastle** `branchStrategy` |
| Session capture / resume, structured output | **sandcastle** |
| Issue state machine (`ready-for-agent→running→closed`, claim locks, labels) | **AFK** |
| Triage / PRD / `to-issues` integration | **AFK** |
| Terminal-event envelope + forensics, attempt ledger, restart-informed retries | **AFK** |
| Unblock sweep, boot reclaim, branch-cleanup reapers | **AFK** |
| Admin-merged-PR landing (ADR 0030), base resolution (ADR 0031) | **AFK** |
| Monitor / statusline / mirror, memory bridge, validation sidecar | **AFK** |

Concretely, the per-issue loop calls sandcastle's `run({ agent, sandbox, promptFile:
handoff, branchStrategy: { type: "branch", branch: afk/… }, completionSignal:
["<promise>DONE</promise>", "<promise>BLOCKED</promise>"] })` for the
"run the agent and produce commits on a branch" step. AFK then takes
`RunResult.{branch, commits, completionSignal}` and runs its **own** feedback gate,
**own** lock-toggled landing (force-push + admin-merged PR, or locked-branch merge),
envelope emission, close, and sweeps. So `merge.ts`'s `landPr`/`landMerge`,
`remote-branch.ts`'s pushes, `feedback.ts`, `envelope-emit.ts`, and the whole boot/
monitor/mirror layer **remain**; only the worktree-creation + agent-spawn +
stream/sentinel mechanics (`runner-spawn` and the worktree half of the loop) are
delegated.

### Sandbox is pluggable; node-only stays the default

Sandcastle ships `noSandbox()` and custom bind-mount providers alongside
`docker()`/`podman()`. AFK **defaults to `noSandbox()`**, which runs the agent in a
worktree with no container — preserving ADR 0032's "runs anywhere `node` runs"
property: no Docker required for the default path. `docker()`/`podman()` are an
**opt-in** (config `afk.sandbox: docker`) for teams that want true isolation. This
is the reconciliation with ADR 0032: the *shipping* model (committed esbuild bundle)
stands; only the hand-rolled *execution mechanics* are superseded, and the new
dependency does not force a container runtime on anyone who doesn't ask for one.

## Consequences

- **One runtime dependency** (`@ai-hero/sandcastle`, ESM, deps ≈ `@clack/prompts`;
  `vercel`/`daytona` are optional peers we don't import). It is esbuild-bundleable, so
  the committed `bin/afk.mjs` still ships as one file — larger, but still a single
  self-contained artifact. ADR 0032's committed-bundle model is unchanged.
- **Real isolation available.** `docker()`/`podman()` close the "worktree is not a
  sandbox" gap; `SAFETY.md` stops being the only guardrail for teams that opt in.
- **More agents for free.** Cursor, OpenCode, Copilot, Pi join claude/codex in the
  runner cascade.
- **Less code to own.** `runner-spawn` and the worktree/stream mechanics are retired
  in favour of sandcastle. The injected-IO ports the port already defined (`runAgent`,
  the spawn/worktree seam) are exactly where sandcastle plugs in — so the port work is
  not wasted; it cut the seam.
- **Coupling + maturity risk.** We depend on sandcastle's API (`run`/`RunResult`/
  `branchStrategy`) and its release cadence (v0.6.x, young). Mitigation: the adapter
  (`execution.ts`) is the single coupling point — everything else talks to AFK's own
  `runAgent` port, so a sandcastle API change touches one module.
- **Base resolution stays ours.** sandcastle branches off the host's active branch;
  AFK's base-resolver (lock > pin > main, ADR 0031) drives which branch the host is on
  before `run()`, fed through the adapter.

## Status

Accepted (supersedes the *execution-substrate* parts of the port; ADR 0032's shipping
model stands). **Refined by ADR 0061:** the substrate is now reddb.io's own fork,
vendored as the `packages/red-castle` git submodule and consumed as TypeScript
source under the package name `@reddb-io/red-castle` (the `@ai-hero/sandcastle` npm
dependency is removed). The single-seam architecture (`execution.ts`) is unchanged.

## Related

- ADR 0032 — committed dependency-free bundle (shipping model retained; the
  "dependency-free" claim is relaxed to "single bundled artifact" — one runtime dep,
  inlined).
- ADR 0030 — admin-merged-PR landing (kept; fed by `RunResult.branch`).
- ADR 0031 — branch-lock drives base + merge (kept; drives the host branch sandcastle
  forks from).
- ADR 0003 — per-runner adapters (sandcastle's agent providers are the new adapter
  surface).
