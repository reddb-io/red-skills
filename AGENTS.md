# RedSkills content repository

Owns skills, agent instructions, references and declarative host/marketplace manifests.
Software and every package publisher belong to `reddb-io/redskilled`.

- Read `.red/REPOSITORY-SPLIT.md` for ownership and release coordination.
- Read `.red/CONTEXT-MAP.md` for domain terminology; historical ADRs remain evidence.
- Use isolated worktrees under `.red/tmp/worktrees/manual/`; preserve the primary checkout.
- Validate content with the tools documented in `CONTRIBUTING.md` from Redskilled.
- Route runtime bugs and implementations to `reddb-io/redskilled`; content issues stay here.
- Update `plugins/dev/skills/engineering/ask-red/SKILL.md` when skill routes change.
- Keep manifests declarative: invoke installed commands with arguments. Implement
  their behavior, tests and validation tooling in Redskilled.
