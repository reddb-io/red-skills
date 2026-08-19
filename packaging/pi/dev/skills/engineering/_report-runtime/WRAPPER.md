# Report Runtime Wrapper

All RedSkills operational-report skills delegate to the dev runtime; they never
hand-calculate metrics.

## Canonical invocation: npx direct-run

**The npm direct-run form is the canonical invocation** (ADR 0091) — it works
on EVERY installation, because npm is the one transport every host already has.
A bare `red-skills-dev` only exists where an installer created the shim, so a
skill that leads with the bare form breaks on exactly the hosts that need it
most. Always write and run:

```bash
npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev <subcommand> [args]
```

Resolve `<version>` from the installed plugin (the statusline `vX.Y.Z`, or the
plugin's `plugin.json`); use the `latest` dist-tag only when no pin is known.

A host MAY use an installed `red-skills-dev` shim on `PATH` as a warm-cache
optimization when `command -v red-skills-dev` succeeds — same engine, same
arguments, faster start. The shim is never required, and its absence is not an
error: fall through to the npx form silently instead of surfacing a
command-not-found.

The valid dev CLI subcommands for these skills are explicit: `run`, `fleet`,
`monitor`, `dashboard`, `daily-review`, `weekly-review`, `retake`, and
`requeue`. There is no `afk` subcommand on the dev CLI; `/afk` maps to the
`run` subcommand or to the bare run flags documented by the AFK skill.

The skill-specific subcommand always rides the canonical form:

```bash
npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev <subcommand> [--json]
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
