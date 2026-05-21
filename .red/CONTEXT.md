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
A local, opt-in pin of the agent to one branch in the **Primary checkout**, recorded as `./.red/tmp/branch-lock.yaml` (content: the branch name). While present, a Claude Code `PreToolUse(Bash)` hook blocks the agent — and only the agent — from switching away from that branch (see ADR 0006). Absence of the file means unlocked. Lives under gitignored `.red/tmp/` so each checkout/machine locks independently. Set/changed/cleared with `/branch-lock`. Distinct from the PRD/issue **branch pin** (a separate, autonomous-side concern read by `/afk`).
_Avoid_: branch pin (that is the PRD/issue declaration consumed by `/afk`, a different concern)

**Primary checkout**:
The developer's main working clone of the repo — where an interactive session runs and where a **Branch lock** file lives and is enforced. Contrasted with a **Worktree**.
_Avoid_: main repo, root checkout

**Worktree**:
An isolated `git worktree` that `/afk` creates per issue under `.red/tmp/work-*/`. Always **exempt** from a **Branch lock**, by toplevel location (not by branch name or an env flag), so the autonomous loop is never strangled by an interactive session's lock.
_Avoid_: afk clone, sandbox checkout

**Memory plugin**:
The second plugin in this marketplace (sibling to `dev` under `plugins/`), giving agents a persistent, queryable memory that survives `/clear` and crosses sessions. Hard-depends on `dev` and exists to improve dev's processes (`/afk` recall, `/triage` dedup, `/diagnose` history), never as a standalone. Configured per-project by `memory init`; surfaced as `/memory:store` and `/memory:recall`. See PRD #49.
_Avoid_: memory skill (it is a whole plugin, not one skill); `~/.claude/memory/` (that is the harness's global per-user note store, unrelated; the Memory plugin is per-project)

**Markdown-only mode**:
The lightest **Memory plugin** storage mode, selected at `memory init`: facts are plain markdown **Memory notes** under `.red/memory/notes/`, recall is full-text search over them, and **all hooks are off, the MCP server does not run, and RedDB is not required**. The low-risk path with zero engine dependency. Contrasted with the later `graph` and `hybrid` modes (RedDB-backed, typed graph).
_Avoid_: lite mode, no-engine mode

**Memory note**:
A single fact stored by `/memory:store` as one markdown file (`<timestamp>-<slug>.md`, YAML frontmatter + the fact as body) under the configured `notesDir`. In **Markdown-only mode** the note is the canonical store — human-readable and committable, not a rendered view of a graph.
_Avoid_: memory record, entry

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time
- An **Issue** accumulates many **Envelopes** (one per attempt) and many comments; comments split into **Directive blocks** (extracted as **Human guidance**) and **Thread discussion**

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it — resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager" — resolved: collapsed into **Issue tracker**.
