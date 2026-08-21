---
"@reddb-io/shared": patch
"@reddb-io/dev": patch
---

The dev warm path anchors on the daemon bundle instead of a dev bundle no package ships.

ADR 0147 rule 1 deleted the dev runtime bundle with the binary it was, but the SessionStart hook kept asking npm for `dist/dev.bundle.min.mjs`. `@reddb-io/red-skills-dev` is a skills-only pi package and core stopped building the asset, so every warm failed `bundle-missing`, the detached self-update wrote that failure into `dev-stable.self-update.json`, and the AFK coherence probe read the hours-old updater error as `stale-failed-check` and refused to start on a host with nothing wrong with it (#4112). The hook now fetches `redskilled` — the bundle that births every Worker and that the documented `statusLine` globs — with `rsp` and `rsp-core` riding along as its companions out of the one core package, and the pointer, the status file and the coherence probe follow it.
