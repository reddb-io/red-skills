# Merge-Gate Policy

The unlocked admin-merge (`gh pr merge --admin --merge`) **ignores advisory review checks by default** — this is intentional. The binding gates are:

1. **`drift-guard`** — the `pre_merge` hook, a hard gate.
2. **In-process backpressure / feedback** — the pre-merge feedback-validation step.

External advisories (CodeRabbit, etc.) are not binding. Opt into waiting with `afk.merge.wait_for_review: true` — the landing then polls the configured review check until it concludes and merges regardless (so reviews post before the merge but never block the land).
