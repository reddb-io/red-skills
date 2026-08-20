---
"@reddb-io/red-skills": patch
---

The unattended turn reads the verdict the Worker already wrote

A Ticket turn states its verdict in `_meta.redskills.ticket` — landed,
gate-blocked with the failed stage, refused with the stage and the reason — and
sets `workflowOutcome` only when it LANDED. The daemon's narration read the
workflow outcome alone, so a refusal and an ordinary prompt turn printed the
same sentence: `no-workflow-outcome (end_turn)`. The Worker had already written
down why; nobody read it.

The record now reads the verdict first and falls back to the stop reason for
the ordinary turns that carry none.
