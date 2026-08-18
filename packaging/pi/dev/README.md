# @reddb-io/red-skills-dev

reddb.io dev plugin - engineering skills for code agents (autonomous /afk loop, /go dispatch, triage, tdd, diagnose, graph-aware codebase understanding, ...)

This package ships the **dev** plugin: its manifests, hooks, scripts and the skill tree, for [pi](https://pi.dev) (the `@earendil-works/pi-coding-agent` harness) and for the RedSkills universal installer, which materialises it for OpenCode, RedCode and local marketplace registrations. It carries the same `SKILL.md` files the Claude Code and Codex marketplaces already expose, scoped to the published buckets only:

- `skills/engineering/`
- `skills/misc/`
- `skills/knowledge/`
- `skills/productivity/`

Install:

```bash
pi install npm:@reddb-io/red-skills-dev
```

Updates follow the same release train as the rest of the red-skills monorepo. `pi update --all` resolves the latest matching version from the npm registry.

## Source

This package is generated from `plugins/dev/` in [reddb-io/red-skills](https://github.com/reddb-io/red-skills). To regenerate locally:

```bash
pnpm pi:packages:build
```

## License

Apache-2.0.
