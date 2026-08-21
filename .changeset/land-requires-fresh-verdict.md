---
"@reddb-io/dev": patch
"@reddb-io/worker": patch
"@reddb-io/shared": patch
---
Landing now requires a fresh verdict, and every way a change reaches the trunk is
written down. A merge is refused unless the verdicts ledger holds a non-voided
passing row for the head actually being merged — with the stable patch-id as the
clean-rebase fallback — and a mismatch appends the `voided` row that routes the
branch back to re-review. The seven land entry points are a declared table with a
ratchet that pins it in both directions, so a new entrance inherits the obligation
the moment its first merge primitive lands. A human adopting a branch by hand is
not exempt: they sign the landing `human:<login>` before it merges.
