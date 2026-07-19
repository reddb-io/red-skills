# Report Runtime Wrapper

All RedSkills operational-report skills delegate to the dev runtime; they never
hand-calculate metrics.

## Run shim

Resolve the RedSkills dev runtime the same way for every operational skill:

1. Prefer an installed `red-skills-dev` shim on `PATH` when `command -v
   red-skills-dev` succeeds. This is the short form used by prepared hosts.
2. Otherwise use the ADR 0091 npm direct-run transport. Pin a known version when
   the caller or repo provides one; use the current dist-tag only when no pin is
   available:

```bash
npx -y -p @reddb-io/red-skills@<version> red-skills-dev <subcommand> [args]
```

If `red-skills-dev` is missing, do not report a bare command-not-found. Say that
the host lacks the shim and run, or ask the operator to run, the `npx -y -p
@reddb-io/red-skills@<version> red-skills-dev ...` fallback.

The valid dev CLI subcommands for these skills are explicit: `run`, `fleet`,
`monitor`, `dashboard`, `daily-review`, `weekly-review`, `retake`, and
`requeue`. There is no `red-skills-dev afk` subcommand; `/afk` maps to
`red-skills-dev run` or to the bare run flags documented by the AFK skill.

When the shim is available, run it with the skill-specific subcommand:

```bash
red-skills-dev <subcommand> [--json]
```

When developing inside the red-skills source checkout, this repo-local path is
also valid:

```bash
node plugins/dev/skills/engineering/afk/bin/afk.mjs <subcommand> [--json]
```

## Output format

**TOON by default** (PRD #928 / ADR 0081) — the agent-facing wire format is
token-cheap by design: pre-computed aggregates, minimal schemas, and definitive
empty states. `--json` forces raw JSON (tooling escape hatch); `--human` prints
the prose report for a terminal read.
