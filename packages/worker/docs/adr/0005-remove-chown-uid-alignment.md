# Remove runtime chown, align UIDs via namespace mapping and build-time convention

Both sandbox providers used `chown -R /home/agent` at container startup to fix ownership mismatches between bind-mounted files (host UID) and image-built files (UID 1000). This was slow, produced log spam from walking into bind mounts, and hit permission errors on read-only mounts (VirtioFS `.git/objects`, custom read-only mounts). We removed it entirely.

**Podman** now uses `--userns=keep-id:uid=N,gid=N` (Podman 4.1+), which maps the host user to a fixed UID inside the container at the namespace level. Both bind-mounted and image-built files appear owned by the same UID with no file mutation. The `containerUid`/`containerGid` options (default 1000) must match the Containerfile's agent user UID.

**Docker** drops the chown and keeps only `--user ${hostUid}:${hostGid}`. The generated Dockerfiles accept `AGENT_UID`/`AGENT_GID` build args, and `sandcastle docker build-image` passes the host UID/GID by default, so generated images and runtime containers agree on the agent identity. `docker()` pre-flights the image USER and reports a clear UID mismatch before starting a container. If a custom image intentionally uses a different agent UID/GID, callers can pass `containerUid`/`containerGid` to match it.

## Considered options

- **Targeted non-recursive chown** (chown specific dirs, skip bind mounts) — still requires knowing which paths are mounts vs image-local, still has startup cost, still produces warnings on read-only mounts.
- **Build-time UID injection** (pass host UID as build-arg, create agent user with that UID) — adopted for generated Dockerfiles and the `build-image` command. Existing custom images can either add the build args or pass explicit `containerUid`/`containerGid`.
- **fixuid / entrypoint script** (runtime `/etc/passwd` mutation + chown) — industry-standard approach (used by devcontainers, fixuid) but still chowns at startup. Solves the identity problem but not the performance/log-spam problem.
- **User namespace remapping** (Docker daemon-level `--userns-remap`) — not per-container, requires daemon config changes. Not practical.

## Consequences

- Requires Podman 4.1+ (for `--userns=keep-id:uid=N,gid=N` syntax).
- If a user's Containerfile creates the agent user at a UID other than 1000, they must pass `containerUid`/`containerGid` to `podman()` — otherwise ownership breaks silently.
- Docker users on Linux with a non-1000 host UID should rebuild generated images with `sandcastle docker build-image` so the image UID/GID follows the host. UID mismatches fail fast during sandbox creation instead of surfacing later as file permission errors.
