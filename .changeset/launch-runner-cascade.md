---
"@reddb-io/red-skills": patch
---

Fleet launch runner cascade (#2545): a fresh `fleet N` launch honors the operator's `RED_AFK_RUNNER` env over the stale registered profile (flag > env > profile — the profile no longer shadows the env as a pseudo-flag), an invalid explicit runner errors loudly instead of silently resuming the old one, and `fleet_create` against a live-but-unregistered supervisor registers the orphan profile so `fleet_edit`/`fleet_status` work instead of the create-says-running/edit-says-not-exists trap.
