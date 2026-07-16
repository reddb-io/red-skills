# Multi-Repo Sandbox Support

Sandcastle does not support managing multiple independent git repos (worktrees, branches, commit extraction) within a single sandbox session.

## Why this is out of scope

Multi-repo support requires a significant internal refactor. The single-repo assumption is deeply threaded through the system:

- `SandboxConfig` bakes one `hostRepoDir` into an Effect context tag at layer construction time
- `WorktreeManager`, `SandboxFactory`, `SandboxLifecycle`, and the `syncIn`/`syncOut` pipelines all assume a single repo identity
- Commit extraction (`baseHead` capture, `git rev-list`, merge-to-head) operates on one repo
- Git mounts, worktree cleanup, and error recovery all assume one repo

The design work has been done (see the agent brief on #386) and we're confident in the approach: refactor the factory to accept repo config as parameters, create a `createMultiRepoSandbox()` API, and loop over repos for setup/teardown. But the scope is substantial — it touches the factory, lifecycle, sync pipeline (all provider types), orchestrator, and result types.

This is a future-version feature, not a current priority. Users can work around this today using the `mounts` option on docker/podman providers to bind-mount additional repos into the sandbox (without worktree/branch/commit management for those secondary repos).

## Prior requests

- #386 — "Multi-repo support: one agent, one sandbox, N mounted repos"
