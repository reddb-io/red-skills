---
"@reddb-io/red-skills": patch
---

The publish contract fixture asks the same question the boundary checker asks

`check-npm-tarball-boundaries.mjs` now decides "does this plugin ship a bundle?"
by reading the app's own bundle script for the emitted filename, because #4031
left `apps/plugin-dev` in place — it holds the MCP adapter and the cores — while
deleting the `dev.bundle.min.mjs` it used to emit. The contract test still built
its fixture from the old proxy (does `apps/<name>/` exist?), so it staged a
bundle the checker no longer expects and `workflow-security` went red on `main`.

Both sides now read the emitted name.
