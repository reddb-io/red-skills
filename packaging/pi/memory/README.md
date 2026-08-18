# @reddb-io/red-skills-memory

reddb.io memory plugin - governed operational memory for code agents that lives on top of dev. Supports markdown notes, RedDB graph memory, zero-token governed recall, context packs, claim checks, readiness, optional lifecycle hooks, MCP/HTTP read surfaces, Workbench diagnostics, and Skill telemetry for self-improvement.

This package ships the **memory** plugin: its manifests, hooks, scripts and the skill tree, for [pi](https://pi.dev) (the `@earendil-works/pi-coding-agent` harness) and for the RedSkills universal installer, which materialises it for OpenCode, RedCode and local marketplace registrations. It carries the same `SKILL.md` files the Claude Code and Codex marketplaces already expose, scoped to the published buckets only:

- `skills/core/`

Install:

```bash
pi install npm:@reddb-io/red-skills-memory
```

Updates follow the same release train as the rest of the red-skills monorepo. `pi update --all` resolves the latest matching version from the npm registry.

## Source

This package is generated from `plugins/memory/` in [reddb-io/red-skills](https://github.com/reddb-io/red-skills). To regenerate locally:

```bash
pnpm pi:packages:build
```

## License

Apache-2.0.
