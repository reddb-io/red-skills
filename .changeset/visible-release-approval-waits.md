---
"@reddb-io/red-skills": patch
---

Surface stalled Version-PR checks to humans

Version-PR workflows now run a 20-minute release watcher. It opens or refreshes
a GitHub Ticket when current-head workflow runs await approval or when required
contexts never started, while ordinary pending or failing checks and transient
strict-base lag remain distinct non-paging states.
