---
"@reddb-io/redskilled": patch
---

Project identity resolution rides a durable per-remote cache and the daemon's own personal credential, so a rate-limited or offline GitHub API no longer silently demotes a known repository to a second `remote:<slug>` identity; a demotion that does happen is recorded on the host event lane instead of vanishing.
