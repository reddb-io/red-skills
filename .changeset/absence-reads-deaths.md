---
"@reddb-io/redskilled": patch
---

An unreachable statusline now carries the dead daemon's own evidence as a second line — the newest daemon death from the on-disk death lane, dated, with its exit path, phase, and detail — instead of only a generic "unreachable".
