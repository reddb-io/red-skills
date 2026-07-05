# Memory plugin preconditions

Shared reference for all memory skills. Edit here instead of patching each skill individually.

## Config requirements

All memory skills require a `plugins.memory` block in `.red/config.yaml`. Legacy projects may instead have `.red/memory/config.json`; when neither is present, memory was never initialized — the calling skill stops and recommends `/memory:init`.

Graph-mode skills additionally require `mode: "graph"` inside the `plugins.memory` block. The `extract` skill also requires a `provider` block inside that block.

## Bootstrap invocation

Every memory CLI call follows this form:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" <verb> [args]
```

## Init-chain state taxonomy

Every memory command checks the init chain before running. The states, in order:

| State | Meaning | Recommended action |
|---|---|---|
| `uninitialized` / `missing` | No `plugins.memory` block and no legacy config | Run `/memory:init` |
| `no-op` / `markdown-only` | Initialized, but `mode` is not `graph` | Run `memory init --mode graph` to enable graph features |
| `unavailable` | Graph mode exists but a required feature opt-in is off | Enable the specific flag (e.g. `--skill-telemetry`) |
| `enabled` / `ready` | Fully operational for this command | Proceed |
| `degraded` | Operational but a sub-component (graph mode, freshness, telemetry) is not ready | Check `recommendedNextActions` |
| `attention` | Operational with pending improvement work | Address pending proposals |
