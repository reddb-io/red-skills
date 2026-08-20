---
"@reddb-io/red-skills": patch
---

The Release carries v1 beside v2 until the readers have flipped

**A schema bump is only landed when its readers can read it.** `red.package-set.v2`
moved `version`, `channel` and `targets` inside the signed identity and took the
canonical manifest name in 4.0.0 — which is exactly when red-dev, whose verifier
mirrors v1 key-for-key, began refusing every set from that release:

```
fail red-skills package set refused (manifest): manifest shape or key order is not canonical
     current is unchanged — the machine keeps the set it already resolves
```

A machine that cannot install the release cannot be told about the release. It
sat on 3.22.0 with a partial update whose host reconciliation had failed for
hours before anyone read the reason.

So a Release now attaches both: `package-set.manifest.json` keeps the canonical
name and the v1 shape every existing verifier knows, and `package-set.manifest.v2.json`
rides beside it with its own signature. Both come from one pass over the same
artifacts, so they cannot describe different sets, and the shipped verifier
checks either — `--require-target` still needs v2 and says so instead of reading
a field a v1 manifest does not have.

The canonical name flips to v2 when the readers have flipped, and v1 leaves
then, not before.
