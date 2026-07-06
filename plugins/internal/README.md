# RedSkills Internal

Maintainer-only plugin for skills that operate the `red-skills` repository
itself. It is distributed through the normal RedSkills marketplace so maintainers
can install it on other maintenance machines, but it stays inert unless a repo
opts in with:

```yaml
plugins:
  internal:
    enabled: true
```

Per ADR 0067, installed plugins do not imply activation. This plugin must not
create or edit `.red/`; `/setup-red-skills` remains the only RedSkills bootstrap
path that creates project configuration.

The initial `bootstrap` skill is intentionally a no-op placeholder so the
marketplace install path is demoable end-to-end before real maintainer skills
accumulate here.
