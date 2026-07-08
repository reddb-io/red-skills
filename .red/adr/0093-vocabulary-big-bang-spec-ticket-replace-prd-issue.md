# Vocabulary big bang: Spec and Ticket replace PRD and Issue

Upstream mattpocock/skills v1.1.0 renamed `to-prd → to-spec` and `to-issues → to-tickets`, arguing the artifact we produce is a specification (it carries implementation and testing decisions, which a PRD does not) and that "issues" is tracker-jargon while "tickets" names the unit of work. Both arguments apply to RedSkills — our "PRD" template has always been a spec — so we adopt the rename at **total vocabulary scope**: skill names (`/to-spec`, `/to-tickets`), label vocabulary (`type:prd → type:spec`, `prd:N → spec:N`), the `/afk --prd` flag (`--spec`), and the glossary terms themselves (**Ticket** is canonical for the tracked unit, **Spec** for the parent document; "issue" survives only to name the GitHub object, "PRD" only in historical records).

We migrate **big bang**, not expand–contract: one release renames skills, labels, flags, and runtime parsing together, with a one-time relabel sweep over open Tickets and the fleet stopped for the flip. Closed Tickets keep their historical labels.

## Considered Options

- **Reject the rename** (keep PRD/Issue) — rejected by the maintainer: alignment with upstream vocabulary wins over churn avoidance.
- **Skill names only / operational-chain only** — rejected: a `/to-spec` writing `type:prd`, or labels disagreeing with the glossary, is worse than either consistent world.
- **Expand–contract migration** (runtime reads both vocabularies during a transition window) — rejected by the maintainer in favour of one atomic flip; the cost is that older installed bundles cannot parse the new vocabulary, accepted because the fleet is single-host today.

## Consequences

- Historical ADRs, envelopes, memories, and closed Tickets say "PRD"/"issue"; readers map them via the glossary's _Avoid_ notes. We do not rewrite history.
- `/setup-red-skills` (label seeding), `/doctor` (vocabulary checks), the triage-labels vocabulary doc, the AFK runtime (`prd:` body/label/flag parsing), statusline/dashboard counters, and the `red-*.yml` workflows all change in the same release.
- The flip requires the fleet stopped and a relabel sweep; in-flight Tickets carrying old labels before the sweep are relabeled, not re-filed.
