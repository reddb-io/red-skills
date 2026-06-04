# RedSkills teaches and enforces an interactive development loop

## Status

accepted.

Design-stage decision from a `/start` grilling. The implementation is sliced in
a follow-up PRD.

`/setup-red-skills` (Sections A–G) wires a consumer repo's *catalogue and
config* — tracker, triage labels, domain docs, statusline, `.red/config.yaml` —
but it never teaches or enforces *how we develop*. The interactive
worktree→PR→merge discipline lives only as tribal knowledge (and as memory
feedback: "never switch the primary off main; do branch work in a worktree").
`/afk` already encodes this for the autonomous loop (ADR 0030/0031), but the
**live, human-in-the-loop** session has no equivalent skill, no enforcement, and
nothing injected to onboard a new repo or agent.

## Decision

Make RedSkills teach **and** enforce one interactive development loop, delivered
through three pieces tied together by a new `/setup-red-skills` **Section H**:

1. **Enforce (reuse + extend, no parallel hook).** The branch-switch guard is an
   extension of the existing `git-guardrails-claude-code` / `branch-lock` hook
   logic, not a new hook. It blocks the **agent** from switching the primary
   checkout's branch (`git switch` / `checkout <branch>` / `switch -b`)
   **unconditionally in the primary** — no named lock file required — gated only
   by a config kill-switch `dev.lock-primary-branch` in `.red/config.yaml`
   (default off; Section H turns it on). `git commit` is **not** blocked — the
   emphasis is squarely on *not changing branches*; the agent works by creating
   a worktree, and only the human changes the primary's branch. `git worktree
   add`, read-only git, and the existing `.red/tmp/work-*/` worktree exemption
   all stay. The hook ships **dormant at the plugin level**
   (`plugins/dev/hooks/claude.hooks.json`, today only `SessionStart`) and reads
   `.red/config.yaml` at runtime, so it is inert until a repo opts in.

2. **Teach.** Section H injects an inline `## Development workflow` block into
   both `AGENTS.md` and `CLAUDE.md` (the same injection pattern as the existing
   `## Agent skills` block), documenting the loop and the "agent never switches
   the primary's branch; only the user does" rule. `/dev:doctor` extends to
   parity-check this block, exactly as it already checks `## Agent skills`.

3. **Orchestrate — `/ship`.** A new public `dev` skill, the **interactive
   finalizer**. Given committed work in a worktree, it opens/reuses a PR,
   monitors CI + reviews (a `/loop` over `gh pr checks` + `gh pr view --json
   reviews,statusCheckRollup`, with a time cap), then decides: if branch
   protection is satisfied **and** no reviewer — human *or* bot — left
   `CHANGES_REQUESTED`, it `gh pr review --approve` + merges; otherwise it
   comments on the linked issue, labels it `ready-for-human` (mirrored on the
   PR), and stops for `/dev:hitl`. `/ship` is a **tail/finalizer**: worktree
   creation is a separate front step (the guard nudges toward it), not part of
   `/ship`. Its worktrees live under the already-exempt `.red/tmp/work-ship-*/`
   glob.

## Why

- **`/ship` is the review-respecting sibling of `/afk`'s landing.** ADR 0030's
  unlocked path *admin-merges* the per-issue PR ("a single `gh` identity cannot
  approve its own PR, so the approval collapses into the merge") — correct for
  an autonomous queue that must not stall on human review. The interactive
  session wants the opposite: *respect* the review gate. So the single behavioural
  difference between `/ship` and `/afk` step 8 is admin-bypass vs review-gated
  merge. Keeping them separate avoids refactoring AFK's battle-tested,
  lock-toggled landing for DRY's sake; they can be unified later if it pays off.
- **Enforcement on switching, not committing, matches the actual footgun.** The
  rule the user expressed is "the agent never changes the primary's branch; the
  human does." Blocking `git commit` would fight `/afk`'s and the auto-sync's
  legitimate commits to local `main` and buys nothing the worktree discipline
  doesn't already give; blocking the *switch* is what forces work into a
  worktree.
- **Plugin-dormant + setup-activated is one place to fix, zero surprise.** The
  hook logic lives once in the plugin; a repo that has not adopted RedSkills
  never feels it; `/setup-red-skills` is the single explicit on-ramp.
- **Teaching belongs where every agent already looks.** `AGENTS.md` / `CLAUDE.md`
  are read first; an inline block reuses an injection + parity-check the doctor
  already understands, with no new file to drift.

## Considered alternatives

- **A new standalone guardrail hook.** Rejected — `git-guardrails` + `branch-lock`
  already block the branch-leaving/work-loss family agent-only with the AFK
  exemption (ADR 0006); a parallel hook would only race or duplicate. Extend
  them instead.
- **Block `git commit` in the primary too.** Rejected — see Why; it endangers
  AFK/auto-sync commits to local `main` and over-reaches.
- **Gate the block on a named lock file (status quo of ADR 0006).** Rejected for
  this loop — the rule is absolute ("agent doesn't switch the primary's branch"),
  not "lock to *this* branch"; a versioned config kill-switch is the right
  escape valve, not the presence/absence of a `.red/tmp` file.
- **A shared landing primitive for `/ship` and `/afk`.** Deferred — the merge
  semantics genuinely differ (admin-bypass vs review-gated) and AFK's landing is
  delicate; unify later if warranted.
- **`/setup-red-skills` writes the hook into the consumer's `.claude/settings.json`
  per repo.** Rejected — duplicates logic into every consumer and forces the
  doctor to chase drift; plugin-dormant + flag is cleaner.
- **A separate `.red/DEVELOPMENT.md` for the rules.** Rejected for now — the
  inline `AGENTS.md`/`CLAUDE.md` block matches the existing pattern and avoids a
  new file; revisit if the prose outgrows a block.

## Consequences

- **Refines ADR 0006**, does not supersede it: enforcement stays *agent-only*
  (the human terminal is never intercepted) and the `.red/tmp/work-*/` exemption
  holds; what changes is the **activation model** — from "a lock file is present"
  to "the `dev.lock-primary-branch` flag is on," with the block applying to the
  primary regardless of a named branch. The `branch-lock` lock file remains a
  valid, additional way to pin to a *specific* branch and to drive `/afk` base
  per ADR 0031.
- **Relates to ADR 0030/0031**: `/ship` is the interactive analogue of the
  unlocked AFK landing, swapping admin-merge for a review-gated decision. `/afk`
  is unchanged and does not call `/ship`.
- **Depends on `.red/config.yaml`** (ADR 0042) for the `dev.*` keys
  (`dev.lock-primary-branch`, and any `dev.ship.*` knobs the PRD adds).
- New `dev` skill `/ship` must be registered (root `README.md`, the engineering
  bucket `README.md`, `plugins/dev/.claude-plugin/plugin.json`); it is original
  to reddb.io, so no `CHANGES.md` entry.
- `/dev:doctor` gains a check (Development-workflow block parity + whether the
  guard flag is set), extending the adoption surface.
- Glossary debt for the implementing PRD: a **Ship (interactive landing)** term
  distinguishing it from AFK's autonomous admin-merge landing.
