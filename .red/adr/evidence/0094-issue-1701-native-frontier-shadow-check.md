# ADR 0094 evidence: native blocked-by frontier shadow check

Issue: #1701
Parent Spec: #1697
Observed window: 2026-07-14T04:02:17Z through 2026-07-14T04:22:25Z

## Scope

This was a read-only replay of one real AFK drain window for the #1697 child
tracker. The comparison used two frontier definitions:

- Label frontier: a ticket is dependency-unblocked when it has no `req:N`
  labels, or every `req:N` target was closed at the observation time.
- Native frontier: a ticket is dependency-unblocked when GitHub's
  `issue_dependencies_summary.blocked_by` open-blocker count is `0`.

Non-dependency gates such as `blocked:validation` were kept out of the
dependency-frontier decision. They can keep a ticket out of `ready-for-agent`,
but they do not change whether dependency blockers are open.

## Evidence

Native edge timing was present before the drain:

- #1700 had native blocked-by #1698 and label `req:1698` before #1698 closed.
- #1701 had native blocked-by #1700 and label `req:1700` before #1700 closed.

Close and cascade timing:

- #1698 closed at 2026-07-14T04:02:18Z. #1700 shed
  `blocked:dependency` and `req:1698`, then gained `ready-for-agent`, at
  2026-07-14T04:02:29Z.
- #1700 closed at 2026-07-14T04:22:12Z. #1701 shed
  `blocked:dependency` and `req:1700`, then gained `ready-for-agent`, at
  2026-07-14T04:22:24Z.

Primary dependency-edge observations:

| Observation | Label frontier | Native frontier | Result |
| --- | --- | --- | --- |
| 2026-07-14T04:02:17Z, before #1698 close | #1700 blocked by open `req:1698`; #1701 blocked by open `req:1700` | #1700 blocked by open #1698; #1701 blocked by open #1700 | 2/2 agree |
| 2026-07-14T04:02:24Z, after #1698 close and before label cascade | #1700 unblocked because `req:1698` pointed at a closed issue; #1701 still blocked by open `req:1700` | #1700 `blocked_by == 0`; #1701 `blocked_by == 1` | 2/2 agree |
| 2026-07-14T04:02:30Z, after #1700 promotion | #1700 had no `req:N`; #1701 still blocked by open `req:1700` | #1700 `blocked_by == 0`; #1701 `blocked_by == 1` | 2/2 agree |
| 2026-07-14T04:22:11Z, before #1700 close | #1700 unblocked; #1701 blocked by open `req:1700` | #1700 `blocked_by == 0`; #1701 `blocked_by == 1` | 2/2 agree |
| 2026-07-14T04:22:18Z, after #1700 close and before label cascade | #1701 unblocked because `req:1700` pointed at a closed issue | #1701 `blocked_by == 0` | 1/1 agree |
| 2026-07-14T04:22:25Z, after #1701 promotion | #1701 had no `req:N` | #1701 `blocked_by == 0` | 1/1 agree |

Primary dependency-edge total: 10/10 agreements, 0 divergences.

Whole #1697 open-child dependency frontier:

- Including no-dependency siblings that existed during the same observations
  (#1698 before it closed, and #1699 throughout the window), the replay had
  17/17 dependency-frontier agreements.
- The #1699 validation gate was intentionally not counted as a dependency
  divergence: it had no open `req:N` blockers and no open native blockers.

Current static cross-check after the replay:

- Current open non-Spec tracker tickets checked: 9.
- Open dependency-frontier agreements: 9/9.
- Some open tickets retain closed native historical blockers in
  `total_blocked_by`, but their `blocked_by` open-blocker count is `0`; this
  matches the label frontier after `req:N` labels are shed or point only at
  closed blockers.

Combined observed total: 26/26 agreements.

## Divergences

No frontier divergences were found.

- Missing native edge: none observed in the replay window.
- Stale label causing disagreement: none observed.
- Timing skew around close cascade: observed twice, but not divergent. During
  both skew intervals, the remaining `req:N` label already pointed at a closed
  blocker, so the label frontier became unblocked at the same point as
  GitHub's open-blocker count.

## Open-blocker semantics

GitHub's `issue_dependencies_summary.blocked_by` behaved as an open-blocker
count, not as a total edge count. That matched the AFK promote rule at every
observation point in this drain:

- Before blocker close, both frontiers treated the dependent as blocked.
- Immediately after blocker close, both frontiers treated the dependent as
  unblocked, even before the AFK close cascade removed `blocked:dependency`
  and the `req:N` label.
- After the cascade, both frontiers remained unblocked.

## Recommendation

Evidence supports drafting a full-native supersession ADR for the dependency
frontier/promote read path. This report does not itself supersede ADR 0094; a
future human-authored ADR still needs to specify how authoring parity, edge-list
audits, and closed native historical blockers relate to label shedding.
