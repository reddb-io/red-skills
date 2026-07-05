# Report Runtime Wrapper

All RedSkills operational-report skills delegate to the dev runtime; they never
hand-calculate metrics.

## Run shim

Run the host-level RedSkills dev runtime shim with the skill-specific subcommand:

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
