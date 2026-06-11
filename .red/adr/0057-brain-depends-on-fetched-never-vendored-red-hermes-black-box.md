# `red-hermes` is a fetched, never-vendored black-box dependency of the `brain` plugin

## Context

The `brain` plugin reaches external messaging channels (the "channel bridge")
through **`reddb-io/red-hermes`**, a separate product consumed as an internal
**black box**. The integration point is `apps/brain/src/channel-bridge.ts`
(`McpStdioChannelBridge`), which spawns the runtime as a stdio MCP server with
`command: "hermes"`, `args: ["mcp", "serve"]` and speaks only the MCP tool
protocol to it — never red-hermes' Python internals, models, or storage.

> **Disambiguation.** This `red-hermes` (the channel-bridge runtime) is **not**
> the AFK `hermes-fallback` runner mode documented in
> `plugins/dev/skills/engineering/afk/runner-hermes.md`. That is an AFK
> capability-dispatch mode for non-Claude/non-Codex inner agents. The two share
> only the word "hermes"; they are unrelated subsystems. This ADR concerns the
> brain channel-bridge runtime exclusively.

Three properties make the dependency a maintainer-owned architecture + licensing
gate (HITL #472):

1. **It is heavy and out-of-stack.** The red-hermes runtime is ~114 MB of Python
   (69 packages) — it is not, and must not become, a committed bundle in this
   TypeScript repo (contrast the dev runtime, ADR 0038, and the `red-memory` /
   `red-ui` MCPs, ADR 0041, all of which are minified JS bundles).
2. **It has a defined surface.** `channel-bridge.ts` pins a **10-tool contract**
   (`HERMES_CHANNEL_BRIDGE_TOOLS`) and asserts it at connect time
   (`assertHermesContract` throws if any tool is missing). That surface — not the
   runtime's internals — is what `brain` depends on.
3. **It is third-party-licensed.** `reddb-io/red-hermes` is MIT-licensed; this
   repo is Apache-2.0 (ADR 0004), so reuse must preserve the upstream MIT
   copyright in `NOTICE`, mirroring the existing `mattpocock/skills` attribution.

The HITL on #472 (2026-06-08) resolved the open questions: fetch as a GitHub
Release asset via a launcher (ADR 0038 pattern), version pinned per ADR 0040
coordination, never vendored.

## Decision

1. **`red-hermes` is a dependency of the `brain` plugin, not `memory`.** Its only
   consumer is `apps/brain/src/channel-bridge.ts`, and it is reached **only**
   via `hermes mcp serve` over stdio MCP. `brain` treats it as a black box: it
   calls the 10-tool surface and never the Python runtime directly.

2. **The runtime is fetched as a GitHub Release asset on demand, never vendored
   and never committed.** A launcher resolves the red-hermes runtime and caches
   it locally, mirroring the ADR 0038 bundle-fetch model
   (version-keyed cache → fail loudly when unresolved). The ~114 MB Python
   runtime never enters this repository's tree or git history — same posture the
   dev runtime (ADR 0038) and `red-memory`/`red-ui` (ADR 0041) take, applied to a
   Python rather than a JS payload.

3. **The pinned red-hermes release version is the coordination key** (ADR 0040).
   `brain` pins a specific red-hermes release; the launcher resolves the runtime
   by that version, so the contract, the cached asset, and the running CLI all
   agree on one id.

4. **The 10-tool `ChannelBridge` surface is the supported version/compatibility
   contract.** The supported surface is exactly:

   | tool | purpose |
   | --- | --- |
   | `conversations_list` | enumerate conversations |
   | `conversation_get` | fetch one conversation |
   | `messages_read` | read messages in a conversation |
   | `attachments_fetch` | fetch message attachments |
   | `events_poll` | poll for new channel events (cursor-based) |
   | `events_wait` | long-wait for the next channel event |
   | `messages_send` | send an outbound message to a target |
   | `channels_list` | list reachable channels/targets |
   | `permissions_list_open` | list open permission requests |
   | `permissions_respond` | respond to a permission request |

   `brain` adapts a narrower operational surface (`poll` → `events_poll`,
   `send` → `messages_send`, `channels` → `channels_list`) over this contract,
   but the **full 10-tool set is the compatibility floor**: `assertHermesContract`
   fails the connection if the pinned runtime does not expose all ten. A
   red-hermes release that drops, renames, or changes the semantics of any of
   these ten tools is a breaking change requiring a new pin and a contract review.

5. **MIT attribution is recorded in `NOTICE`.** A red-hermes MIT block is added to
   `NOTICE`, preserving the upstream copyright alongside the existing
   `mattpocock/skills` attribution (ADR 0004). Because the runtime is fetched and
   never vendored, no red-hermes source is redistributed from this repo; the
   attribution records the dependency and its license posture.

## Why

- **A multi-hundred-MB Python agent runtime does not belong in a TypeScript
  plugin repo's tree or history.** Fetch-on-demand keeps the repo small and
  reuses the exact distribution mechanism already proven for the dev runtime and
  the `red-memory`/`red-ui` MCPs — one fetch model across the ecosystem.
- **A black-box, contract-pinned dependency is testable without the heavy
  runtime.** The `ChannelBridge` adapter and its contract test run against a fake
  bridge, so the 10-tool contract is verified in CI without pulling 114 MB.
- **Licensing must be explicit.** Apache-2.0 + a third-party MIT dependency
  requires preserving the upstream copyright; `NOTICE` is the established home
  (ADR 0004).

## Consequences

- **The fetch/launcher is downstream work, blocked on red-hermes publishing
  fetchable releases** — the same prerequisite shape as `red-memory` (#378). Until
  then, `channel-bridge.ts` resolves `command: "hermes"` from the operator's
  environment (a pre-installed CLI on `PATH`), and the brain slices that need the
  real runtime (outbound send, scheduled ingestion) stay blocked. This ADR records
  the decision; it does not implement the launcher.
- **The brain ChannelBridge adapter + contract test do not depend on the real
  runtime** — they run against a fake bridge, so this gate does not block the
  adapter work.
- **Python on the client is assumed only where the real runtime runs** — the
  fetched red-hermes asset carries its own packaged runtime; `brain` shells out to
  `hermes mcp serve` and never imports Python.
- **Contract drift is a release event.** Bumping the red-hermes pin re-checks the
  10-tool surface at connect; a missing tool fails loudly rather than degrading
  silently.

## Status

Accepted (direction). The decision, license posture, and 10-tool contract are
fixed. The fetch/launcher implementation and the runtime-dependent brain slices
are downstream, blocked on red-hermes publishing fetchable releases.

## Related

- PRD #463 — brain as the agentic-OS command center; red-hermes as the
  brain-internal black-box channel connector.
- ADR 0038 — dev runtime ships as a fetched Release asset (the launcher/fetch
  model reused here for a Python payload).
- ADR 0040 — version is a single coordination key; CLIs/launchers are
  version-aware (the red-hermes pin).
- ADR 0041 — red-skills consumes `red-memory` + `red-ui` as fetched MCP bundles
  (the sibling consume-don't-build precedent).
- ADR 0004 — Apache-2.0 relicense with a `NOTICE` for upstream MIT (the
  attribution model extended here).
- `apps/brain/src/channel-bridge.ts` — the `McpStdioChannelBridge` and the
  `HERMES_CHANNEL_BRIDGE_TOOLS` contract.
