---
"@reddb-io/redskilled-link": patch
---

The link Host projects a non-sensitive `status.json` (schema version and active paired-device count only) beside its private state, so host-side surfaces can show pairing presence without reading secrets; the private state loader now validates every invitation and device record instead of only the top-level shape.
