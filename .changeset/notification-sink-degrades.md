---
"@reddb-io/redskilled": patch
---

An absent notification binary degrades the sink instead of crash-looping it.
On a headless host the daemon fired notify-send through the Worker birth
pipeline for every lifecycle event; each sink Worker died on ENOENT inside a
second, tripped the crash-loop breaker, backed off and re-armed — forever,
each churn holding a slot against the host ceiling. The binary is probed once
per boot; when absent the daemon says so once and never births the sink again.
