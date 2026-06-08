# `dev` soft-uses `memory`, one-directional

> **Status:** accepted; detection-gate mechanism **partially superseded by ADR 0042**.
> Split: the soft-use *direction* below still stands (`dev` may optionally consume
> Memory, and Memory still hard-requires `dev`), but the opt-in gate mechanism changed.
> Gate (1) is no longer `.red/memory/config.json` existing — it is a
> `plugins.memory` block in the unified `.red/config.yaml` (the legacy JSON path is
> still read as a back-compat fallback). See ADR 0042.

PRD #49 builds the `memory` plugin as a sibling of `dev` under `plugins/`, with
the product thesis that memory **lives on top of dev and improves its
processes** — `/afk` recalls prior attempts and known fixes, `/triage` dedupes
against known problems, `/diagnose` surfaces past root causes. Issue #57 wires
those three integrations.

The dependency must stay strictly one-directional. The `memory` plugin
**hard-requires** `dev` (it is meaningless standalone; its `plugin.json` declares
`"dependencies": ["dev"]`). But `dev` must **never** hard-depend on `memory` —
`dev` is the foundation and ships, installs, and runs with no knowledge that
`memory` exists. A repo that has installed only `dev` must see `/afk`,
`/triage`, and `/diagnose` behave exactly as before.

## Decision

`dev` *soft-uses* `memory` through a single shared bridge,
`plugins/dev/scripts/memory-bridge.sh`, sourced on demand by the three skills.
The contract:

- **Two detection gates, both required.** Memory is "available" for a repo only
  when (1) the project opted in — `.red/memory/config.json` exists under the repo
  root — **and** (2) a memory CLI resolves (via `$RED_MEMORY_CLI`, a `memory`
  bin on `PATH`, a sibling-plugin `dist/cli.js`, or an in-repo checkout via
  `$MEMORY_REPO_ROOT`). Either gate failing means "not available".
- **Silent no-op when unavailable.** `memory_recall` prints a ranked context
  block when memory is available and **always exits 0** — a missing,
  uninitialized, or erroring memory is an absent optimization, never a failure of
  the calling dev process. Sourcing the bridge changes nothing for a repo that
  never ran `/memory:init`.
- **`dev`'s `plugin.json` does not list `memory` as a dependency.** This is the
  one-directional guarantee, enforced by absence. Do not add it.
- **Recall, not write, in the hot path.** `/afk` (inner agent) and `/triage`
  only *read* memory. Writing back the root cause of a fix is `/diagnose`'s
  Phase 6 (`/memory:store`), also optional and gated the same way.

This follows ADR 0001's hard/soft split: the memory integrations are
soft-dependency prose plus a graceful bridge, never a setup pointer that blocks.
The bridge centralizes detection so the three skills share one tested
degradation path rather than re-deriving "is memory here?" each.

## Consequences

- The integration is best-effort: when the memory CLI cannot be located (e.g.
  an `/afk` inner agent in a consumer repo where `CLAUDE_PLUGIN_ROOT` is not
  propagated and the repo is not the red-skills monorepo), recall silently
  no-ops. We accept reduced sharpness over any risk of breaking the dev process.
- `memory-bridge.sh` is covered by `plugins/dev/scripts/tests/memory-bridge.test.sh`
  (resolution cascade, both gates, graceful degradation, query passthrough).
- Future `dev` skills that want memory follow the same source-and-gate snippet;
  they must not introduce a hard dependency.

## Related

- ADR 0042 — plugin config is unified under `.red/config.yaml`; this changes
  the Memory opt-in gate mechanism but not the one-directional soft-use
  direction.
