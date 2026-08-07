---
"@reddb-io/dev": minor
---

The engine stops being stopped by things that were never conflicts.

Several fixes in this span share one shape: a guard that judged by a **list**
instead of by the **operation**, so ordinary work tripped it and a human had to
come clear the latch.

- **Trunk freshness tolerates dirt the incoming commits do not touch.** The probe
  used to refuse on any dirty path outside a named allowlist, so a maintainer
  editing a file in their own checkout killed every Worker born during the edit —
  three deaths in sixty seconds latch the birth breaker and the drain stops. Two
  allowlists had already been added for this (setup-owned output, then the ADR
  0092 doc set) and each was too narrow to survive the next ordinary day. The
  guard now asks whether the dirt collides with the paths the fast-forward
  writes. A tracked edit that does collide still refuses, and the evidence names
  the paths either way.
- **A zero-byte `.git/index.lock` that no live process holds is reclaimed.** The
  same probe blocked on a lock left behind by concurrent worktree work. A lock
  with bytes in it, or one a running git owns, still refuses — reclaiming it
  would corrupt an index something is writing.
- **The regeneration moment watches the source, not only the mirror.** A branch
  that added or edited a skill touched none of the paths the generated-validation
  moment watched, so the mirror went stale on the branch and the staleness
  surfaced in CI as two red checks that named neither the cause nor the cure.

## Runners and models

- **Every supported runner ships its own current table**, and none inherits
  another's silently — a runner without one now says so instead of quietly
  resolving through Claude's.
- **The task class can choose the runner**, not only the model. `default_runner`
  remains the fallback for any tier left unmapped, so a repo that does not use
  the map behaves exactly as before.
- **Precedence is a contract rather than a comment.** The three things that beat
  `default_runner` silently — `RED_AFK_RUNNER`, an explicit `--runner`, and a
  runner named in a registration — are declared in one place, and a surface
  reports the effective runner, model and effort per tier with the origin of
  each value.

## Also in this span

- **One Worker, one log lane, whatever its origin.** `/go` wrote plain text to a
  date-partitioned lane while `/afk` wrote TOONL under the Worker. The date was
  resolved once at registration and then handed out for days, so a Worker wrote
  today's log into a past day's directory — one the janitor was concurrently
  reclaiming. Paths resolve at birth now, a failed mkdir says so instead of
  launching a mute Worker, and `.red/tmp/logs/` is retired with its last writer.
- **Codex sees only the skills it should.** `disable-model-invocation` never
  travelled to Codex, so 29 skills meant to stay hidden sat in every Codex
  worker's context. Each skill now ships a generated `agents/openai.yaml`
  sidecar, held by a ratchet so a new skill inherits the obligation the moment
  its `SKILL.md` lands. Display names keep their acronyms — the label a Codex
  surface shows read `Tdd` and `Adr Editor` before this.
- **The grilling interview asks the frontier, not one question.** `/start` works
  its design tree in rounds: every decision whose prerequisites are settled goes
  in one round, and a question depending on one still open waits for the next.
  One line per thing to read, evidence written once above the round.
- **`writing-for-agents`** replaces `write-a-skill` and covers any document an
  agent reads, `AGENTS.md` and `CLAUDE.md` included.
- **Three skills adopted from `mattpocock/skills` v1.2.2**: `wait-what`,
  `wizard` and `to-questionnaire`. The upstream pin moves to `8b36d4f`.
- **`CHANGES.md` is retired.** It was a parallel ledger of upstream divergence,
  3083 lines describing what git already described. The commit and the PR body
  carry the reason now.
