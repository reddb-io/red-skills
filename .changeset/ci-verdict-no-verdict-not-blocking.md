---
"@reddb-io/red-skills": patch
---

A pending CI rollup no longer parks a healthy attempt as `blocked:ci` (#2747). The landing tail classified a `BLOCKED` PR whose required checks had not reported yet as ready to merge — the state every PR passes through in the seconds after it opens — so branch protection rejected the merge and the landing path parked that rejection as `blocked:ci`, converting finished work into HITL backlog on a PR that never carried a failing check. `classifyMergeState` now takes the base branch's required contexts into account: a required check with no verdict in the rollup, an empty rollup, or an unreadable one keeps the attempt waiting inside the tail instead of merging into the hole. Only a check that actually concluded unsuccessfully still classifies as `ci-failed`, and a `BLOCKED` PR whose required checks all reported green still attempts the merge, so the required-review handoff is unchanged.
