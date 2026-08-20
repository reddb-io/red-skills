---
"@reddb-io/release": patch
---

The vendored-bundle guard compares code, not the release number: the
embedded build version and git sha are normalized like the build time
already was, so the version train no longer reddens every Worker gate one
release after each vendored refresh.
