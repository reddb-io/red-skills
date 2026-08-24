---
"@reddb-io/dev": patch
"@reddb-io/redskilled": patch
---

`status { scope: "host" }` now answers from the daemon's host_state instead of silently returning project status, and `scope: "worker"` refuses by name until a daemon method serves it — a scope silently substituted was a wrong answer wearing a healthy face.
