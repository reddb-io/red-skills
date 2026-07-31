---
"@reddb-io/red-skills": patch
---

A dispatch that pushes commits and opens no pull request no longer exits 0 (#2893). #2865 taught the NEXT Worker to adopt the branch its issue already has, which stops the redo; it cannot stop the invisibility, because a run recorded as successful is never re-dispatched and the branch simply sits on origin. An exit code of 0 over work with no route to the trunk is a false success, and a false success is worse than a failure — a failure gets retried. The run now censuses the branches of the issues it processed, prints what it left behind, and exits 1 when a targeted dispatch stranded proven commits.

**Only proven commits flip the exit code; everything unread is still said out loud.** `branchCommitsAhead` answers `undefined` when it cannot read a branch, and a probe that merely blinked must not fail a run — but silence about possible loss is the defect being fixed, so an unread branch is listed with an unknown count rather than dropped. A branch proven to hold zero commits is the empty ref worktree creation pushes, not stranded work, and is never reported.

**A deliberately push-only run is never accused.** A `scout` investigation and `/go --mode local-only` (`--local-merge`) were never going to open a pull request, so the branch they leave is the product of the run; announcing it as orphaned would train every operator to ignore the warning.

**`red-skills-dev orphan-branches` makes the loss discoverable from a surface.** It reads every remote `afk/*` ref against the trunk and the open-PR census and emits a TOON report naming branch, issue and commit count — exit 1 when the listing is non-empty — so recovering finished work is one command instead of a `git branch -r` investigation.
