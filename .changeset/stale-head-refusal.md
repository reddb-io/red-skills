---
"@reddb-io/dev": patch
---

Merge refuses stale heads. When a caller pins the tip its gate validated, the
landing compares it against the branch's live remote head — identical is the
ordinary landing, a clean rebase (same stable patch-id over the base) lands
the live head, and any other divergence refuses with both SHAs named, because
one commit passed the gate and a different one is what the merge would ship.
