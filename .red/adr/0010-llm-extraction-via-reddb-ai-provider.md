# LLM conversation extraction routes through RedDB's AI provider, INFERRED-only

PRD #66 needs entity / relationship / decision extraction from finished
sessions at a quality the deterministic regex/markdown paths cannot reach. The
reference design (red-memory) used a Python ML stack — spaCy + GLiNER + GLiREL.
Carrying that into the `memory` plugin would add a Python runtime, native model
downloads, and a second toolchain alongside the Node/RedDB one, and would send
nothing through the engine the plugin already embeds (issue #69, slice #69).

## Decision

Extraction is done by an **LLM, routed through RedDB's engine-side AI provider
modes**, selected from user config — not a bundled ML stack.

- **Provider modes.** `MemoryConfig.provider` selects one of `openai-compat`
  (a local Ollama or any OpenAI-compatible endpoint), `openai-native`, or
  `anthropic-native`. `resolveProvider` turns that config into a concrete
  endpoint and classifies egress: an `openai-compat` `baseUrl` on a loopback
  host is `local` (no external network egress); everything else is `external`.
  The engine reads the resolved endpoint/model/key from environment
  (`applyProviderEnv`), the same way it reads the rest of its provider config.

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
  one (ADR 0007's schema).

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
- `@reddb-io/sdk@1.2.5` exposes only `ASK` as an LLM entrypoint, so the
  production client folds the system+user turns into one `ASK` prompt. A raw
  chat-completion entrypoint on the SDK would let the client drop that fold; the
  `ProviderClient` seam absorbs that change without touching extraction.
