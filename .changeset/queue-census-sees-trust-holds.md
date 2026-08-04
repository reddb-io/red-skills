---
"@reddb-io/dev": patch
---

Partition `queue_status` into eligible and trust-held ready work, and keep
maintainer-summon holds out of AFK drain progress totals.
