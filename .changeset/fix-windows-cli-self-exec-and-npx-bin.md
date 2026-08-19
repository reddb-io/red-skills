---
"@reddb-io/dev": patch
"@reddb-io/shared": patch
"@reddb-io/release": patch
"@reddb-io/rsp": patch
---

Windows: CLI self-exec guard now matches real paths, and the published
`red-skills-dev` bin comes from the plugin package.

The self-exec guards (`import.meta.url === \`file://${process.argv[1]}\``) never
matched on Windows, where `process.argv[1]` is a backslash path but
`import.meta.url` is a `file://` URL — so every bundle CLI (`dev`, `release`,
the shared red-fetch/afk entrypoints, and the rsp two-axis benchmark) exited
0 without running when invoked by path. The guards now compare resolved
filesystem paths (`resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))`),
matching the pattern `apps/dev/src/mcp-server.ts` already used.

The published Pi plugin packages (`@reddb-io/red-skills-<plugin>`, ADR 0146)
now carry a `bin` for plugins whose tree ships one (`plugins/<name>/bin/`), so
the canonical dev CLI invocation works from the plugin package instead of the
core package's stale shim:

```bash
npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev <subcommand>
```

The core `@reddb-io/red-skills` package's `red-skills-dev` bin shim looked for
the dev bundle next to itself, but ADR 0146 moved plugin bundles into
`@reddb-io/red-skills-<plugin>` packages — the shim errored with "packaged
bundle missing" on every host. Skill docs that taught the core-package form
now point at the plugin package.
