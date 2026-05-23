# AFK records Reasoning attempts into Memory Graph best-effort

RedSkills already has two partially overlapping audit surfaces:

- AFK **Envelopes** on GitHub Issues, which are the canonical human-visible
  ledger of terminal worker attempts.
- Memory **Graph mode**, which can store reasoning-tier nodes, graph edges,
  recall context, traversal, export, and MCP tools.

Neo4j Agent Memory makes reasoning traces a first-class memory capability. To
reach capability parity without copying Neo4j's API or requiring an external
database, RedSkills needs a graph-backed attempt memory that is grounded in
AFK's existing structured execution data.

## Decision

AFK will record a **Reasoning attempt** into the Memory graph after it posts a
terminal Envelope. The write is best-effort through the existing Memory
bridge/CLI: if the Memory plugin is absent, not initialized, not in Graph mode,
or failing, AFK still posts the Envelope and completes its normal workflow.

The graph node gets its own `attempt` node type and defaults to the `reasoning`
Memory tier. It is not stored as a `why_note` or `task`: a `why_note` is a
rationale summary, while an `attempt` is the audit object for one execution.

The first data contract is AFK metadata plus operational evidence:

- issue, worker, attempt number, status, branch, duration
- diffstat, Envelope reference/hash, merge commit or failure branch
- touched files, notes, error class, validation summary
- a short human-readable why/outcome summary

When recording an attempt, AFK may also create or update minimal `issue` and
parent `prd` nodes so observed impact has a work-item anchor. The hierarchy is
`prd CONTAINS issue CONTAINS attempt`; if no parent PRD is explicitly declared
in the issue body, AFK records only the issue and attempt. The accepted explicit
declarations are `prd: #123` and `parent-prd: #123`, normalized internally to
`parent_prd`. The first slice does not infer a parent PRD from labels, title
text, comments, or branch names.

Touched files are represented both as a simple `touched_files` property and,
when graph writes are available, as `TOUCHED` edges from the attempt to `file`
nodes. AFK may create minimal `file` nodes for touched paths when they do not
exist, but it must not run `/memory:ingest` or reindex as part of recording an
attempt. Ingest can enrich those file nodes later.

Attempts from the same issue are linked in attempt-number order with
deterministic `PRECEDES` edges. Richer semantic links such as `LEARNED_FROM`,
links to symbols, decisions, problems/fixes, parent PRDs, or entity-resolution
output are later deepenings.

Command-level `validation` nodes are also deferred. The first attempt node keeps
only a `validation_summary` property. A later slice should feed `validation`
nodes from a small structured sidecar in the AFK work directory and connect them
to attempts with `TESTED_BY`, rather than parsing free-form stdout, Envelope
notes, or `<agent-notes>`.

## Why

- **AFK already owns the attempt boundary.** The orchestrator knows the issue,
  worker, status, branch, diff, notes, and retry history without transcript
  inference.
- **The Memory plugin remains optional.** This preserves the existing `dev`
  soft-uses-`memory` boundary: memory improves workflows but does not authorize
  AFK execution.
- **Reasoning memory becomes concrete.** The graph can answer "what happened
  last time this failed?", "which files repeatedly appear in blocked attempts?",
  and "what retry path led to the successful attempt?" without reading raw issue
  threads first.
- **The first slice avoids brittle inference.** `PRECEDES` and `TOUCHED` are
  deterministic; semantic `LEARNED_FROM` links can wait until extraction and
  entity resolution are stronger.
- **Issues and PRDs anchor engineering memory.** Attempts without first-class
  work-item nodes would be hard to connect back to intent, acceptance criteria,
  parent planning, and future impact analysis.
- **It advances Neo4j Agent Memory parity on RedSkills terms.** The capability
  class is the same — durable reasoning memory — but the storage stays embedded,
  project-local, and integrated with RedSkills workflows.

## Rejected alternatives

- **Store attempts only as Envelopes.** Rejected because GitHub comments are a
  ledger, not a traversable project memory. They do not connect naturally to
  file nodes, recall ranking, graph export, or future codebase understanding.
- **Infer attempts from Stop/PreCompact hooks.** Rejected for the first slice:
  hooks see transcripts, not AFK's structured terminal metadata, and would have
  to reconstruct attempt boundaries after the fact.
- **Make Memory Graph mode mandatory for AFK.** Rejected because observability
  and memory must not break autonomous work; `dev` must continue to operate
  when `memory` is absent.
- **Run ingest/reindex before recording the attempt.** Rejected because attempt
  recording should be cheap and bounded. Ingest remains an explicit Memory
  operation.
- **Use `why_note` as the node type.** Rejected because it would blur a short
  rationale summary with the full audit object for one execution.
- **Infer parent PRDs during attempt recording.** Rejected because a best-effort
  memory write should not create high-confidence work hierarchy edges from
  weak signals such as labels, title text, comments, or branch names.

## Consequences

- The Memory schema must add `attempt` to its node-type taxonomy and default it
  to the `reasoning` tier.
- The Memory write surface needs a small, scriptable way to upsert an attempt,
  create minimal issue/PRD/file nodes, add `CONTAINS` and `TOUCHED` edges, and
  link previous attempts with `PRECEDES`.
- AFK's Envelope path gains a best-effort Memory write after terminal posting,
  with failures logged or ignored in the same spirit as other optional memory
  integrations.
- Command-level validation memory is intentionally out of the first slice; the
  attempt stores only a summary until a structured sidecar contract exists.
- Recall and future codebase-understanding surfaces can use attempts as graph
  evidence, but must still treat them as operational history rather than
  authoritative product requirements.
