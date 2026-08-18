---
"@reddb-io/red-skills": patch
---

Publish and install again: a skills-only plugin (`internal`) ships no runtime bundle, so the release's tarball boundary check and the installer stop demanding one — the v3.19.1 publish died on that check, and the fix lives in the tagged tree.
