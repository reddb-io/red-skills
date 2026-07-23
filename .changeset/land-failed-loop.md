---
"@reddb-io/red-skills": patch
---

Land-failed retry loop killed (#2576): merge-retry accounting now consults the ADR 0122 heal ledger so the RED_AFK_RETRY_MERGE cap survives worker replacement — a replacement worker restarting at attempt 1 can no longer loop 100+ identical land-failed cycles; the 3rd durable strike escalates. Landing failures also preserve their real diagnostic (push failure vs merge-step reason) into the blocker record and envelope instead of a generic `merge-conflict` with `(no merge log captured)`.
