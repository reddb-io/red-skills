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
A local, opt-in pin of the agent to one branch in the **Primary checkout**, recorded as `./.red/tmp/branch-lock.yaml` (content: the branch name). While present, a Claude Code `PreToolUse(Bash)` hook blocks the agent — and only the agent — from switching away from that branch (see ADR 0006). Absence of the file means unlocked. Lives under gitignored `.red/tmp/` so each checkout/machine locks independently. Set/changed/cleared with `/branch-lock`. Distinct from the **Pinned branch** (a separate, autonomous-side concern read by `/afk`).
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

**Zoom-out answer**:
The fixed answer shape for the `zoom-out` part of the **Codebase understanding surface**. It is map-first: start with the relevant modules/layers, then the main relationships, critical paths, and risks/gaps. It may include graph evidence when useful, but raw nodes/edges never lead the answer. Direct question answering belongs to the **Ask surface**.
_Avoid_: graph dump, architecture chat

**Ask surface**:
A candidate future `dev` plugin skill surface for natural-language questions over project knowledge, backed by the **Memory plugin** when available and falling back to ordinary codebase exploration when it is not. It is intentionally deferred until the graph-backed `zoom-out` flow proves useful. It is different from **Memory recall**: recall returns stored context; ask uses that context plus fresh repo reads to answer an engineering question. It is also different from **Wiki query**, which operates on `.red/wiki/` research notes.
_Avoid_: understand, codebase chat

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time
- An **Issue** accumulates many **Envelopes** (one per attempt) and many comments; comments split into **Directive blocks** (extracted as **Human guidance**) and **Thread discussion**
- **Skill telemetry** uses **Graph mode** for event relationships and **RedDB Statistics** for aggregate rollups, but only the **Memory plugin** knows those persistence details; `dev` remains a soft-using workflow plugin.
- `dev` and skill runtimes may emit **Skill telemetry** through a high-level Memory CLI event contract; the **Memory plugin** owns how that event becomes graph data or statistical rollups.
- **Skill telemetry** may observe every **Skill**, but curator mutations are limited to **Curatable skills**.
- **Skill telemetry** treats a **Skill** as `viewed` when its instructions are actually read or loaded into context, not merely listed during discovery.
- **Skill telemetry** uses runner-specific adapters for Claude Code and Codex that translate different hook/loading mechanics into one logical Memory event contract.
- **Skill telemetry** adapters are installed or enabled by `memory init` as an explicit per-project opt-in.
- When **Skill telemetry** is unavailable because the project is not in **Graph mode**, normal skill use is silent no-op, while telemetry/curator status commands explain the missing prerequisite.
- A **Skill curator** belongs to the **Memory plugin** for evidence and dry-run recommendations, but does not mutate skills itself.
- A **Skill curator** uses a two-level cadence: lightweight telemetry checks follow user-turn counts and only process new skill events, while report-only curator reviews follow interval/idle gates.

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it — resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager" — resolved: collapsed into **Issue tracker**.
