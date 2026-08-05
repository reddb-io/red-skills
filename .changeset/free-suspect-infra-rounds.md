---
"@reddb-io/dev": patch
---

Treat sub-second suspect-infra gate failures as environment failures that retry without consuming the Worker's re-seed budget.
