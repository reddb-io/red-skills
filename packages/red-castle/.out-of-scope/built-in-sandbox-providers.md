# Additional built-in sandbox providers

Sandcastle does not grow the set of **built-in** sandbox providers on request. The shipped list (Docker, Podman, Vercel, Daytona, and the no-op `noSandbox`) is deliberately curated.

## Why this is out of scope

Same reasoning as the agent providers: every built-in sandbox is a standing maintenance commitment. Each one wraps a third-party provisioning surface (a CLI, an SDK, an SSH control plane) whose lifecycle, auth, file-copy, and exec semantics have to be tracked as that platform changes, and each is covered by tests in the repo. The space of "places you could run a container or microVM" is effectively unbounded; pulling every one in-tree grows the surface faster than it can be kept correct.

**A built-in provider is not required.** `SandboxProvider` is a public, exported interface — along with the `createIsolatedSandboxProvider` / `createBindMountSandboxProvider` helpers — re-exported from `src/index.ts` (see `src/SandboxProvider.ts`). Anyone who wants to run agents on another backend (Coder workspaces, exe.dev microVMs, Cloudflare, a bespoke fleet) can implement that interface in their own project and pass it as the `sandbox`. No change to Sandcastle is needed, and these integrations can version and release on their own cadence rather than being pinned to Sandcastle's.

The isolated-provider seam exists precisely so the long tail of execution backends lives outside the curated built-in set.

## Prior requests

- #495 — "Add coder() isolated sandbox provider"
- #644 — "feat(sandboxes): add exe.dev isolated sandbox provider"
