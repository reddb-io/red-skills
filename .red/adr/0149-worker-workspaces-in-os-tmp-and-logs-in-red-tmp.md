# 0149 — Worker workspaces live in OS temporary storage; logs and evidence in `~/.red/tmp/workers/<id>`

- **Status**: accepted
- **Date**: 2026-08-18
- **Related**: ADR 0098 (`.red/tmp` lane taxonomy — amended), ADR 0103/0105 (flat worker workspaces — amended), ADR 0130 Amendment 2 (`~/.red/redskilled/` daemon home), ADR 0144 §1 (daemon-managed workspaces), the Worker reclaim rule (glossary)
- **Sources**: the `/start` grilling session of 2026-08-18

## Context

Workers materialised under the client checkout's `.red/tmp/workers/<id>/`
beside human worktrees. On one developer machine that lane held 3.1 GB, 1593
worker directories and 67 worktrees. The janitor (`apps/dev`) needed three guards
against deleting the wrong thing (#2679, #3650) because it shared a directory
with live work it did not own, and it still occasionally removed the wrong
worktree. Worker ids were `h` + four random characters — unordered, so age was
never readable from a name.

## Decision

1. **A Worker's workspace is created by the daemon under the OS temporary
   directory** — `os.tmpdir()/red-skills-<uid>/workers/<id>/` (Windows: `%TEMP%`
   equivalent) — from the daemon-owned Project workspace's base commit. It is
   expensive and regenerable; the operating system may reclaim it, and the daemon
   deletes it on Worker death.
2. **Logs and evidence go to `~/.red/tmp/workers/<id>/`**: `worker.log.toonl`,
   the runner's session artifact, the verdict. Cheap, irreplaceable, and what a
   human reads after a reboot; the daemon prunes the lane by a host-configurable
   TTL (default 30 days). `~/.red/redskilled/` remains the durable home for the
   daemon's own log, registrations, credentials and incidents.
3. **Worker ids are fixed-width base62 of the birth epoch in milliseconds**
   (7 characters, zero-padded, collision resolved by +1 ms): compact, no special
   characters, lexicographically ordered — so a prune is a prefix scan and a
   directory name is its own birth time.
4. **The client checkout's `.red/tmp` shrinks to human lanes** — `worktrees/manual`
   for interactive work and `scratch` — and **the janitor is deleted**. Nothing
   auto-deletes inside a client checkout; the daemon deletes only what it births.

## Considered options

- `~/.red/redskilled/workers/<id>` for the workspace. Rejected: the point of the
  move is that cleanup costs no conscience; the daemon home is where things are
  meant to survive.
- `$XDG_RUNTIME_DIR` (already used for sockets). Rejected: wiped at logout while
  Workers may outlive a session.
- Keep the janitor for the remaining client lanes. Rejected: with no Worker in
  the directory there is nothing it needs to fear, and a fearless cleaner does
  not justify two modules and two test files.

## Consequences

- ADR 0098's `tmp/{workers,go-workers,scout-workers,supervisors,claims,waits}`
  lanes retire; ADR 0103/0105's flat worker layout survives only in its shape,
  relocated. Claims and waits become daemon state.
- Evidence retention keeps the Worker reclaim rule's `evidence` tier honest:
  a tmpdir sweep never destroys the bytes that rescue orphaned work.
