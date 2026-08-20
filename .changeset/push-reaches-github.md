---
"@reddb-io/redskilled": patch
---

The repository push targets the canonical GitHub URL instead of the
mirror's `origin` — which is the human checkout, a local path — so a
Worker's publish actually reaches the tracker, and a push failure carries
git's own words instead of a bare internal error. Every publish on a
mirror-cloned machine died at this line.
