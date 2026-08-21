---
"@reddb-io/redskilled": patch
---

The birth breaker reads a one-shot sink completion as a completion. A
host-event hook runs for seconds and exits 0 — that clean exit IS its whole
report — but the breaker demanded the queue protocol's promise sentinel, so
three events inside a minute armed the crash-loop latch forever on any host
with a hook declared. A clean exit from the host-events project now counts as
work-reported; a hook that genuinely fails still surfaces.
