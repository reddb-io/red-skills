---
"@reddb-io/dev": patch
---

Fix the AFK engine's push/re-park chain: an attempt-branch push rejected non-fast-forward now reconciles with --force-with-lease under claim ownership instead of parking; the push-failed blocker names the real cause (divergence vs access); requeue guidance can no longer evaporate on the adopt fast-path; and an identical-signature re-park within a short window escalates as a detected loop instead of rebirthing workers forever.
