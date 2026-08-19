# `.fork()` isolates the session only, not the branch or sandbox

`RunResult.fork()` is `RunResult.resume()` plus the agent's native fork flag (`claude --fork-session`, `codex exec fork`): the parent **agent session** is left byte-for-byte unchanged and the child run gets a new session ID. It does **not** isolate the **source branch** or **sandbox** — concurrent `Promise.all([r.fork(a), r.fork(b)])` fan-out is only git-safe when the caller gives each fork a distinct `branch` (via `branchStrategy`). On the **head** and **merge-to-head** strategies, concurrent forks share a working directory / race to merge into the host's HEAD, so they are unsafe.

## Context

The motivating use case in #523/#563 is fan-out: prime one expensive context, then dispatch N independent follow-ups concurrently. The instinct is that `--fork-session` enables this. It only half does. `--fork-session` makes the _session JSONLs_ independent, which is exactly what's needed to stop concurrent turns from corrupting the shared parent record. But the git layer is untouched: `generateTempBranchName` is second-granularity with no randomness (so forks fired in one tick collide on branch names), and `merge-to-head` runs `git merge` into the host's current branch (so concurrent forks race the git index).

`.fork()` already does a full fresh `run()` per call — same as `.resume()` — so each fork is on its own worktree/sandbox _when the branch strategy allocates one per call_. The remaining gap is purely the shared-branch and shared-HEAD cases, which session-forking cannot solve.

## Decision

Scope `.fork()` to session-level isolation. Ship `--fork-session` / `codex exec fork` and the immutable-parent guarantee. Document that safe concurrent fan-out is the caller's responsibility: supply a distinct `branch` per fork; do not fan out concurrently on `head` or `merge-to-head`. Full workspace-level fan-out isolation (auto-allocated unique branches, serialized or skipped merges) is deferred to its own feature — it is "safe concurrent fan-out," a larger thing than "add `--fork-session`."

`.fork()` is gated exactly like `.resume()`: an optional method that throws at runtime when the **agent provider** lacks `sessionStorage` or no session was captured. No `supportsFork` capability flag and no conditional `never` typing are added — that would make `.fork()` more strictly typed than its `.resume()` sibling, which is not, and the asymmetry would surprise. Any provider with `sessionStorage` can fork (it is one extra CLI flag), so the wiring lands for both file-backed resumable providers (Claude, Codex) at once.

## Consequences

- The fan-out example in the docs must show a per-fork `branch`, not bare `r.fork()` on the default strategy, or it advertises a data race.
- A future provider that resumes but cannot fork would need a narrower per-provider signal added at that point — not anticipated now.
- The latent second-granularity collision in `generateTempBranchName` is worth a random-suffix hardening regardless, since it already affects concurrent plain `run()` calls.
- Revisiting this to deliver auto branch isolation is purely additive (a new option or a new strategy), not a breaking change to fork's session semantics.
