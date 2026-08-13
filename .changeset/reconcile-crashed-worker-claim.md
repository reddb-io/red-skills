---
"@reddb-io/red-castle": patch
"@reddb-io/red-skills": patch
---

A crashed Worker's claim is reconciled instead of stranding its issue

A Worker that died without conceding left three facts that never met: the
issue still carried its `running` label, the pids it named were gone, and the
remote branch it had pushed was empty. Each surface read one of the three and
so each read the issue as someone else's live work — the claim never expired,
no other Worker could take it, and the issue sat held by a process that no
longer existed.

Claim staleness now judges the process rather than the label. A claim whose
pids are all dead is stale no matter what the label says, boot cleanup
reconciles the stranded shape it finds, and `claim_status` reports the dead
holder as dead rather than as an owner.
