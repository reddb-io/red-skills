# RedSkills Brain

RedSkills Brain is a project-local knowledge repository. It creates `.red/brain/*`
for the workspace, treats RedDB as the source of truth, and stores typed
artifacts plus graph connections for later search and synthesis.

The default connection string is:

```yaml
connection_string: file://./.red/brain/brain.rdb
```

The value may reference a variable from the process environment or the workspace
root `.env` file:

```yaml
connection_string: $RED_BRAIN_CONNECTION_STRING
```

Brain is separate from the Memory plugin. Memory exists to make agents work
better; Brain exists to hold knowledge the user wants to dump, connect, search,
and synthesize.

Core skills: [capture](./skills/core/capture/SKILL.md),
[search](./skills/core/search/SKILL.md), [think](./skills/core/think/SKILL.md),
[status](./skills/core/status/SKILL.md), and
[view](./skills/core/view/SKILL.md). `view` opens `brain.rdb` in red-ui for
graph/connection exploration.
