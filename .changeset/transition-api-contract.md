---
"@reddb-io/red-skills": minor
---

Transition-API contract (#2528, ADR 0122 rule 5): boot quarantine, claim-sweep requeue, orphan restore, close-cascade promote, unblock-sweep promote, and the watchdog stale-claim reconcile now flow through `planTransition` — each mutation is one atomic edit proven to leave exactly one state role, so the 2026-07-22 poison shapes (stacked state roles, requeue over dangling req:* edges) are unconstructible from engine paths. A repo-wide contract lint fails any new raw state-role `editLabels` call site outside the justified allowlist.
