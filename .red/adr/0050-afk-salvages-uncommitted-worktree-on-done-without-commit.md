# ADR 0050 — AFK salvages an uncommitted worktree when the inner agent emits DONE without committing

## Status

accepted. Complements ADR 0047 (salvage a no-sentinel branch that already passes feedback) and ADR 0028 (`<promise>` is the canonical attempt-exit). Where 0047 rescues a branch that **carries commits** but lacks a sentinel, this ADR rescues the inverse and its partial variant: a **sentinel-bearing** (or no-sentinel) attempt whose worktree still has dirty paths after the agent exits.

## Context

AGENT-PROMPT (Workflow step 5) requires the inner agent to commit its work — one commit per file — before emitting a completion sentinel. The Claude runner complies. The **codex runner does not reliably comply**: observed live on red-skills #301 (codex / gpt-5.5), the agent edited five files, ran the focused tests and typecheck green, even caught a domain governance edge case — then emitted `<promise>DONE</promise>` while leaving **every change uncommitted** in the worktree.

The downstream consequences, all confirmed:

- sandcastle's commit collection (`RunAgentResult.commits`) returned **zero** — it only collects committed work.
- The worker branch sat at base (0 commits ahead). The continuous-push hook had already pushed an *empty* branch up-front.
- The DONE path ran the feedback gate against an **empty changed-file set** (no scopes → a vacuous pass) and landed an empty merge. The issue was never really resolved and the ~196-line diff was stranded in the soon-to-be-GC'd `.sandcastle/worktrees/...` worktree.

ADR 0047's no-sentinel salvage does **not** catch this: it keys off `changedFiles(branch, base) > 0`, but an uncommitted branch carries no commits, so `changedFiles` is empty and the salvage is skipped.

The preventive half stays in AGENT-PROMPT (the agent must commit and run `git status --short` before DONE). This ADR is the **runtime safety net** for runner non-compliance, including the partial-commit case where the branch carries commits but additional edits remain dirty.

## Decision

When `runAgent` returns a `done` or `no-sentinel` outcome, `processIssue` calls a best-effort `salvageUncommitted(branch)` port before the existing outcome branching:

1. Resolve the worktree currently checked out on the worker branch via `git worktree list --porcelain` (`worktreePathForBranch`).
2. If that worktree is dirty, commit **each changed path on its own commit** — the same one-commit-per-file discipline AGENT-PROMPT mandates — then `push --force-with-lease`.
3. Fall through to the **same feedback gate + landing + close tail** the DONE path (and 0047 salvage) already use. The gate is load-bearing: it is the only thing distinguishing a real, complete edit from a half-baked one.

A clean worktree salvages nothing (count 0) → behaviour is unchanged (no-sentinel with no work stays terminal; a DONE with genuinely no leftovers lands as before). The port is optional, so callers/tests that do not wire it keep today's behaviour exactly.

If the salvage commits files but the feedback or backpressure gate fails, the
attempt still parks as `blocked:validation`: salvage is only a recovery from the
runner's missing commit, not a validation bypass. The terminal envelope notes
both facts explicitly ("zero commits" or "left dirty worktree paths after N
commit(s)" + "salvaged N uncommitted file(s)" + "validation failed") so
operators can distinguish a real gate failure from an empty-merge or partial-diff
hazard.

## Consequences

- The codex runner becomes safe to ship as a first-class runner to other repos: an agent that forgets to commit no longer strands its work or closes an issue empty. This unblocks codex-as-runner distribution via the released bundle (ADR 0038).
- The merge gate is never bypassed: salvaged work still passes through feedback before it lands. A failing salvage routes to `feedback-failed` (the accurate reason), never a silent empty merge.
- Pairs with AGENT-PROMPT step 5 (the prevention, now including a `git status --short` clean-worktree check before DONE) and ADR 0047 (the committed-but-no-sentinel cure). The three together cover the matrix of {sentinel, no-sentinel} × {committed, uncommitted}.
- The salvage reaches into sandcastle's worktree through the public `git worktree list` surface, not sandcastle internals — `execution.ts` remains the single seam coupled to sandcastle (ADR 0033).

Memory-NoIngest: ADR + runtime fix; the canonical graph claim for the commit-discipline contract stays with AGENT-PROMPT.
