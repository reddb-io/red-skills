---
"@reddb-io/red-skills": patch
---

Unbreak main: the VS Code event fixtures were missing a field the record gained

`RedskilledHostEvent` gained a required `pids_peak` column, and the two fixtures
in the VS Code extension's tests never learned about it. Both build the record by
listing every field and spreading a `Partial` last, so a field the literal does
not name arrives only from the spread — typed `number | null | undefined` against
a required `number | null`.

The blast radius was the whole repository, not one package: `typecheck` runs
across the workspace, so every open pull request failed it, including the Version
PR whose entire diff is version numbers. Four PRs read as broken when the break
was on the branch under all of them.
