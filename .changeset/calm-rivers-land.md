---
"@reddb-io/dev": minor
---

Landing squashes a worker branch's own micro-history to one commit at its fork
point before the pre-merge rebase, so a 60-commit retry chain presents ONE
consolidated conflict set instead of replaying every continuous-push commit
sequentially onto fresh trunk. Branch adoption (re-claim resume) now opens with
a mandatory base sync instruction — fetch + rebase onto origin/<base>, resolving
conflicts while the agent is present and drift is smallest. (#2481)
