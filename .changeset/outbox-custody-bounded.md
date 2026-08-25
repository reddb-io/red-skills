---
"@reddb-io/redskilled": patch
---

The GitHub outbox and the merge custodian shed their history: published outbox entries (kept for idempotency replay — request and response body both) are bounded to the newest 500, pending entries never compacted; terminal custody records (receipts, not obligations) are bounded to the newest 100, active records never compacted. Both compactions run on load and on the write path, so a daemon that never restarts stops re-encoding an ever-growing array on every mutation. Leak-audit finding #4.
