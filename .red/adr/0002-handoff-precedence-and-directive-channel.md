# Handoff precedence ladder and the two-channel directive protocol

The `/afk` orchestrator rebuilds a handoff file from the live issue on every
attempt and feeds it to an inner agent. The handoff carries the issue body, the
history of previous attempts, and the comment thread. The thread is the problem:
when an operator posts a Human-In-The-Loop decision as a comment, it is
indistinguishable on the wire from an orchestrator-authored audit line — every
comment the orchestrator posts via `gh issue comment` from the operator's host
carries the operator's GitHub login. In one overnight session a single
under-specified issue burned ~40 BLOCKED attempts because the agent could not
tell the operator's HITL correction apart from boot stamps and heartbeats, and
no structural channel marked it as authoritative (PRD #29).

This ADR records the directive-channel design that closes that gap. It is
co-shipped with the builder implementation (`build_human_guidance`,
`build_thread_discussion` in `afk.sh`) rather than written ahead of it, so a
reader can cross-reference the rationale against the diff it explains.

## Decision

**Human→agent direction is carried by a marker inside the comment**, parsed
deterministically, never by an LLM at the handoff seam and never by operator
discipline alone.

**Marker syntax is `<details data-kind="directive">…</details>`.** The verbatim
text of every well-formed directive element (in document order) becomes the
comment's authoritative content. A comment with two markers produces two sibling
`<human-guidance>` elements with identical author/timestamp attributes; a
comment with no marker produces none.

**Unmarked human comments degrade — they are not dropped.** They surface in a
new `<thread-discussion>` element as `<thread-discussion-entry>` children,
verbatim, at the bottom of the authority ladder. Audit-noise (boot stamps,
promotion lines, heartbeats, envelopes) is filtered by body shape before
routing and reaches neither channel.

**Precedence ladder, highest to lowest:**

1. `<human-guidance>` — extracted directives (most recent sibling wins among
   conflicts)
2. `<issue-body>` — including HITL edits the operator pasted into the body
3. `<previous-attempts>` — history, never authoritative
4. `<thread-discussion>` — advisory only

The most recent `<human-guidance>` overrides anything in `<issue-body>` it
contradicts; that disagreement is the human's resolution, not a contradiction to
flag as BLOCKED.

**`<thread-discussion>` is tie-breaker only.** The inner agent may consult it to
disambiguate when (i) the brief is genuinely ambiguous *and* (ii) no
`<human-guidance>` resolves the ambiguity. It may never override the brief and
never justify BLOCKED on its own.

## Why

- **Determinism without an LLM in the critical path.** The orchestrator was just
  broken by a confidently-wrong inference; a per-handoff Haiku call would
  re-introduce the same class of failure at the load-bearing seam. A marker is
  a parser contract, not a guess.
- **`<details>` reuses what the handoff already ships** — the XML aesthetic and
  the parser machinery — and GitHub renders it as a collapsible visible in the
  thread, so the operator sees exactly what the agent will consume, with no
  hidden translation. `data-kind` is a namespace open to future extensions
  (`data-kind="question"`, `data-kind="reject"`) without a second convention.
- **Degradation, not dropping**, means zero migration burden: the 40+ legacy
  unmarked comments on live issues do not vanish from the agent's view, they
  downgrade in authority. The tier system mirrors the precedence ladder
  naturally (authority vs advisory).
- **Tie-breaker contract** resolves the realistic "operator explained their
  reasoning but forgot the marker" case without reopening the original
  vulnerability of chatty comments silently becoming authority.

## Rejected alternatives

These are the three load-bearing rejections from PRD #29's Human Decisions; each
was a real trade-off the agent could not have inferred.

- **Translation mechanism — rejected operator-discipline, LLM compiler, and a
  clarification-request channel** in favour of the in-comment marker. Operator
  discipline ("just write technical comments") famously fails at 3am. An LLM
  compiler in the orchestrator path adds a new failure mode — the LLM
  hallucinating a directive — in the exact path we just hardened. An
  agent-driven structured-clarification channel solves a different problem and
  does not bound blast-radius.

- **Marker syntax — rejected a markdown header (`## To agent`) and a fenced
  ` ```directive ` block.** A header forces parser tolerance for spelling drift
  ("## to agent", "## Agent", "## TO AGENT"), which reopens the ambiguity vector
  we just closed. A fenced block strips formatting (lists, links, code spans)
  and loses the GitHub render symmetry that lets the operator see what the agent
  will read.

- **Unmarked-comment handling — rejected silent drop and a grandfather
  period.** Silent drop loses useful operator context and forces a cold-turkey
  migration. A grandfather period introduces hidden temporal state — the same
  issue behaving differently depending on which comment arrived first — and the
  "first marked comment" trigger could fire by accident.

The inverse direction (agent→human envelope humanization) was also rejected as
out of scope: the envelope's `<summary>` line plus collapsible
`<details data-section="notes">` already provides the dual-audience pattern
natively through GitHub's progressive disclosure, and the inverse is not an
observed field problem.

## Consequences

- The builder routes by `classify_comment` (#30) and extracts content by
  `extract_directives` (#30) — a single source of truth shared with the
  per-issue BLOCKED cap (PRD #29 Track B), so the two tracks can never disagree
  about whether a comment carries a directive.
- Operators must learn the marker. Discoverability is handled by self-teaching
  at the cap-trip point plus baseline docs (README, SKILL.md), not by this ADR.
- `AGENT-PROMPT.md` already documents the ladder and the tie-breaker rule for
  the inner agent; this ADR is the canonical rationale behind that prose.
