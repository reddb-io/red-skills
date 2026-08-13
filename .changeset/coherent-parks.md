---
"@reddb-io/red-skills": patch
---

Park transitions now keep the blocker body and typed label coherent. Runner
failures use `blocked:runner`, validation-infrastructure failures always write
their matching blocker record, and `hitl_resolve` repairs historical mismatches
by projecting labels from the authoritative body before applying the requested
transition.
