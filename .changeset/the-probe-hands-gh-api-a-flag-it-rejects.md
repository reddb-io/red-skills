---
"@reddb-io/dev": patch
---

Stop handing `gh api` the `-R` flag it rejects, which parked landings as broken infrastructure

`readQueuedPrView` prefixed `-R <repo>` onto whatever the REST plan produced. `-R`
belongs to `gh pr view`; `gh api` refuses it outright — `unknown shorthand flag:
'R' in -R` — and the plan already carries the repository inside its path,
`repos/<owner>/<name>/pulls/<n>`.

So every REST-routed merge confirmation failed before it reached GitHub. The wait
loop is deliberately built so an unreadable probe is not a verdict, which is
correct and which turned a permanently-failing command into four retries, an
exhausted budget, and an issue parked `blocked:infra` telling a human to *"fix the
landing infrastructure failure"* that was never there. Two issues sat in that
state (#3182, #3169), one of them the last open ticket of a Spec and the other the
fix for a flake blocking the release train.

The sibling call site, `readSingleObject`, hands `plan.args` straight to `gh` and
was always correct.

The existing test asserted the PATH was present, which `gh -R o/r api
repos/o/r/pulls/42` satisfies too — so it went on passing while every real probe
failed. The new test asserts the flag's ABSENCE.
