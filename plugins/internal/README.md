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

## Skills

- `bootstrap` confirms the internal plugin is installed and enabled for the
  current repository.
- `create-plugin` scaffolds new repository plugins with both host manifests, a
  seed skill, README, CHANGES stub, structural smoke script, and marketplace
  entries.

## Contract Changes

Change `create-plugin` before changing the plugin marketplace contract. New
plugins are born from that scaffold, so contract drift should appear first in
the generator and its acceptance test.
