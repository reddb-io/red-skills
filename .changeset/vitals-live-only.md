---
"@reddb-io/red-skills": patch
---

`worker_vitals live_only: true` now means live. The filter admitted any record carrying an alert, and every dead worker carries a stalled alert forever — so 344 corpses rode through the live filter and buried the one live worker under 559KB of payload, which read as "the worker produced zero lines" while it was 723 lines into its review. A dead worker with an alert is what `live_only: false` is for; an alert that matters on a live read is one attached to a worker that is still active.
