---
"@reddb-io/redskilled": patch
---

A codex child is launched in the unattended posture. The adapter's defaults
ask for approval on every write, nobody answers a permission dialog in an
unattended turn, and the refusal made codex abort the whole turn as
"interrupted" on its first apply_patch. The catalog now declares launch args
per adapter — codex gets `approval_policy=never` and full access, the same
trust the native redcode child already runs with, because the product's
isolation is the disposable Worker workspace and its cgroup.
