---
"@reddb-io/red-skills": patch
---

`review` joins the gate's stage order as its third stage, after feedback and backpressure (#2726). This is vocabulary: a stage absent from the fold cannot block, so nothing changes behaviourally until a producer pushes a review outcome. What it buys is that the two properties a diff review needs — running only once the earlier, cheaper stages are green, and degrading instead of failing the attempt when it cannot run — are now native fold behaviour (the short-circuit on the earliest blocker, and the `skipped` outcome that never blocks) rather than machinery reimplemented beside the gate. The dev glossary's `Gate stage order` term is updated to the current order and drops the `trust` stage that went with the sensitive-path removal in #2417.
