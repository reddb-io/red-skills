# @reddb-io/red-skills-internal

reddb.io internal plugin - maintainer-only skills for operating the red-skills repository.

This package ships the **internal** plugin: its manifests, hooks, scripts and the skill tree, for [pi](https://pi.dev) (the `@earendil-works/pi-coding-agent` harness) and for the RedSkills universal installer, which materialises it for OpenCode, RedCode and local marketplace registrations. It carries the same `SKILL.md` files the Claude Code and Codex marketplaces already expose, scoped to the published buckets only:

- `skills/maintainer/`

Install:

```bash
pi install npm:@reddb-io/red-skills-internal
```

Updates follow the same release train as the rest of the red-skills monorepo. `pi update --all` resolves the latest matching version from the npm registry.

## Source

This package is generated from `plugins/internal/` in [reddb-io/red-skills](https://github.com/reddb-io/red-skills). To regenerate locally:

```bash
pnpm pi:packages:build
```

## License

Apache-2.0.
