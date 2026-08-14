# Context Map

RedSkills is a plugin marketplace with three product contexts that share one repo
and one issue tracker. Use this map to pick the right glossary before editing
domain language or writing ADRs.

## Contexts

- [Dev](./contexts/dev/CONTEXT.md) - engineering workflow plugin: issue
  triage, AFK execution, handoffs, branch safety, codebase explanation, and
  mutating operator workflows.
- [Memory](./contexts/memory/CONTEXT.md) - persistent project memory plugin:
  markdown notes, RedDB graph mode, reasoning attempts, validation evidence,
  skill telemetry evidence, and codebase mapping substrate.
- [Brain](./contexts/brain/CONTEXT.md) - project-local knowledge repository:
  freeform captures, project brain files, cross-note connections, and
  GBrain-style knowledge dumping for human-facing recall.

## Relationships

- **Dev -> Memory**: `dev` soft-uses `memory` through
  `plugins/dev/scripts/memory-bridge.sh`; absence or failure of `memory` must
  not change `dev` workflow outcomes.
- **Memory -> Dev**: `memory` hard-depends on `dev` for repo setup conventions,
  issue workflow vocabulary, and operator-facing workflows that consume memory
  evidence.
- **Brain -> Memory**: `brain` is a separate plugin and separate directory
  surface. Its mission is human-facing knowledge capture and connection rather
  than agent-performance memory, but Memory recall/context-pack may rank cited
  Brain hits in the same result and trust model without sharing a canonical
  store.
- **Brain -> Dev**: `brain` follows the same marketplace and repo setup
  conventions as other RedSkills plugins, but owns its `.red/brain/*` knowledge
  repository semantics.
- **AFK Envelope -> Reasoning attempt**: `dev` posts the issue-thread
  Envelope; `memory` may record the same terminal attempt as graph evidence.
- **AFK validation sidecar -> Validation node**: `dev` writes structured
  JSONL validation records; `memory` turns valid records into graph nodes and
  relationships.
- **Codebase understanding surface -> Memory graph**: `dev` owns the answer
  surface (`zoom-out`, future ask flows); `memory` owns graph storage, ingest,
  traversal, recall, export, and versioning.
- **Skill curator split**: `memory` owns telemetry evidence and report-only
  recommendations; `dev` owns the mutating archive workflow.

## Shared Decisions

ADRs remain in the root `.red/adr/` sequence unless a future context needs its
own local ADR subtree. Cross-plugin decisions should stay global and link back
to the relevant context files.

## Pending decomposition

Revisit the context boundaries before the next broad glossary pass. `Dev` now
mixes plugin product language with host control-plane, disposable workload,
GitHub gateway, and repository-internal concerns, while `Memory` and `Brain`
are separated primarily by product/plugin. Start the review with these
candidate owning contexts:

- `plugin-dev`
- `plugin-memory`
- `plugin-brain`
- `plugin-internal`
- `redskilled`
- `worker`

Add further contexts only where the concept and relationship inventory shows a
distinct authority and vocabulary. The review must decide whether plugin,
runtime, or authority boundaries are canonical before moving entries; do not
mechanically split the current files by package path.
