---
"@reddb-io/red-skills": patch
---

The queue poll keeps the identifiers it counted

A poll that counts and then discards has to be asked again. The REST lane
already held every item it counted and threw the identifiers away, so a birth
had a depth and nothing to hand a Worker — the first slice of Spec #4097.

The registration's `last_poll` now keeps them, bounded at 32 so a record cannot
grow with the backlog, and `project_status` reports them so an operator can see
WHAT the daemon believes is queued rather than only how much. They stay opaque
in the sense ADR 0130 rule 3 requires: stored, echoed, never parsed.

A poll that could not list carries the previous list forward — **an unreachable
queue is not an empty one**, and erasing it would tell every later reader the
backlog emptied at the moment the network did. A `counted` poll always
replaces, including with an empty list, which is a real answer.
