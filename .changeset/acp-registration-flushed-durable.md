---
"@reddb-io/redskilled": patch
---

A registration made or released through the ACP drain path is durably flushed to the intent store before the drain answers, matching the socket ops — a daemon that dies right after answering no longer forgets the registration it just confirmed.
