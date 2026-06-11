---
name: review-adrs
description: Review the `.red/adr/` set for contradictions, missing supersession links, staleness (paths/commands that moved), numbering collisions, and structurally controversial decisions, reconcile each finding with the maintainer through a one-question-at-a-time interview (like `/start`) — reaching agreement before any write — then consolidate every agreement into a single actionable PRD on the issue tracker via `/to-prd`. Use when asked to "review the ADRs", "are any ADRs conflicting / out of date / superseded", after adding or reversing an ADR, or to make a large ADR set navigable and turn its decision debt into scheduled work.
---

# Review ADRs (decision-record interview → actionable PRD)

ADRs accumulate (30–40+ per repo) and **derive**: one reverses another, a path it
cites moves, a decision was taken controversially and never reconciled, the wiki and
Memory graph hold claims sourced from a decision that later changed. This is the
"doctor of decisions" — sibling to `/doctor` (adoption) and `memory:doctor` (graph).
Detection is read-only; **every resolution is reached through an interview** — one
question per turn, `/start`-style — and the agreement is captured, not applied. The
skill never edits an ADR, the wiki, or the graph: it consolidates every agreed fix
into **one PRD** on the tracker, which `/to-issues` + `/afk` execute afterwards.

<what-to-do>

**First detect read-only (Pass 1). Then run the Reconcile interview (Pass 2): walk the findings as a decision tree, ask ONE question per turn with a recommended resolution, wait for the reply, and record the agreed action. Grouping (Pass 3) and propagation (Pass 4) are further branches of that same interview. Then emit ONE PRD via `/to-prd` (Pass 5) holding every agreed action. The only artefact this skill writes is the PRD.**

### Hard rules

- ❌ Do **not** edit ADR bodies, renumber files, write the INDEX, supersede a Memory node, or re-ingest a wiki page directly. This skill ends in a **PRD on the tracker**, not in applied edits. Every agreed fix becomes a PRD work item, executed later by `/to-issues` + `/afk` or a human.
- ❌ Do **not** auto-resolve a finding or controversial decision. Surface it in the interview; the maintainer's answer is what gets recorded as the agreed action.
- ❌ Do **not** stack questions. **One `Q##` per turn.** Wait for the reply, re-evaluate the tree, then ask the next. Do not preempt the next question, and do not summarise the user's answers back at them.
- ✅ Before Pass 1, run `git fetch origin`, resolve `origin/HEAD` to the remote default branch, and lint from that Git ref (`origin/<default-branch>`). Read ADR/context files with Git plumbing such as `git ls-tree` / `git show`; do **not** inspect `.red/adr/` from the working tree. Use local `HEAD` only when no `origin` remote/ref exists, and state that fallback in the report.
- ✅ Compose existing surfaces to detect: `/wiki lint` for wiki claims, Memory supersession/contradiction reads for graph claims. Do not reimplement them.
- ✅ Compose `/to-prd` to publish — do not hand-roll the PRD format. Every interview agreement is a **Human Decision** in that PRD (load-bearing judgement the agent could not infer).
- ✅ Honour ADR conventions in `start/ADR-FORMAT.md` (Status frontmatter, "superseded by ADR-NNNN", Related links).

### Pass 1 — Lint (detect, read-only)

Fetch first: `git fetch origin`. Resolve `origin/HEAD` to the remote default branch, set the lint ref to `origin/<default-branch>`, and read every `.red/adr/*.md` (and `.red/CONTEXT-MAP.md` / contexts if present) from that ref. Use `git ls-tree -r --name-only "$lint_ref" -- .red/adr .red/CONTEXT-MAP.md .red/contexts` to discover files and `git show "$lint_ref:$path"` to read them; path-existence checks for stale references must also query the same ref. Lint **against the fetched committed tree**, not a dirty or stale local working copy, so a lagging checkout is never mistaken for a real finding. If there is no `origin` remote/ref, fall back to local `HEAD` and say so before reporting findings. Report:

- **Contradictions** — two ADRs whose decisions oppose on the same topic (e.g. "memory lives in `src/apps`" vs "memory moves to `red-memory`"). Flag pairs that should cross-reference but don't.
- **Missing supersession** — a later ADR reverses/supersedes an earlier one, but the earlier still reads `Status: accepted` with no "superseded by ADR-NNNN" / Related note.
- **Stale references** — an ADR cites a path / file / command that no longer exists (grep the body for paths, check existence; e.g. an ADR naming `src/domains/` or `src/apps/` after the tree became `apps/`). Flag the prose, not the decision.
- **Numbering** — duplicate or gap-colliding ADR numbers (two files claiming the same NNNN, e.g. when parallel branches both grab the next number).
- **Structural / controversial decisions** — a decision that is internally incoherent, was taken under unresolved disagreement, or was never actually implemented. These are the ones that **don't** get fixed by editing markdown — they need real work, and they are the spine of the PRD.

This finding list **is the decision tree** the interview walks. Present it once, briefly, ordered by impact — then enter Pass 2.

### Pass 2 — Reconcile (the interview — `/start`-style, the core of this skill)

Walk the Pass-1 findings as a decision tree. **The loop:**

1. **Pick the next unresolved finding**, highest-impact first: numbering collisions (they break references) → contradictions → missing supersession → stale references → structural/controversial decisions.
2. **Ask ONE question** in the format below — branches for the finite resolution space, plus a recommended branch with a one-sentence reason.
3. **Wait** for the reply. Do not stack, do not preempt.
4. **Re-evaluate** when the answer cascades (e.g. renumbering an ADR also changes the INDEX entry and every cross-ref to it) — fold the cascade into the tree before the next question.
5. **Record the agreed action** in the ledger (the agreement *is* the spec for a PRD item — do not apply it), then continue.
6. **Stop** when the user says stop, or when every finding is resolved.

**Question format template (identical discipline to `/start`):**

> **Q##:** [the decision to reconcile]
> **Branches:**
>  (a) [resolution A — e.g. "renumber the locally-authored ADR to the next free number, fix its inbound refs"]
>  (b) [resolution B — e.g. "renumber the other one"]
>  (c) [defer — leave the finding open, no PRD item]
> **Recommend:** (a), because [one-sentence reason].
> *(answer, redirect, or push back — I'll wait)*

Number questions `Q01`, `Q02`, … zero-padded to 2 digits, session-scoped (reset each invocation, never on a redirect). Prefer enumerated branches whenever the resolution space is finite; `(c) defer` is almost always a legitimate branch — a finding the maintainer wants to think about is simply left out of the PRD.

### Pass 3 — Group → INDEX (one agreement within the interview)

When the lint findings are reconciled (or the user wants the map first, to reason about them), raise a question on whether to (re)generate **`.red/adr/INDEX.md`** — the decision map (the ADR analogue of `CONTEXT-MAP.md`): ADRs clustered by theme (AFK lifecycle · memory architecture · bundle/fetch/version · branch-lock · MCP/transport · licensing · repo structure · …), each entry showing theme, status, and supersession edges, reflecting the numbering/supersession just agreed. May reuse Memory graph-community clustering when graph mode is available. The agreed clustering becomes a **PRD item** ("create/refresh `.red/adr/INDEX.md` as …"), not an inline write.

### Pass 4 — Propagate to Wiki + Memory (further interview branches)

A changed/superseded ADR leaves derived claims dangling. For each ADR touched in Pass 2/3, raise it as its own question:

- **Wiki** — `/wiki lint` (contradictions / orphans / stale claims); find pages whose `REFERENCES` point at the changed ADR. Ask whether to re-ingest that ADR — if yes, it becomes a PRD item.
- **Memory** — ADRs are first-class graph nodes (engineering semantic graph). Find nodes whose provenance cites the changed ADR. Ask whether to `memory_supersede` the obsolete claims (reversible hide-not-delete) — if yes, it becomes a PRD item.

One question per target, one agreed action per item. Never silently propagate.

### Pass 5 — Emit the PRD

Hand the accumulated agreed actions to `/to-prd`:

- **Problem Statement / Solution** — the decision debt found and the reconciliation plan.
- **User Stories** — one per agreed action, phrased as the concrete edit/work: "rewrite ADR-0034 Status to `superseded by 0041` and add the Related link", "renumber the locally-authored ADR and fix its inbound refs", "create `.red/adr/INDEX.md` clustering the set", "re-ingest ADR-0041 into the wiki", "implement the reconciliation of the controversial X decision".
- **Human Decisions** — every interview answer (`Q##` → agreed branch), in `/to-prd`'s Decision/Why/Alternatives shape. These are load-bearing: once `/to-issues` slices the PRD they must not be mistaken for agent inference.

Publish with `type:prd` + `needs-slicing` (never `ready-for-agent` — `/to-prd` handles the labels). Then in chat: a short receipt of each `Q##` and the action it produced, the link to the published PRD, what was **deferred** (left out), and the single highest-impact finding to reconcile first.

</what-to-do>

<supporting-info>

### Why this is an interview, not a flat list

ADR reconciliation decisions are exactly the kind `/start` exists for: hard to reverse (renumbering breaks inbound refs; supersession hides graph claims), surprising without context, and the product of a real trade-off (which of two colliding ADRs renumbers? does the older one get a "partially superseded" note or a full one?). A flat approval list forces all of these at once and invites a rubber-stamp. Walking them one at a time — recommend, wait, re-evaluate — is how shared agreement is actually reached, and it lets one answer reshape the rest of the tree before the next question is asked. The agreements then become a coherent PRD instead of a scattered set of edits.

### Why each finding kind exists (worked examples)

- **Contradiction / missing supersession:** ADR 0034 placed memory under `src/apps`; ADR 0041 moves it out to the `red-memory` repo — 0034 should carry a "partially superseded by 0041" note. The interview asks: full or partial supersession, and worded how? → PRD item to rewrite 0034's Status + Related.
- **Stale reference:** an ADR whose body says `src/domains/{dev,memory}` after the tree became `src/apps/` is out of date even though the *decision* still stands — the interview asks whether to fix the prose (yes) without touching the decision → PRD item.
- **Numbering collision:** two PRs each grabbed "next = 0039" (one merged as `plugin-entrypoints-share-one-source`; a second authored locally had to renumber to 0041). The interview asks which file renumbers and confirms the inbound-ref fixups → PRD item.
- **Structural / controversial:** a decision recorded under unresolved disagreement, or one whose implementation never landed — the interview confirms whether it's still the intent; if it needs real engineering to reconcile, it becomes the load-bearing slice of the PRD.

### Composition map

| Pass | Reuses |
|---|---|
| 1 Lint | filesystem reads against `origin/HEAD` + `start/ADR-FORMAT.md` conventions; Memory contradiction reads when graph mode is on |
| 2 Reconcile | `/start` interview discipline (one `Q##` per turn, branches + recommend) |
| 3 Group | Memory graph communities (optional) for clustering |
| 4 Propagate | `/wiki lint` + `/wiki ingest`; `memory_supersede` / Memory provenance reads |
| 5 Emit PRD | `/to-prd` (format, labels, Human Decisions capture) → later `/to-issues` + `/afk` |

### Boundaries

- The skill **reaches agreement, then packages** — it never silently rewrites a decision, the wiki, or the graph, and never applies an ADR edit directly. Execution is a separate, scheduled step driven by the PRD.
- Pairs with `/doctor` (adoption/process) and `memory:doctor` (graph health) — three doctors over different axes; this one owns **the decision record**, resolves through dialogue, and turns its debt into work.

</supporting-info>
