---
"@reddb-io/red-skills": patch
---

A Re-seed budget exhausted with work still outstanding now parks WITHOUT closing its draft pull request (#2732, ADR 0129). A validation park is precisely the moment a human needs the diff open, so the draft is left standing and marked with the same `blocked:validation` label the Ticket carries — parked work and live work separate in one query instead of a join across two vocabularies. Both projections are sealed on the way out through one path: the trail's Issue comment is edited in place a final time and the draft's body is mirrored onto it, each carrying the rounds already spent plus the evidence that ended the budget, so the human queue starts from the diagnosis rather than from a search. Exhaustion parks identically whatever exhausted it — gate churn and a surviving blocking review finding take the same exit — and an attempt that never re-seeded has no trail to seal and parks exactly as it did before.
