---
"@reddb-io/red-skills": minor
---

PR medic (#2513, Spec #2511 slice 2): when the merge driver classifies a PR needs-medic, a bounded mechanical healing round runs in an isolated feedback-lane worktree before any escalation — stale staged Pi mirrors are regenerated, registered identifier renames applied, and additive conflicts union-resolved; anything semantic escalates untouched. Two failed rounds per PR escalate to needs-human, every action ledgered in `.red/state/castle/pr-medic.toon`; a healed push re-arms the PR on the driver.
