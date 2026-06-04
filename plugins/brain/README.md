# RedSkills Brain

RedSkills Brain is a project-local knowledge repository. It creates `.red/brain/*`
for the workspace, treats RedDB as the source of truth, and stores typed
artifacts plus graph connections for later search and synthesis.

Brain root resolution prefers explicit overrides first, then walks up from the
current directory until it finds a real `.red/brain` directory or a
`.red/brain.root` marker. If neither exists, it falls back to the nearest
ancestor `.red/` directory for compatibility with existing repo-local behavior.

This lets an organisation folder hold an umbrella brain:

```text
~/work/reddb.io/.red/brain
~/work/reddb.io/api/.red
~/work/reddb.io/web/.red
```

Running `brain status`, `brain capture`, or `brain search` inside either child
repo targets `~/work/reddb.io/.red/brain`.

Set `RED_BRAIN_ROOT=/path/to/root` or add `plugins.brain.rootDir` to a
`.red/config.yaml` file to override walk-up resolution explicitly.

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
