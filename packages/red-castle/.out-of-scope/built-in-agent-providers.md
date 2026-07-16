# Additional built-in agent providers

Sandcastle does not grow the set of **built-in** agent providers on request. The shipped list (Claude Code, Codex, Cursor, OpenCode, GitHub Copilot CLI, Pi) is deliberately curated.

## Why this is out of scope

Every built-in provider is a standing maintenance commitment: its CLI surface, JSON stream format, auth model, and session-capture behaviour all have to be tracked as that tool evolves, and each one is covered by tests in the repo. Expanding the built-in list to cover every agent CLI in the ecosystem grows that surface faster than it can be kept correct.

Adding a provider is also gated on the capability bar in [`docs/agents/adding-an-agent-provider.md`](../docs/agents/adding-an-agent-provider.md) — non-interactive run mode, prompt via stdin, a bypass-permissions flag, env-based auth, and (critically) line-delimited JSON stream events. A provider that can't satisfy those can't be driven unattended inside a sandbox or rendered live in the UI, regardless of how it's wired in.

Crucially, **a built-in provider is not required to use an agent with Sandcastle.** `AgentProvider` is a public, exported interface (`src/AgentProvider.ts`, re-exported from `src/index.ts`). Anyone who wants to run another agent can implement that interface in their own project and pass it as the `agent` — no change to Sandcastle is needed. The long tail of agent CLIs lives there, behind the public seam, rather than in the curated built-in set.

This applies equally to routing variants of an already-supported CLI. Pointing the `claude` binary at a different backend (Vertex, Bedrock, a gateway) is environment/config plumbing the user can supply through their own `AgentProvider` wrapper or env injection; it does not need a dedicated built-in factory.

## Prior requests

- #802 — "feat(agents): add minimax agent provider"
- #579 — "Add Gemini CLI agent"
- #635 — "feat: add claudeCodeVertex agent provider for Google Vertex AI"
