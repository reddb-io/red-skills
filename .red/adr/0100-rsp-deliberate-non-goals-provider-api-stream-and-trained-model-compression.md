# rsp deliberate non-goals: provider-API stream compression and trained-model compression

## Status

Accepted. Companion to ADR 0095, recording two Headroom-study non-goals for `rsp`.

## Context

The 2026-07-13 Headroom study identified two attractive but strategically wrong directions for `rsp`:

1. **Provider-API message stream and KV-cache compression**: Headroom's CacheAligner/live-zone territory aligns conversation prefixes, provider cache boundaries, and model-API message traffic.
2. **Trained-model compression**: Kompress-style systems use a learned model to decide what should be retained, summarized, or dropped.

Both directions chase context headroom, but they do it at a different boundary than `rsp`.

`rsp` lives at the shell boundary. It wraps deterministic development commands, consumes machine-readable contracts when available, emits agent-readable summaries, and stores every elided byte behind a reversible handle. It does not proxy the model provider, own the host CLI's conversation stream, or become an inference-time optimizer.

## Decision

`rsp` deliberately does **not** compress the provider-API message stream.

That means `rsp` does not intercept, rewrite, align, summarize, cache-prefix, or otherwise optimize the messages sent from an agent host to a model provider. Provider request streams belong to the host CLI and provider SDK. Cache alignment and live-zone management require owning that path, and owning that path would create a new high-risk security surface between the agent process, credentials, prompts, and provider traffic. `rsp` is not a model-API proxy.

`rsp` also deliberately does **not** adopt trained-model compression as its deciding mechanism.

That means `rsp` does not use a learned model to decide what bytes disappear from command output. The `rsp` contract is deterministic, homegrown, testable, and reversible: same command, same version, same output shape; every lossy elision mints a handle; fidelity assertions prove the elided view still answers the questions it claims to answer. A trained compressor conflicts with that ethos because its decisions depend on model weights, prompts, sampling/configuration, and version drift that cannot be audited like a fixture-backed wrapper.

Learned systems may still be prior art or evaluation baselines. They may not become the final cutter for `rsp` output. If a future tool proposes an elision, `rsp` would need deterministic gates to validate and reproduce the accepted result before any bytes are hidden from the agent.

## Consequences

- `rsp` remains a shell-boundary elision layer, not a provider-boundary compression layer.
- Provider credentials, prompts, model traffic, cache prefixing, and live context windows stay outside `rsp`'s runtime authority.
- Headroom-style provider-stream wins are not counted as `rsp` parity work. They belong to a separate future design only if RedSkills intentionally owns a model-API path.
- Kompress-style trained compression is not a route to `rsp` activation. `rsp` filters earn activation through deterministic measurement, fidelity assertions, and reversible handles.
- The non-goals section of `.red/tmp/researches/headroom-gaps.md` can point here instead of restating the decision.

## Revisit trigger

Revisit this ADR only if RedSkills deliberately owns a model-API path.

That would be a separate architecture decision: threat model, credential handling, provider compatibility, prompt/cache observability, opt-in surface, and failure semantics first. Until that exists, provider-stream compression and trained-model compression remain outside `rsp`.
