# RedSkills

A collection of agent skills (slash commands and behaviors) loaded by Claude Code. Skills are organized into buckets and consumed by per-repo configuration emitted by `/setup-red-skills`.

## Language

**Issue tracker**:
The repo's GitHub Issues. reddb.io policy: always GitHub, never local or another provider. The skills `to-issues`, `to-prd`, `triage`, and `qa` call `gh` directly.
_Avoid_: backlog manager, backlog backend, issue host, local-markdown tracker

**Issue**:
A single tracked unit of work inside an **Issue tracker** — a bug, task, PRD, or slice produced by `to-issues`.
_Avoid_: ticket (use only when quoting external systems that call them tickets)

**Triage role**:
A canonical state-machine label applied to an **Issue** during triage (e.g. `needs-triage`, `ready-for-afk`). Each role maps to a real label string in the **Issue tracker** via `.red/agents/triage-labels.md`.

**Directive block**:
A `<details data-kind="directive">...</details>` element written by a human inside an **Issue** body or a comment. Carries authoritative guidance for the inner agent — extracted by the `/afk` orchestrator into the `<human-guidance>` element of the handoff. Coexists with surrounding narrative prose in the same comment.
_Avoid_: instruction, directive comment (use only when distinguishing from a directive embedded in the body)

**Thread discussion**:
Comments on an **Issue** that contain no **Directive block** and are not orchestrator audits (boot stamps, promotion lines, heartbeats, envelopes). Surfaced to the inner agent under `<thread-discussion>` in the handoff as advisory context — never as authority. Lowest rung of the handoff precedence ladder.
_Avoid_: chatter, background comment

**Human guidance**:
The authoritative human-authored channel in a handoff: contents of `<human-guidance>`, populated only from **Directive blocks** extracted from comments. Overrides the brief on conflict; latest wins. Distinct from **Thread discussion** (advisory) and from edits the human pastes into the **Issue** body (carry equal authority but live inside `<issue-body>`).
_Avoid_: HITL comment (overloaded with broader HITL workflows)

**Envelope**:
Structured `<details data-attempt-status="...">` block the orchestrator posts on an **Issue** after each attempt (statuses: `done`, `blocked`, `no-sentinel`, `merge-conflict`). The canonical ledger entry for that attempt; consumed on retry as `<previous-attempt>` in the handoff.
_Avoid_: report, attempt log, audit comment

**Task mirror**:
A read-only reflection of `afk.state.json` onto the host harness's native background-task surface (the Claude Code status-bar task list via `TaskCreate`/`TaskUpdate`, or the Codex equivalent). Agent-driven, runner-specific, re-hydrated on session reopen from live worker dirs. A presentation consumer of worker state, never a source of truth — the same role the `monitor.sh` dashboard plays on a `tput` surface. See ADR 0003.
_Avoid_: native agent, subagent (the mirror is not an execution unit; AFK workers stay OS processes)

**Branch lock**:
A local, opt-in pin of the agent to one branch in the **Primary checkout**, recorded as `./.red/tmp/branch-lock.yaml` (content: the branch name). While present, runner-native pre-tool hooks (Claude Code `PreToolUse(Bash)`, Codex plugin `PreToolUse`) block the agent — and only the agent — from switching away from that branch (see ADR 0006). Absence of the file means unlocked. Lives under gitignored `.red/tmp/` so each checkout/machine locks independently. Set/changed/cleared with `/branch-lock`. Distinct from the **Pinned branch** (a separate, autonomous-side concern read by `/afk`).
_Avoid_: pinned branch (that is the PRD/issue declaration consumed by `/afk`, a different concern)

**Pinned branch**:
The branch a PRD or **Issue** declares — via a canonical `branch:` line in its body — that `/afk` must base its **Worktree** on and merge the finished work back into. Resolution is a small inheritance chain (see ADR 0008): the issue's own `branch:` line wins; else its parent PRD's; else `main` (today's default). Parsed by the pure `pin-reader` module; `/afk` fetches the parent PRD body only when the issue carries no line. Independent of the **Branch lock** (which constrains the interactive **Primary checkout**); a **Worktree** stays exempt from any lock regardless of the branch it is pinned to.
_Avoid_: branch lock (that is the interactive-side, opt-in agent block — a different concern); merge target (the pinned branch *is* the merge target, but the term names the declaration, not the git step)

**Primary checkout**:
The developer's main working clone of the repo — where an interactive session runs and where a **Branch lock** file lives and is enforced. Contrasted with a **Worktree**.
_Avoid_: main repo, root checkout

**Worktree**:
An isolated `git worktree` that `/afk` creates per issue under `.red/tmp/work-*/`. Always **exempt** from a **Branch lock**, by toplevel location (not by branch name or an env flag), so the autonomous loop is never strangled by an interactive session's lock.
_Avoid_: afk clone, sandbox checkout

**Fleet supervisor**:
The portable OS-process manager behind `/afk fleet`: `supervisor.sh` maintains a target number of independent `/afk` workers, records PID/stop/circuit/stall state under `.red/tmp/`, and delegates all issue claiming and merging to normal workers. It is runner-neutral bash process orchestration and does not require a native task surface, cron primitive, or Claude Code session. Observability surfaces such as the **Auto-monitor loop**, **Task mirror**, and `monitor.sh` read its state but do not define whether the supervisor can run.
_Avoid_: Claude fleet (fleet is not Claude-only), task mirror (presentation only), auto-monitor loop (observability only)

**Auto-monitor loop**:
An optional session-level observability loop that periodically renders `/afk monitor` and, where the runner supports it, mirrors live workers onto native task UI. Claude Code implements it with session cron tools; Codex may degrade to manual `monitor.sh`/log inspection until it has an equivalent primitive. Its absence must not block the **Fleet supervisor** from launching or stopping.
_Avoid_: fleet supervisor, fleet mode, worker scheduler

**Codex monitor agent**:
A Codex TUI sub-agent used only as a read-only presentation surface for AFK state. It may be spawned automatically when Codex launches a **Fleet supervisor**, periodically render `monitor.sh --once`, and auto-close when no supervisor or live workers remain; the user may also close it manually at any time. It is not an AFK worker and does not claim issues, edit files, run validation, or control merges.
_Avoid_: AFK worker, task mirror, supervisor slot

**Memory plugin**:
The second plugin in this marketplace (sibling to `dev` under `plugins/`), giving agents a persistent, queryable memory that survives `/clear` and crosses sessions. Hard-depends on `dev` and exists to improve dev's processes (`/afk` recall, `/triage` dedup, `/diagnose` history), never as a standalone. The dependency is **one-directional**: `dev` only *soft-uses* `memory` — those three skills query it through `plugins/dev/scripts/memory-bridge.sh` when it's installed and behave exactly as before when it isn't; `dev`'s `plugin.json` never lists `memory` (see ADR 0009). It is the only plugin that knows about RedDB persistence; `dev` talks to its high-level memory interface, never to RedDB directly. Configured per-project by `memory init`; surfaced as `/memory:store` and `/memory:recall`. See PRD #49.
_Avoid_: memory skill (it is a whole plugin, not one skill); `~/.claude/memory/` (that is the harness's global per-user note store, unrelated; the Memory plugin is per-project)

**Markdown-only mode**:
The lightest **Memory plugin** storage mode, selected at `memory init`: facts are plain markdown **Memory notes** under `.red/memory/notes/`, recall is full-text search over them, and **all hooks are off, the MCP server does not run, and RedDB is not required**. The low-risk path with zero engine dependency. Contrasted with **Graph mode** (RedDB-backed, typed graph) and the later `hybrid` mode.
_Avoid_: lite mode, no-engine mode

**Graph mode**:
The RedDB-backed **Memory plugin** storage mode, selected at `memory init`: facts become typed **Memory nodes** (and edges) in a per-project embedded RedDB store at `.red/memory/graph.rdb`, written through the `MemoryStore` facade. `/memory:store` upserts a deduped node; `/memory:recall` scans + expands the graph one hop and returns the head of any `SUPERSEDED_BY` chain. `reddb: true` in config, but the engine runs out-of-process from the SDK's bundled binary; hooks and MCP still off this slice. Writes use multi-model DML and KV-backed dedupe — see ADR 0007. Per-project store files (`graph.rdb*`) are local state, never committed.
_Avoid_: db mode, sql mode; confusing the `.rdb` store with a **Memory note** (graph mode does not write notes)

**Memory note**:
A single fact stored by `/memory:store` as one markdown file (`<timestamp>-<slug>.md`, YAML frontmatter + the fact as body) under the configured `notesDir`. In **Markdown-only mode** the note is the canonical store — human-readable and committable, not a rendered view of a graph. In **Graph mode** the equivalent unit is a graph node, not a note.
_Avoid_: memory record, entry

**Memory tier**:
A property on every **Memory node** — `ephemeral | durable | reasoning` — that resolves the tension between RedDB's auto-expiring TTL and the project's "no automatic deletion" guarantee. `ephemeral` nodes (default for `session` types) carry a TTL horizon (`expires_at`) and stop surfacing once it passes; `durable` (the default for stored facts/decisions) and `reasoning` (`why_note` traces) carry no TTL and persist indefinitely. Defaulted on write per `defaultTier(node_type)`, overridable per node. `memory:doctor` flags stale `durable` nodes but never auto-deletes and never touches `ephemeral` ones (TTL owns them). Expiry is enforced client-side at the `listNodes` choke point because the embedded engine does not sweep KV TTL promptly — see ADR 0010. Introduced by issue #68 under PRD #66.
_Avoid_: ttl class, expiry level, retention policy

**Reasoning memory**:
The first capability slice of **Neo4j Agent Memory parity**: durable graph records of agent reasoning evidence — task, tools used, files/entities touched, decision labels, outcomes, error classes, timestamps, and a short human-readable "why" summary — plus audit relationships that explain why an agent acted and make similar past work retrievable. It is a **Graph mode** concern, normally stored under the `reasoning` **Memory tier**, and is more central to RedSkills' engineering workflows than generic chat-session recall. It stores audit summaries, not raw chain-of-thought or full transcripts.
_Avoid_: chain-of-thought dump, transcript memory, short-term history

**Reasoning attempt**:
The primary graph unit for **Reasoning memory**: one concrete agent attempt against a task or issue, with tools, files/entities touched, decisions, outcomes, errors, and a short "why" summary attached as evidence. It deserves its own graph node type, `attempt`, instead of being stored as a `why_note` or `task`: `why_note` is a rationale summary, while `attempt` is the audit object for an execution. `attempt` defaults to the `reasoning` **Memory tier** so it persists without automatic expiry but ranks below durable project facts and decisions. Its first source of truth is the AFK **Envelope** plus the corresponding handoff material: AFK already provides the structured attempt boundary, status, issue, branch, notes, diff, and retry history. The primary writer is the AFK orchestrator immediately after it posts a terminal Envelope, because it has structured attempt metadata without transcript inference. The write is best-effort through the Memory bridge/CLI: if the Memory plugin is absent, not in **Graph mode**, or failing, AFK still posts the Envelope and completes its normal workflow. When recording an attempt, AFK may also create or update minimal `issue` and parent `prd` nodes so observed impact has a work-item anchor; a full GitHub Issue sync is a later deepening. In the first slice, parent PRD resolution only uses an explicit declaration in the issue body: `prd: #123` or `parent-prd: #123`, normalized internally to `parent_prd`; no label/title/comment/branch inference is used. The first data contract is AFK metadata plus operational evidence: issue, worker, attempt number, status, branch, duration, diffstat, envelope reference/hash, `touched_files`, notes, error class, validation summary, and merge commit or failure branch. File touch evidence is stored twice when possible: `touched_files` remains a simple property for inspection and recall snippets, while `TOUCHED` edges connect the `attempt` to `file` nodes. AFK may create minimal `file` nodes for touched paths when they do not already exist, but it must not run ingest or reindex as part of recording the attempt; `/memory:ingest` can enrich those nodes later. Attempts from the same issue are linked in attempt-number order with deterministic `PRECEDES` edges; richer `LEARNED_FROM` links require inference and are a later deepening. Semantic links to symbols, decisions, problems/fixes, and parent PRDs are also later deepenings, not required for the first slice. It is related to, but not identical with, an Envelope: an Envelope is the issue-thread ledger entry for an AFK terminal event, while a Reasoning attempt is the graph-backed memory object that can connect across issues, files, symbols, decisions, and future recall.
_Avoid_: transcript, raw attempt log, envelope clone

**RedDB Statistics**:
The RedDB analytical surface for aggregate counts, rankings, and rollups derived from project data without replacing the graph as the relationship substrate.
_Avoid_: stats (too vague outside code identifiers), metrics store

**Skill**:
An agent-loadable behavior package exposed by RedSkills or a local/personal marketplace, usually rooted at a `SKILL.md` plus optional supporting files.
_Avoid_: command (a skill may be triggered without a slash command), plugin (a plugin can contain many skills)

**Skill telemetry**:
Observed lifecycle and interaction events for a **Skill** — available only in **Graph mode**, stored as a runner-neutral canonical event set (`viewed`, `used`, `result`, `changed`, `state_changed`), and exposed as curator-friendly rollups such as use count, view count, patch count, last activity, success/failure, archive, and consolidation. Skill events carry enough identity for both Claude Code and Codex (`name`, `source_kind`, `path`, `runner`, session/turn identifiers, timestamp, event id); `result` stores only safe operational outcome such as `succeeded`, `failed`, `abandoned`, `blocked`, or `unknown`, plus optional duration or classified error.
_Avoid_: skill metrics (too numeric-only), usage counters (too narrow)

**Curatable skill**:
A **Skill** whose files may be modified, consolidated, or archived by a future curator because it is user-owned or agent-created rather than bundled as read-only plugin/hub content.
_Avoid_: stale skill (staleness is a state, not ownership), editable skill

**Skill curator**:
A Memory-backed reviewer of **Skill telemetry** that separates lightweight signal collection from heavier report-only review: every N user turns it may process new skill events into rollups, while recommendations about **Curatable skills** run explicitly or on an interval/idle gate; any skill mutation remains a separate workflow outside the **Memory plugin**.
_Avoid_: curator (too broad), memory cleaner

**Codebase understanding surface**:
A `dev` plugin workflow surface for explaining a repository's architecture, skill/module interdependencies, and change impact by reading from graph-backed project knowledge owned by the **Memory plugin**. The surface belongs in `dev` because it is an engineering workflow; the graph storage, traversal, recall, export, and community detection remain `memory` responsibilities. This prevents a second graph store from competing with **Graph mode** while still allowing higher-level repo-understanding skills to exist. The surface may use graph-mode verbs directly (`neighbors`, `path`, `stats`, export-derived reads) when available, but must degrade through `memory recall` or ordinary code exploration when the Memory plugin is absent or not in graph mode. It is read-only with respect to the graph: if indexing is missing or stale, it tells the user to run `/memory:ingest` instead of reindexing implicitly.
_Avoid_: wiki graph (too narrow), understand plugin (confuses the workflow surface with plugin ownership), `/understand` (too close to Understand Anything's naming)

**Codebase mapping parity**:
The RedSkills goal of covering the same practical codebase-understanding capability class as Graphify and Understand Anything: code/docs ingestion, project graph construction, path and impact queries, module/context maps, exportable graph artifacts, and assistant-facing explanations over that graph. It is evaluated separately from **Neo4j Agent Memory parity** because this axis is about understanding the current repository and its change impact, not generic agent memory.
_Avoid_: Understand clone, Graphify clone, dashboard parity

**Engineering semantic graph**:
The claim that RedSkills' graph should be better for engineering work because its schema directly represents the domain objects and relationships agents act on: issues, PRDs, attempts, envelopes, files, symbols, skills, ADRs, contexts, decisions, fixes, validations, and observed change history. `issue` and `prd` are central graph node types, not just string properties, because they connect work intent, requirements, attempts, decisions, files, and change history. Their canonical source is the GitHub **Issue tracker**; handoffs, Envelopes, and `.red/wiki` pages are projections or caches, not authority for the issue/PRD node itself. The work hierarchy is `prd CONTAINS issue CONTAINS attempt`; attempts from the same issue still use `PRECEDES` to encode retry order. After work items and attempts, `validation` is the next key semantic node type because observed impact needs to know which tests, lint, typecheck, build, or other checks passed or failed when specific files were touched. A `validation` node represents one command/check execution, such as `pnpm test` or `pnpm typecheck`, with status, duration, and relevant error/output summary. Attempts connect to validation nodes with `TESTED_BY`; `validation_summary` remains a simple attempt property for quick inspection. Validation nodes are a second slice after basic Reasoning attempts, and should be fed by a small structured sidecar in the AFK work directory rather than free-form stdout, Envelope notes, or `<agent-notes>` parsing. This is a product/schema superiority claim for codebase and agent workflows, not a generic claim that RedDB is a universally better graph engine than Neo4j.
_Avoid_: better graph (too vague), Neo4j killer, graph database superiority

**Neo4j Agent Memory parity**:
The Memory plugin goal of covering the same capability classes as Neo4j Agent Memory — short-term memory, long-term memory, reasoning memory, extraction, deduplication, consolidation, auditability, retrieval, and tool/MCP surfaces — using RedSkills APIs, RedDB storage, and project-local **Graph mode** semantics rather than copying Neo4j's API contracts, Cypher-centric interface, or external database runtime.
_Avoid_: Neo4j clone, API parity, Cypher parity

**Zoom-out answer**:
The fixed answer shape for the `zoom-out` part of the **Codebase understanding surface**. It is map-first: start with the relevant modules/layers, then the main relationships, critical paths, and risks/gaps. It may include graph evidence when useful, but raw nodes/edges never lead the answer. Direct question answering belongs to the **Ask surface**.
_Avoid_: graph dump, architecture chat

**Impact-aware zoom-out**:
The first **Codebase mapping parity** deepening for `zoom-out`: when the user's focus is a file, symbol, module, skill, or concept, `zoom-out` should use graph neighbors, paths, recall, export/list-edge evidence, and current file verification to explain likely change impact, affected modules, critical dependencies, repeated attempt history, and risks. It distinguishes **structural impact** (imports, calls, contains, uses-type, docs links, and other code/document graph edges) from **observed impact** (Reasoning attempts, files touched together, repeated failures, retries, and validations). It extends the existing **Zoom-out answer** contract instead of creating a separate `impact` skill in the first slice; when impact is relevant, the answer gains an explicit **Impact** section between Relationships and Critical Paths. A dedicated `memory_impact` primitive may come later, after the composed heuristics prove useful.
_Avoid_: impact skill, PR dashboard, graph-only impact

**Public codebase map**:
A committed JSON cache that materializes the repository-structure projection of the **VCS-versioned memory graph** at the current `HEAD` git commit — files, symbols, imports, architectural layers, ADR references, and any other public-safe node types. Not a separately-generated artifact: it is the output of `SELECT … AS OF COMMIT 'HEAD'` over the relevant `VERSIONED = true` collections, rendered to JSON for teammates and external readers who do not have a RedDB instance. The live memory store remains the source of truth; the JSON is a presentation cache, regenerated by a single dump verb, never edited by hand. Excludes content tagged as private or `ephemeral` **Memory tier**. The **Codebase understanding surface** reads the live graph directly when RedDB is available and falls back to the JSON cache otherwise. Bridges **Codebase mapping parity** (shareable public artifact UA also ships) with the **Engineering semantic graph** moat (queryable history UA cannot ship) by collapsing both into one substrate.
_Avoid_: memory export (that is the local self-contained bundle from `/memory:export`, not the committed projection); knowledge graph (too generic and collides with Understand Anything's `knowledge-graph.json` naming); regenerator pipeline (there is no second pipeline — the cache is a dump of the live graph)

**VCS-versioned memory graph**:
The slice of the **Graph mode** memory store whose collections carry `VERSIONED = true` in RedDB so every mutation participates in RedDB's git-for-data layer — commits, branches, tags, deterministic SHA-256 hashes, `SELECT … AS OF COMMIT|BRANCH|TAG|TIMESTAMP|SNAPSHOT` time-travel, and LCA via the height index. Versioning is aligned to the existing **Memory tier**: `durable` and `reasoning` nodes (facts, decisions, **Reasoning attempts**, validations, files, symbols) live in versioned collections; `ephemeral` nodes do not, matching RedDB's own guidance to keep churning data out of VCS so VACUUM can reclaim it. Powers `AS OF <git-sha>` queries from the **Codebase understanding surface**, gives every **Reasoning attempt** a reproducible "what did we know then" anchor, and is the substrate the **Public codebase map** dumps from. It is a RedDB capability the **Memory plugin** opts into per collection, not a new persistence engine.
_Avoid_: versioned memory (too vague); time-travel memory (describes one use, not the substrate)

**Ask surface**:
A candidate future `dev` plugin skill surface for natural-language questions over project knowledge, backed by the **Memory plugin** when available and falling back to ordinary codebase exploration when it is not. It is intentionally deferred until the graph-backed `zoom-out` flow proves useful. It is different from **Memory recall**: recall returns stored context; ask uses that context plus fresh repo reads to answer an engineering question. It is also different from **Wiki query**, which operates on `.red/wiki/` research notes.
_Avoid_: understand, codebase chat

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time
- An **Issue** accumulates many **Envelopes** (one per attempt) and many comments; comments split into **Directive blocks** (extracted as **Human guidance**) and **Thread discussion**
- A **Fleet supervisor** maintains independent AFK workers; **Auto-monitor loop**, **Task mirror**, **Codex monitor agent**, and `monitor.sh` are read-only observability consumers of worker/supervisor state.
- **Skill telemetry** uses **Graph mode** for event relationships and **RedDB Statistics** for aggregate rollups, but only the **Memory plugin** knows those persistence details; `dev` remains a soft-using workflow plugin.
- `dev` and skill runtimes may emit **Skill telemetry** through a high-level Memory CLI event contract; the **Memory plugin** owns how that event becomes graph data or statistical rollups.
- **Skill telemetry** may observe every **Skill**, but curator mutations are limited to **Curatable skills**.
- **Skill telemetry** treats a **Skill** as `viewed` when its instructions are actually read or loaded into context, not merely listed during discovery.
- **Skill telemetry** uses runner-specific adapters for Claude Code and Codex that translate different hook/loading mechanics into one logical Memory event contract.
- **Skill telemetry** adapters are installed or enabled by `memory init` as an explicit per-project opt-in.
- When **Skill telemetry** is unavailable because the project is not in **Graph mode**, normal skill use is silent no-op, while telemetry/curator status commands explain the missing prerequisite.
- A **Skill curator** belongs to the **Memory plugin** for evidence and dry-run recommendations, but does not mutate skills itself.
- A **Skill curator** uses a two-level cadence: lightweight telemetry checks follow user-turn counts and only process new skill events, while report-only curator reviews follow interval/idle gates.
- The **report-only Skill curator** lives in the **Memory plugin**; the *mutating* curator lives in `dev` (the `/curate` skill), consumes Memory's report (`memory curate skills --json`), and is **archive-only (never delete)** on **Curatable skills** with explicit consent — interactive when invoked, or detect-then-`ready-for-human`-**Issue** in the background, never silent (ADR 0016).

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it — resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager" — resolved: collapsed into **Issue tracker**.
