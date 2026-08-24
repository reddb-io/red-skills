---
"@reddb-io/redskilled": patch
---

The durable ACP session journal prunes connect-only sessions past a 24-hour window and caps itself at the 200 newest records — applied by its own writer at load and on every session creation — instead of growing without bound while full-snapshot-rewriting on every append.
