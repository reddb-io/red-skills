# Config File & Lifecycle Hooks

## Config File

A config file (format TBD — `.ralph.config.ts`, JSON, YAML) that lives in the target repo and controls CLI behavior.

### v1 config surface (minimal)

- **Prompt configuration** — default prompt with replaceable sections (e.g. swap out just the feedback loop part, or replace the whole thing)
- **Post-sync-in command** — a shell command to run after code is synced into the sandbox (e.g. `npm install`, `pip install -r requirements.txt`). Not everyone uses npm.
- **Docker settings** — image name, container name, tokens/env vars to pass through
- **Iteration settings** — max iterations, model to use

## Lifecycle Hooks (future)

User-defined commands that run at specific points in the container lifecycle. Deferred from v1 to keep scope tight, but the config architecture should be designed so hooks can be added later without breaking changes.

### Candidate hook points

- `onSetup` — after container is created
- `onSyncIn` — after code is synced into sandbox
- `beforeRun` — before each Claude iteration
- `afterRun` — after each Claude iteration
- `onSyncOut` — after code is synced back to host
- `onCleanup` — before container is torn down

### Open questions

- Do hooks run inside the sandbox (via `exec`), on the host, or both?
- Should hooks be shell commands, or TypeScript functions (if config is `.ts`)?
- Error handling: does a failing hook abort the operation, or just warn?
