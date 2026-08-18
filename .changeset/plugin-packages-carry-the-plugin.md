---
"@reddb-io/red-skills": patch
---

Install works again from the npm package set: each `@reddb-io/red-skills-<plugin>` package now carries the whole plugin definition (manifests, hooks, scripts, `.mcp.json`) rather than a skills excerpt, so the OpenCode/RedCode generator and local marketplace registrations can consume the materialised tree; the universal installer writes a host activation config beside that tree, runs the sub-installers through `bash` (the tarball drops the executable bit), and no longer demands a runtime bundle from the skills-only `internal` plugin.
