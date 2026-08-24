---
"@reddb-io/redskilled": patch
---

`redskilled reclaim --projects` sweeps `local-*` project workspaces whose seeding checkout no longer exists — evidence-judged (the seed clone's origin is the original path), grace-windowed, and refusing to touch github/remote projects or anything holding live drain intent.
