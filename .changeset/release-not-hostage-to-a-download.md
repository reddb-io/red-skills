---
"@reddb-io/red-skills": patch
---

The release no longer depends on a download it never uses

Publishing 3.17.3 failed at `pnpm install`: `@reddb-io/sdk`'s postinstall
fetches the `red` binary from GitHub Releases and got an HTTP 503, then a 404.
The Version PR was already merged, so `main` carried the bumped versions while
the registry carried nothing — and the publish job only fires on that merge,
so there was no path back except a fresh version cycle.

The release job builds and publishes packages; it runs no SDK. Both of its
installs now set `REDDB_SKIP_POSTINSTALL=1`, which is the difference between a
release that depends on our own artifacts and one that depends on someone
else's uptime. Fixed in the generator (`apps/release`) as well as the emitted
workflow, so `/red-setup` does not regenerate the fragility.
