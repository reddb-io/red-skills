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

## Relationships

- An **Issue tracker** holds many **Issues**
- An **Issue** carries one **Triage role** at a time
- An **Issue** accumulates many **Envelopes** (one per attempt) and many comments; comments split into **Directive blocks** (extracted as **Human guidance**) and **Thread discussion**

## Flagged ambiguities

- "backlog" was previously used to mean both the *tool* hosting issues and the *body of work* inside it — resolved: the tool is the **Issue tracker**; "backlog" is no longer used as a domain term.
- "backlog backend" / "backlog manager" — resolved: collapsed into **Issue tracker**.
