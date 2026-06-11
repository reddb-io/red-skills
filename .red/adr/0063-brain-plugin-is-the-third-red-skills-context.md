# The `brain` plugin is a first-class red-skills plugin and the third multi-context glossary context

## Status

accepted.

Relates: [ADR 0021](0021-multi-context-plugin-glossaries.md) (amended here to enumerate the `brain` context),
[ADR 0057](0057-brain-depends-on-fetched-never-vendored-red-hermes-black-box.md) (the Hermes connector),
[ADR 0038](0038-dev-runtime-ships-as-a-fetched-asset-not-a-committed-bundle.md) / [ADR 0040](0040-version-is-single-source-one-writer-version-aware-clis.md) (fetch + version model),
[ADR 0034](0034-monorepo-src-domains-with-per-plugin-bundles.md) / [ADR 0060](0060-root-apps-packages-with-pnpm-catalog.md) (the `apps/brain` runtime layout),
[ADR 0041](0041-red-skills-consumes-red-memory-and-red-ui-mcps.md) (the ecosystem-split precedent brain may follow later).

## Context

The `brain` plugin ships in production — its own `plugins/brain/` definition
(plugin manifests, `.mcp.json`, hooks, the `capture` / `search` / `status` /
`think` / `view` core skills, a `bootstrap.mjs` fetch launcher), an `apps/brain`
runtime, a `brain` MCP, and a `.red/contexts/brain/` glossary — but it carried
**zero decision-record coverage**, and ADR 0021 (multi-context glossaries)
enumerated only the `dev` and `memory` contexts while `contexts/brain/` already
existed. The map and the shipped plugin had drifted from the decision record.
Two calls were open: where `brain` lives long-term, and how 0021 is reconciled.

## Decision

1. **`brain` is a first-class red-skills plugin** alongside `dev` and `memory` —
   a project-local RedDB knowledge repository for freeform captures and graph
   connections (folder-level brains; the command-center direction is PRD #463).
   It follows the established plugin patterns: a fetched, never-committed bundle
   (ADR 0038), version-pinned to the plugin (ADR 0040), an `apps/brain` runtime
   under the root monorepo layout (ADR 0034/0060), and Hermes consumed as a
   fetched, never-vendored black-box connector (ADR 0057). It exposes the `brain`
   MCP and its `core/` skills, and owns its own glossary context.

2. **`brain` stays in red-skills for now.** Unlike `memory` — which moved out to
   the `red-memory` repo (ADR 0041) only after it had matured to ~55k lines —
   `brain` is still actively developed (draft reconstruction in #422, the
   command-center program in PRD #463). It is premature to split it out. The door
   stays open: `brain` may follow the ADR 0041 ecosystem split to a dedicated
   `red-brain` repo (built there, consumed via a fetched MCP) once it matures.
   That move, if taken, is a future ADR.

3. **ADR 0021 is amended in place** (not superseded) to enumerate the `brain`
   context. The multi-context-glossary *model* of 0021 still holds — it was only
   missing the third context.

## Why

- The plugin already exists and is consumed; the decision record must reflect
  reality so the ADR map and `CONTEXT-MAP.md` are trustworthy.
- Reusing the existing plugin patterns (fetch/version/runtime/Hermes) keeps
  `brain` consistent with `dev`/`memory` rather than inventing a parallel shape.
- Keeping `brain` in red-skills avoids a premature multi-repo migration while it
  is still a draft; the 0041 precedent makes a later split cheap if warranted.
- Amending 0021 (vs a successor) is the lighter change because the model did not
  change — only the context count.
