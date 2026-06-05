# LLM conversation extraction routes through RedDB's AI provider, INFERRED-only

## Status

accepted.

PRD #66 needs entity / relationship / decision extraction from finished
sessions at a quality the deterministic regex/markdown paths cannot reach. The
reference design (red-memory) used a Python ML stack — spaCy + GLiNER + GLiREL.
Carrying that into the `memory` plugin would add a Python runtime, native model
downloads, and a second toolchain alongside the Node/RedDB one, and would send
nothing through the engine the plugin already embeds (issue #69, slice #69).

## Decision

Extraction is done by an **LLM, routed through RedDB's engine-side AI provider
modes**, selected from user config — not a bundled ML stack.

- **Provider modes.** `MemoryConfig.provider` selects one of four modes:
  `openai-compat` (a local Ollama or any OpenAI-compatible endpoint),
  `openai-native`, `anthropic-native`, or `bedrock` (an AWS-account-hosted
  model, endpoint derived from `region` as `bedrock-runtime.<region>` unless an
  explicit `baseUrl` is given). `resolveProvider` turns that config into a
  concrete endpoint and classifies egress: an `openai-compat` `baseUrl` on a
  loopback host is `local` (no external network egress); everything else,
  `bedrock` included, is `external`. The engine reads the resolved
  endpoint/model/key from environment (`applyProviderEnv`), the same way it
  reads the rest of its provider config.

- **A single mockable seam.** All model access goes through the `ProviderClient`
  interface (`complete(req) → string`). Production wires `redDbProviderClient`
  over the engine's `ASK`; tests inject a deterministic stub. The prompt builder,
  response parser, provider-mode selection, and graph materialization are all
  pure functions behind that seam, so the extraction contract is golden-file
  tested without a live engine or any network.

- **INFERRED-only.** Every node/edge the LLM path produces carries
  `confidence: "INFERRED"`. The deterministic tree-sitter/markdown paths
  (`extractCode`, `extractMarkdown`) are untouched and keep emitting `EXTRACTED`.
  Confidence is the durable signal that separates a parsed fact from an inferred
  one (ADR 0007's schema). ADR 0035 later extended this INFERRED path:
  extracted facts now carry a two-axis stamp — a closed structural `node_type`
  plus an open `engineering_code` — so an out-of-vocabulary inferred type is
  preserved rather than rejected or flattened.

- **Write-path-only.** Extraction fires only from the Stop hook and explicit
  `/memory:store` (the `memory extract` CLI verb) — never on recall/search. The
  zero-token recall guarantee depends on this; it is enforced structurally by a
  test asserting `engine.ts`/`recall.ts` never import the extractor.

## Consequences

- No Python, no model downloads, no second toolchain. A user who points
  `openai-compat` at a local model gets extraction with nothing leaving the
  machine; a user who configures a native provider trades that for hosted
  quality. Absent a provider, only the deterministic `EXTRACTED` paths run.
- The production `redDbProviderClient` needs a live engine with a provider
  configured; without one, `ASK` degrades and extraction yields no facts —
  best-effort, exactly like `engine.ask`. It is therefore not unit-tested; the
  deterministic stub behind the same interface is what the suite exercises.
- `@reddb-io/sdk@1.7.0` exposes `ASK` as its single LLM/SQL surface, so the
  plugin never imports an LLM SDK directly: the production client passes a
  two-turn (system + user) chat to the `ProviderBridge`, which routes it through
  `ASK`. A raw chat-completion entrypoint on the SDK would let the bridge drop
  that routing; the `ProviderClient` seam absorbs that change without touching
  extraction.
