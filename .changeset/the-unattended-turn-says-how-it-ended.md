---
"@reddb-io/red-skills": patch
---

An unattended turn says how it ended

The first Worker born by a real drain lived 600 ms and exited cleanly, and no
surface said why. `project_status` kept reporting `posture: asking`,
`workers: 0` — which reads like a host that is busy rather than one whose turn
already finished — because only the FAILURE path of a demand turn reached a
surface. A turn that completed wrote nothing anywhere.

The daemon now narrates every unattended turn on its own journal, naming the
project, the work item, the Worker and the outcome. The outcome carries both
halves: the workflow outcome when the Worker stated one, and the stop reason
beside it either way — `completed` and `end_turn` are different sentences, and
a turn that ends in under a second is only legible when the record says which
one ended it.

**Silence looked like health**, which is the third time this shape has cost a
diagnosis in this lane.
